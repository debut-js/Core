import { orders } from '@debut/plugin-utils';
import { getHistory } from '../cli/tester/history';
import { PluginDriver } from './plugin-driver';
import {
    BaseOrder,
    BaseTransport,
    Candle,
    DebutCore,
    DebutOptions,
    Depth,
    ExecutedOrder,
    Instrument,
    OrderType,
    PendingOrder,
    PluginHook,
    PluginInterface,
    DebutSnapshotData,
} from '@debut/types';
import { DebutError, ErrorEnvironment } from './error';
import { Transaction } from '../transports/utils/transaction';

export abstract class Debut implements DebutCore {
    public id: string;
    public dispose: () => Promise<void>;
    public instrument: Instrument;
    public opts: DebutOptions;
    public orders: Array<ExecutedOrder | PendingOrder> = [];
    public transport: BaseTransport;
    public learning: boolean;
    protected plugins: unknown;
    protected candles: Candle[] = [];
    private pluginDriver: PluginDriver;
    private orderBookSubscribtion: Promise<() => void> | null;
    private orderCounter = 0;
    private transaction: Transaction;
    private marketTick: Candle;

    constructor(transport: BaseTransport, opts: DebutOptions) {
        const defaultOptions: Partial<DebutOptions> = {
            instrumentType: 'SPOT',
            fee: 0.0003,
            lotsMultiplier: 1,
            equityLevel: 1,
        };

        this.transport = transport;
        this.pluginDriver = new PluginDriver(this);
        this.opts = { ...defaultOptions, ...opts };
        this.dispose = () => null;
        this.validateConfig();

        // If method exists
        if (!this.onDepth.toString().match(/(async\ onDepth\(\w+\)\ \{\ \})/)) {
            this.orderBookSubscribtion = this.transport.subscribeOrderBook(this.opts, this.orderbookHandler);
        }
    }

    /**
     * Prev candle hot getter (last closed candle)
     */
    get prevCandle() {
        return this.candles[1];
    }

    /**
     * Current candle hot getter (current candle is on right now, and not closed yet)
     */
    get currentCandle() {
        return this.candles[0];
    }

    /**
     * Quick acces to this.orders.length, provide better performance than length
     */
    get ordersCount() {
        return this.orderCounter;
    }

    /**
     * Plugins initialization
     */
    public registerPlugins(plugins: PluginInterface[]) {
        this.pluginDriver.register(plugins);
        this.plugins = this.pluginDriver.getPublicAPI();

        // Detect plugins with onDepth hooks
        if (!this.orderBookSubscribtion) {
            for (let i = 0; i < plugins.length; i++) {
                const plugin = plugins[i];

                if (plugin && 'onDepth' in plugin) {
                    this.orderBookSubscribtion = this.transport.subscribeOrderBook(this.opts, this.orderbookHandler);
                    break;
                }
            }
        }
    }

    /**
     * Start listen ticks for current instrument
     */
    public async start() {
        await this.pluginDriver.asyncReduce(PluginHook.onStart);
        this.instrument = await this.transport.getInstrument(this.opts);
        const unsubscribe = await this.transport.subscribeToTick(this.opts, this.handler);

        this.dispose = async () => {
            await this.closeAll();
            unsubscribe();

            return this.pluginDriver.asyncReduce(PluginHook.onDispose);
        };

        return this.dispose;
    }

    /**
     * Get constructor name, for logs and other cases
     */
    public getName() {
        return this.constructor.name;
    }

    /**
     * Close all current positions
     * @param collapse all orders to single, beta
     */
    public async closeAll(collapse = false) {
        if (!this.orderCounter) {
            return;
        }

        const len = this.orderCounter;
        const orderList = [...this.orders];

        if (!collapse || len === 1) {
            const closed: Array<ExecutedOrder> = [];
            // Because close order mutate this.orders array, make shallow immutable for loop

            for (let i = 0; i < len; i++) {
                closed.push(await this.closeOrder(orderList[i]));
            }

            return closed;
        }

        this.transaction = new Transaction(this.opts, this.transport);

        for (let i = 0; i < len; i++) {
            this.closeOrder(orderList[i]);
        }

        const orders = await this.transaction.execute();

        this.transaction = null;

        return orders;
    }

