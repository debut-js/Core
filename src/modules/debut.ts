import { orders } from '@debut/plugin-utils';
import { getHistory } from '../cli/tester/history';
import { PluginDriver } from './plugin-driver';
import {
    BaseTransport,
    Candle,
    DebutCore,
    DebutOptions,
    ExecutedOrder,
    Instrument,
    OrderType,
    PendingOrder,
    PluginHook,
    PluginInterface,
} from '@debut/types';

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

    constructor(transport: BaseTransport, opts: DebutOptions) {
        this.transport = transport;
        this.pluginDriver = new PluginDriver(this);
        this.opts = opts;
        this.dispose = () => null;
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
     * Plugins initialization
     */
    public registerPlugins(plugins: PluginInterface[]) {
        this.pluginDriver.register(plugins);
        this.plugins = this.pluginDriver.getPublicAPI();
        this.pluginDriver.syncReduce<PluginHook.onInit>(PluginHook.onInit);
    }

    /**
     * Start listen ticks for current instrument
     */
    public async start() {
        await this.pluginDriver.asyncReduce<PluginHook.onStart>(PluginHook.onStart);
        this.instrument = await this.transport.getInstrument(this.opts.ticker);
        const unsubscribe = await this.transport.subscribeToTick(this.opts.ticker, this.handler, this.opts.interval);

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
            const executedOrder = await this.closeOrder(this.orders[0]);
            closed.push(executedOrder);
        }

        return closed;
    }

    /**
     * Place market order with type
     */
    public async createOrder(operation: OrderType): Promise<ExecutedOrder> {
        const { c: price, time } = this.currentCandle;
        const {
            amount,
            lotsMultiplier = 1,
            equityLevel = 1,
            sandbox,
            currency,
            interval,
            broker,
            margin,
            futures,
        } = this.opts;
        const { ticker, figi, lot: lotSize, pipSize } = this.instrument;
        const lotPrice = price * lotSize;
        const lots = this.transport.prepareLots((amount / lotPrice) * lotsMultiplier, ticker);
        const pendingOrder: PendingOrder = {
            cid: Math.random() * 1e17,
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
            futures,
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
            const order = await this.transport.placeOrder(pendingOrder);
            await this.pluginDriver.asyncReduce<PluginHook.onOpen>(PluginHook.onOpen, order);
            await this.onOrderOpened(order);
            this.replacePendingOrder(order);

            return order;
        } catch (e) {
            console.log(new Date().toISOString(), 'Ошибка создания ордера', e);
            this.removePendingOrder(pendingOrder);
        }
    }

    /**
     * Close selected order
     */
    public async closeOrder(closing: ExecutedOrder | PendingOrder) {
        // Already closing or try close not opened order
        // TODO: Fix it with order STATUS enum
        if (closing.processing || !('orderId' in closing)) {
            return;
        }

        const { c: price, time } = this.currentCandle;
        const { currency, interval, broker, margin, lotsMultiplier, equityLevel } = this.opts;
        const { ticker, figi, lot: lotSize, pipSize } = this.instrument;
        const type = orders.inverseType(closing.type);
        const lots = this.transport.prepareLots(closing.executedLots * lotSize, ticker);
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
            time,
            margin,
            lotsMultiplier,
            equityLevel,
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

            const idx = this.orders.indexOf(closing);

            if (idx !== -1) {
                this.orders.splice(idx, 1);
            }

            const order = await this.transport.placeOrder(pendingOrder);

            await this.pluginDriver.asyncReduce<PluginHook.onClose>(PluginHook.onClose, order, closing);
            await this.onOrderClosed(order, closing);

            return order;
        } catch (e) {
            console.log(new Date().toISOString(), 'Ошибка закрытия ордера', e);

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
        this.instrument = await this.transport.getInstrument(this.opts.ticker);
        this.learning = true;
        const ticks = await getHistory({
            broker: this.opts.broker,
            ticker: this.opts.ticker,
            days,
            interval: this.opts.interval,
            gapDays: 0,
        });

        while (ticks.length) {
            const tick = ticks.shift();

            await this.handler(tick);
        }

        this.learning = false;
    }

    private handler = async (tick: Candle) => {
        const change = this.currentCandle && this.currentCandle.time !== tick.time;
        const skip = await this.pluginDriver.asyncSkipReduce<PluginHook.onTick>(PluginHook.onTick, tick);

        if (skip) {
            return;
        }

        if (change) {
            // If the time has changed and there was a previous tick move forward candles sequence and add new zero market tick
            const prevTick = this.currentCandle;
            this.updateCandles(tick);

            await this.pluginDriver.asyncReduce<PluginHook.onCandle>(PluginHook.onCandle, prevTick);
            await this.onCandle(prevTick);
            await this.pluginDriver.asyncReduce<PluginHook.onAfterCandle>(PluginHook.onAfterCandle, prevTick);
        } else {
            this.candles[0] = tick;
        }

        await this.onTick(tick);
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
        } else {
            // TODO: Remove when fine
            console.warn('Unknown order for replace', this.orders, order);
        }
    }

    /**
     * Remove pending order by cid
     */
    private removePendingOrder(order: PendingOrder) {
        const idx = this.orders.findIndex((item) => item.cid === order.cid);

        if (idx !== -1) {
            this.orders.splice(idx, 1);
        }
    }

    protected async onOrderClosed(order: ExecutedOrder, closing: ExecutedOrder): Promise<void> {}
    protected async onOrderOpened(order: ExecutedOrder): Promise<void> {}
    protected async onCandle(candle: Candle): Promise<void> {}
    protected async onTick(tick: Candle): Promise<void> {}
}
