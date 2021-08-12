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
    OrderOptions,
    OrderType,
    PluginHook,
    PluginInterface,
} from '@debut/types';

export abstract class Debut implements DebutCore {
    public id: string;
    public dispose: () => void;
    public instrument: Instrument;
    public opts: DebutOptions;
    public orders: ExecutedOrder[] = [];
    public transport: BaseTransport;
    protected plugins: unknown;
    protected candles: Candle[] = [];
    private marketTick: Candle;
    private pluginDriver: PluginDriver;
    private learning: boolean;

    constructor(transport: BaseTransport, opts: DebutOptions) {
        this.transport = transport;
        this.pluginDriver = new PluginDriver(this);
        this.opts = opts;
        this.dispose = () => null;
    }

    /**
     * Prev known candle hot getter
     */
    get prevCandle() {
        return this.candles[1];
    }

    /**
     * Last known closed candle
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

        console.log('close start');
        const orders: Array<ExecutedOrder> = [];

        // Because close order mutate this.orders array, make shallow immutable for loop
        while (this.orders.length > 0) {
            const executedOrder = await this.closeOrder(this.orders[0]);

            orders.push(executedOrder);
        }

        console.log('close end');
        return orders;
    }

    /**
     * Place market order with type
     */
    public async createOrder(operation: OrderType): Promise<ExecutedOrder> {
        console.log('create order start');
        const { c: price, time } = this.marketTick;
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

        try {
            const orderOptions: OrderOptions = {
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

            console.log('create order hook on before open');
            // Skipping opening because the plugin prevent further actions
            const skip = await this.pluginDriver.asyncSkipReduce<PluginHook.onBeforeOpen>(
                PluginHook.onBeforeOpen,
                orderOptions,
            );

            if (skip) {
                return;
            }

            console.log('create order transport start');
            const order = await this.transport.placeOrder(orderOptions);
            console.log('create order transport end');
            console.log('create order hook on open');
            await this.pluginDriver.asyncReduce<PluginHook.onOpen>(PluginHook.onOpen, order);

            console.log('create order add order to list');
            this.orders.push(order);
            await this.onOrderOpened(order);

            return order;
        } catch (e) {
            console.log(new Date().toISOString(), 'Ошибка создания ордера', e);
        }
    }

    /**
     * Close selected order
     */
    public async closeOrder(closing: ExecutedOrder) {
        // Already closing
        if (closing.processing) {
            return;
        }

        const { c: price, time } = this.marketTick;
        const { currency, interval, broker, margin, lotsMultiplier, equityLevel } = this.opts;
        const { ticker, figi, lot: lotSize, pipSize } = this.instrument;

        const type = orders.inverseType(closing.type);
        const lots = this.transport.prepareLots(closing.executedLots * lotSize, ticker);

        closing.processing = true;

        try {
            const closeOrder: OrderOptions = {
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

            // Skip opening because action prevented from plugins
            const skip = await this.pluginDriver.asyncSkipReduce<PluginHook.onBeforeClose>(
                PluginHook.onBeforeClose,
                closeOrder,
                closing,
            );

            if (skip) {
                closing.processing = false;
                return;
            }

            const order = await this.transport.placeOrder(closeOrder);

            const idx = this.orders.indexOf(closing);

            if (idx !== -1) {
                this.orders.splice(idx, 1);
            }

            await this.pluginDriver.asyncReduce<PluginHook.onClose>(PluginHook.onClose, order, closing);
            await this.onOrderClosed(order, closing);

            closing.processing = false;

            return order;
        } catch (e) {
            closing.processing = false;
            console.log(new Date().toISOString(), 'Ошибка закрытия ордера', e);
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
        const change = this.marketTick && this.marketTick.time !== tick.time;
        const skip = await this.pluginDriver.asyncSkipReduce<PluginHook.onTick>(PluginHook.onTick, tick);

        if (skip) {
            return;
        }

        // React to a tick to determine the current price of market deals and time
        // Then we call hooks so that plugins can close by market
        const prevTick = this.marketTick;
        this.marketTick = tick;

        // If the time has changed and there was a previous tick, write the last tick data to the candle
        if (change && prevTick) {
            this.updateCandles(prevTick);

            await this.pluginDriver.asyncReduce<PluginHook.onCandle>(PluginHook.onCandle, prevTick);
            await this.onCandle(prevTick);
            await this.pluginDriver.asyncReduce<PluginHook.onAfterCandle>(PluginHook.onAfterCandle, prevTick);
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

    protected async onOrderClosed(order: ExecutedOrder, closing: ExecutedOrder): Promise<void> {}
    protected async onOrderOpened(order: ExecutedOrder): Promise<void> {}
    protected async onCandle(candle: Candle): Promise<void> {}
    protected async onTick(tick: Candle): Promise<void> {}
}