    /**
     * Place market order with type
     */
    public async createOrder(operation: OrderType): Promise<ExecutedOrder> {
        const { c: price } = this.marketTick;

        if (!price) {
            throw this.createCoreError(
                'Not enought price data for create order. this.start() should called before order create',
            );
        }

        const { amount, lotsMultiplier, sandbox, equityLevel } = this.opts;
        const { lot, id } = this.instrument;
        const lotPrice = price * lot;
        const lots = this.transport.prepareLots(((amount * equityLevel) / lotPrice) * lotsMultiplier, id);
        const pendingOrder = this.createPending(operation, { lots, learning: this.learning, sandbox });
        const skip = this.pluginDriver.skipReduce(PluginHook.onBeforeOpen, pendingOrder);

        if (skip) {
            return;
        }

        try {
            // Skipping opening because the plugin prevent further actions

            this.orders.push(pendingOrder);
            this.orderCounter++;

            const order = await this.transport.placeOrder(pendingOrder, this.opts);
            await this.pluginDriver.asyncReduce(PluginHook.onOpen, order);
            await this.onOrderOpened(order);
            const replaced = this.replacePendingOrder(order);

            // Client order was removed, close current order now
            if (!replaced) {
                await this.closeOrder(order);
            }

            return order;
        } catch (e) {
            console.warn(this.createCoreError(`${new Date().toISOString()} Order not opened ${e.message}`));
            this.removeOrder(pendingOrder);
        }
    }

    /**
     * Close selected order
     */
    public async closeOrder(closing: ExecutedOrder | PendingOrder) {
        const pendingOrder = this.createClosePending(closing);
        const skip = this.pluginDriver.skipReduce(PluginHook.onBeforeClose, pendingOrder, closing);

        // Skip opening because action prevented from plugins
        if (skip) {
            return;
        }

        // Optimistic remove order from list
        this.removeOrder(closing);

        if (this.isExecuted(closing)) {
            let order: ExecutedOrder;

            if (this.transaction && this.transaction.canAppendOrder(pendingOrder)) {
                order = await this.transaction.add(pendingOrder);
            } else {
                order = await this.transport.placeOrder(pendingOrder, this.opts);
            }

            await this.pluginDriver.asyncReduce(PluginHook.onClose, order, closing);
            await this.onOrderClosed(order, closing);

            return order;
        }
    }

    /**
     * Partial close selected order, pass second argument reduce, this is how many percent are closed
     * reduce = 0.25 mean 25% of order will be closed
     */
    public async reduceOrder(closing: ExecutedOrder, reduce: number) {
        const { id } = this.instrument;
        const reducedLots = this.transport.prepareLots(closing.lots * reduce, id);
        const remainingLots = this.transport.prepareLots(closing.lots - reducedLots, id);
        const pendingOrder = this.createClosePending(closing, { lots: reducedLots, reduce });
        const skip = this.pluginDriver.skipReduce(PluginHook.onBeforeClose, pendingOrder, closing);

        // Skip opening because action prevented from plugins
        if (skip) {
            return;
        }

        const changes: Partial<ExecutedOrder> = {
            lots: remainingLots,
            executedLots: remainingLots,
        };

        this.updateOrder(closing, changes);

        let order: ExecutedOrder;

        // TODO: Should support transaction here?
        order = await this.transport.placeOrder(pendingOrder, this.opts);

        await this.pluginDriver.asyncReduce(PluginHook.onClose, order, closing);
        await this.onOrderClosed(order, closing);

        return order;
    }

    /**
     * Submitting historical data to the bot as a pre-start stage
     * In order for the bot to enter the market of these indicators and possibly transactions
     * To make a smooth transition to real deals
     */
    public async learn(days = 7) {
        this.instrument = await this.transport.getInstrument(this.opts);
        this.learning = true;

        const ticks = await getHistory({
            broker: this.opts.broker,
            ticker: this.opts.ticker,
            days,
            interval: this.opts.interval,
            gapDays: 0,
            instrumentType: this.opts.instrumentType,
        });

        while (ticks.length) {
            const tick = ticks.shift();

            await this.handler(tick);
        }

        this.learning = false;
    }

    /**
     * Restore debut from saved snapshot data
     */
    public hydrateSnapshot(snapshot: Partial<DebutSnapshotData>) {
        this.opts = snapshot.opts || this.opts;
        this.orders = snapshot.orders || [];
        this.pluginDriver.hydrateSnapshot(snapshot.pluginsData);
    }

    /**
     * Get snapshot data for savings and next restore if runtime works suspended by critical reasons
     */
    public getSnapshot(): Partial<DebutSnapshotData> {
        if (this.learning) {
            return {};
        }

        const executedOrders: ExecutedOrder[] = this.orders.filter(this.isExecuted);

        return {
            opts: this.opts,
            orders: executedOrders,
            pluginsData: this.pluginDriver.getSnapshot(),
        };
    }

