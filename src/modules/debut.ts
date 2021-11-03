import { orders } from '@debut/plugin-utils';
import { getHistory } from '../cli/tester/history';
import { PluginDriver } from './plugin-driver';
import {
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
} from '@debut/types';
import { DebutError, ErrorEnvironment } from './error';

export abstract class Debut implements DebutCore {
    public id: string;
    public dispose: () => void;
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
        if (this.onDepth.toString() !== 'async onDepth(e){}') {
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
        await this.pluginDriver.asyncReduce<PluginHook.onStart>(PluginHook.onStart);
        this.instrument = await this.transport.getInstrument(this.opts);
        const unsubscribe = await this.transport.subscribeToTick(this.opts, this.handler);

        this.dispose = async () => {
            await this.closeAll();
            unsubscribe();

            return this.pluginDriver.asyncReduce<PluginHook.onDispose>(PluginHook.onDispose);
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
     */
    public async closeAll() {
        if (!this.orders.length) {
            return;
        }

        const closed: Array<ExecutedOrder> = [];
        // Because close order mutate this.orders array, make shallow immutable for loop
        const orders = [...this.orders];
        const len = orders.length;

        for (let i = 0; i < len; i++) {
            const executedOrder = await this.closeOrder(orders[i]);
            closed.push(executedOrder);
        }

        return closed;
    }

    /**
     * Place market order with type
     */
    public async createOrder(operation: OrderType): Promise<ExecutedOrder> {
        const { c: price, time } = this.currentCandle || {};

        if (!price) {
            throw this.createCoreError(
                'Not enought price data for create order. this.start() should called before order create',
            );
        }

        const { amount, lotsMultiplier, equityLevel, sandbox, currency, interval, broker, margin, instrumentType } =
            this.opts;
        const { ticker, figi, lot: lotSize, pipSize, id } = this.instrument;
        const lotPrice = price * lotSize;
        const lots = this.transport.prepareLots((amount / lotPrice) * lotsMultiplier, id);
        const pendingOrder: PendingOrder = {
            cid: ~~(Math.random() * 1e5),
            broker,
            type: operation,
            ticker,
            figi,
            currency,
            interval,
            author: this.getName(),
            price,
            lots,
            lotSize,
            pipSize,
            close: false,
            sandbox,
            learning: this.learning,
            time,
            margin,
            futures: instrumentType === 'FUTURES',
            instrumentType,
            lotsMultiplier,
            equityLevel,
        };

        try {
            // Skipping opening because the plugin prevent further actions
            const skip = await this.pluginDriver.asyncSkipReduce<PluginHook.onBeforeOpen>(
                PluginHook.onBeforeOpen,
                pendingOrder,
            );

            if (skip) {
                return;
            }

            this.orders.push(pendingOrder);
            this.orderCounter++;

            const order = await this.transport.placeOrder(pendingOrder, this.opts);
            await this.pluginDriver.asyncReduce<PluginHook.onOpen>(PluginHook.onOpen, order);
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
        // Already closing or try close not opened order
        if (closing.processing) {
            return;
        }

        // Order not executed yet, remove immediatly
        if (!('orderId' in closing)) {
            return this.removeOrder(closing);
        }

        const { c: price, time } = this.currentCandle;
        const { currency, interval, broker, margin } = this.opts;
        const { ticker, figi, lot: lotSize, pipSize } = this.instrument;
        const type = orders.inverseType(closing.type);
        const lots = closing.executedLots;
        const pendingOrder: PendingOrder = {
            cid: Date.now(),
            broker,
            type,
            ticker,
            figi,
            currency,
            interval,
            author: this.getName(),
            price,
            lots,
            lotSize,
            pipSize,
            close: true,
            openPrice: closing.price,
            openId: closing.orderId,
            sandbox: closing.sandbox,
            learning: closing.learning,
            futures: closing.futures,
            instrumentType: closing.instrumentType,
            time,
            margin,
        };

        closing.processing = true;

        try {
            // Skip opening because action prevented from plugins
            const skip = await this.pluginDriver.asyncSkipReduce<PluginHook.onBeforeClose>(
                PluginHook.onBeforeClose,
                pendingOrder,
                closing,
            );

            if (skip) {
                closing.processing = false;
                return;
            }

            this.removeOrder(closing);

            const order = await this.transport.placeOrder(pendingOrder, this.opts);

            await this.pluginDriver.asyncReduce<PluginHook.onClose>(PluginHook.onClose, order, closing);
            await this.onOrderClosed(order, closing);

            return order;
        } catch (e) {
            console.warn(new DebutError(ErrorEnvironment.Core, `${new Date().toISOString()} Order not closed, ${e}`));

            const idx = this.orders.indexOf(closing);

            // Restore order in list
            if (idx === -1) {
                this.orders.unshift(closing);
            }
        } finally {
            closing.processing = false;
        }
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

    private handler = async (tick: Candle) => {
        const change = this.currentCandle && this.currentCandle.time !== tick.time;
        const skip = await this.pluginDriver.asyncSkipReduce<PluginHook.onBeforeTick>(PluginHook.onBeforeTick, tick);

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
            await this.pluginDriver.asyncReduce<PluginHook.onCandle>(PluginHook.onCandle, prevTick);
            await this.onCandle(prevTick);
            await this.pluginDriver.asyncReduce<PluginHook.onAfterCandle>(PluginHook.onAfterCandle, prevTick);
            this.updateCandles(tick);
        }

        // Hooks onTick calling later, after candles has been updated
        await this.pluginDriver.asyncReduce<PluginHook.onTick>(PluginHook.onTick, tick);
        await this.onTick(tick);
    };

    /**
     * Handler of orderbook socket events
     */
    private orderbookHandler = async (depth: Depth) => {
        await this.pluginDriver.asyncReduce<PluginHook.onDepth>(PluginHook.onDepth, depth);
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

    protected async onOrderClosed(order: ExecutedOrder, closing: ExecutedOrder): Promise<void> {}
    protected async onOrderOpened(order: ExecutedOrder): Promise<void> {}
    protected async onCandle(candle: Candle): Promise<void> {}
    protected async onTick(tick: Candle): Promise<void> {}
    protected async onDepth(depth: Depth): Promise<void> {}
}
