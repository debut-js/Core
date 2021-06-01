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
    public dispose: () => void;
    public instrument: Instrument;
    public opts: DebutOptions;
    public orders: ExecutedOrder[] = [];
    public transport: BaseTransport;
    protected plugins: unknown;
    protected candles: Candle[] = [];
    protected prevTick: Candle;
    private marketTick: Candle;
    private pluginDriver: PluginDriver;
    private learning: boolean;

    /**
     * Конструктор
     * @param transport - транспорт для работы с сетью
     * @param opts - настройки
     */
    constructor(transport: BaseTransport, opts: DebutOptions) {
        this.transport = transport;
        this.pluginDriver = new PluginDriver(this);
        this.opts = opts;
    }

    /**
     * Предыдущая свеча
     */
    get prevCandle() {
        return this.candles[1];
    }

    /**
     * Закрытая свеча
     */
    get currentCandle() {
        return this.candles[0];
    }

    /**
     * Регистрация плагинов
     */
    public registerPlugins(plugins: PluginInterface[]) {
        this.pluginDriver.register(plugins);
        this.plugins = this.pluginDriver.getPublicAPI();
        this.pluginDriver.syncReduce<PluginHook.onInit>(PluginHook.onInit);
    }

    /**
     * Бот подписывается на тики по заданному инструменту
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
     * Получение имени бота по конструктору
     */
    public getName() {
        return this.constructor.name;
    }

    /**
     * Закрыть все открытые позиции
     */
    public async closeAll() {
        if (!this.orders.length) {
            return;
        }

        const orders: Array<ExecutedOrder> = [];

        // Because close order mutate this.orders array, make shallow immutable for loop
        while (this.orders.length > 0) {
            const executedOrder = await this.closeOrder(this.orders[0]);

            orders.push(executedOrder);
        }

        return orders;
    }

    /**
     * Создает лимитную заявку и отмечает в логике, что есть активная заявка
     */
    public async createOrder(operation: OrderType): Promise<ExecutedOrder> {
        const { c: price, time } = this.marketTick;
        const { amount, lotsMultiplier = 1, equityLevel = 1, sandbox, currency, interval, broker, margin } = this.opts;
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
                lotsMultiplier,
                equityLevel,
            };

            // Пропуск открытия по причине запрета плагином дальнейших действий
            const skip = await this.pluginDriver.asyncSkipReduce<PluginHook.onBeforeOpen>(
                PluginHook.onBeforeOpen,
                orderOptions,
            );

            if (skip) {
                return;
            }

            const order = await this.transport.placeOrder(orderOptions);

            await this.pluginDriver.asyncReduce<PluginHook.onOpen>(PluginHook.onOpen, order);

            this.orders.push(order);
            await this.onOrderOpened(order);

            return order;
        } catch (e) {
            console.log(new Date().toISOString(), 'Ошибка создания ордера', e);
        }
    }

    /**
     * Закрыть переданную позицию
     */
    public async closeOrder(closing: ExecutedOrder) {
        // Уже закрывается
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

            // Пропуск открытия по причине запрета плагином дальнейших действий
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
     * Подача боту исторических данных в качестве этапа пред старта
     * Для того чтобы бот вошел в рынок имея данные индикаторов и возможно сделки
     * Чтобы совершить плавный переход к реальным сделкам
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
        // Всегза реагируем на тик для определения текущей цены маркет сделок и времени
        // Затем вызваем хуки, чтобы плагины могли закрыть по маркету
        this.marketTick = tick;

        const skip = await this.pluginDriver.asyncSkipReduce<PluginHook.onTick>(PluginHook.onTick, tick);

        if (skip) {
            return;
        }

        // Если сменилось время и был предыдущий тик, запишем последние данные тика в свечу
        if (change && this.prevTick) {
            if (this.candles.length === 10) {
                this.candles.pop();
            }

            this.candles.unshift(this.prevTick);
            await this.pluginDriver.asyncReduce<PluginHook.onCandle>(PluginHook.onCandle, this.prevTick);
            await this.onCandle(this.prevTick);
            await this.pluginDriver.asyncReduce<PluginHook.onAfterCandle>(PluginHook.onAfterCandle, this.prevTick);
        }

        this.prevTick = tick;
        await this.onTick(tick);
    };

    protected async onOrderClosed(order: ExecutedOrder, closing: ExecutedOrder): Promise<void> {}
    protected async onOrderOpened(order: ExecutedOrder): Promise<void> {}
    protected async onCandle(candle: Candle): Promise<void> {}
    protected async onTick(tick: Candle): Promise<void> {}
}