    private handler = async (tick: Candle) => {
        const change = this.marketTick && this.marketTick.time !== tick.time;
        // TODO: skip reduce tick undefined, when filter in meta with session plugin, why?
        const skip = this.pluginDriver.skipReduce(PluginHook.onBeforeTick, tick);

        this.marketTick = tick;

        if (skip) {
            return;
        }

        /**
         * Apply price before tick handling, because onTick may contains closeAll, or opening order
         * that mean order price should be equal to this.currentCandle[0].c for correct working
         */
        if (!change) {
            this.candles[0] = tick;
        } else {
            // If the time has changed and there was a previous tick move forward candles sequence and add new zero market tick
            const prevTick = this.currentCandle;
            await this.pluginDriver.asyncReduce(PluginHook.onCandle, prevTick);
            await this.onCandle(prevTick);
            await this.pluginDriver.asyncReduce(PluginHook.onAfterCandle, prevTick);
            this.updateCandles(tick);
        }

        // Hooks onTick calling later, after candles has been updated
        await this.pluginDriver.asyncReduce(PluginHook.onTick, tick);
        await this.onTick(tick);
    };

    /**
     * Handler of orderbook socket events
     */
    private orderbookHandler = async (depth: Depth) => {
        await this.pluginDriver.asyncReduce(PluginHook.onDepth, depth);
        await this.onDepth(depth);
    };

    /**
     * Candle collection managment
     */
    private updateCandles(candle: Candle) {
        if (this.candles.length === 10) {
            this.candles.pop();

            // Boost performance, exclude if
            this.updateCandles = (candle: Candle) => {
                this.candles.pop();
                this.candles.unshift(candle);
            };
        }

        this.candles.unshift(candle);
    }

    /**
     * Replace pending order to executed by cid
     */
    private replacePendingOrder(order: ExecutedOrder) {
        const idx = this.orders.findIndex((item) => item.cid === order.cid);

        if (idx !== -1) {
            this.orders[idx] = order;
            return true;
        }

        return false;
    }

    private createPending(type: OrderType, details: Partial<PendingOrder> = null): PendingOrder {
        const { c: price, time } = this.marketTick;

        return {
            cid: ~~(Math.random() * 1e5),
            type,
            author: this.getName(),
            price,
            lots: 0,
            time,
            ...details,
        };
    }

    private createClosePending(closing: PendingOrder | ExecutedOrder, details: Partial<PendingOrder> = null) {
        const pendingDetails: Partial<PendingOrder> = {
            lots: closing.lots,
            openPrice: closing.price,
            openId: this.isExecuted(closing) ? closing.orderId : closing.cid,
            sandbox: closing.sandbox,
            learning: closing.learning,
            close: true,
            ...details,
        };

        return this.createPending(orders.inverseType(closing.type), pendingDetails);
    }

    /**
     * Remove pending order by cid
     */
    private removeOrder(order: PendingOrder | ExecutedOrder) {
        const idx = this.orders.findIndex((item) => item.cid === order.cid);

        if (idx !== -1) {
            this.orders.splice(idx, 1);
            this.orderCounter--;
        }

        return void 0;
    }

    /**
     * Update existing order attributes
     */
    private updateOrder(order: PendingOrder | ExecutedOrder, changes: Partial<ExecutedOrder>): void {
        // Mutation update
        Object.assign(order, changes);

        this.pluginDriver.reduce(PluginHook.onOrderUpdated, order, changes);
    }

    /**
     * Error constructor wrapper
     */
    private createCoreError(msg: string) {
        return new DebutError(ErrorEnvironment.Core, msg);
    }

    /**
     * Pre defined rules for config validation
     */
    private validateConfig() {
        if (this.opts.broker !== 'binance' && this.opts.instrumentType === 'FUTURES') {
            throw this.createCoreError('Futures are supported only on "Binance" broker');
        }
    }

    private isExecuted(order: PendingOrder | ExecutedOrder): order is ExecutedOrder {
        return 'orderId' in order;
    }

    protected async onOrderClosed(order: ExecutedOrder, closing: ExecutedOrder): Promise<void> {}
    protected async onOrderOpened(order: ExecutedOrder): Promise<void> {}
    protected async onCandle(candle: Candle): Promise<void> {}
    protected async onTick(tick: Candle): Promise<void> {}
    protected async onDepth(depth: Depth): Promise<void> {}
}
