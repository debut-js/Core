import { promise, orders, math } from '@debut/plugin-utils';
import { BaseTransport, TickHandler, Instrument, OrderOptions, ExecutedOrder, Candle } from '@debut/types';

type TesterTransportOptions = {
    comission?: number;
    ohlc?: boolean;
    broker?: string;
    ticker?: string;
};

export class TesterTransport implements BaseTransport {
    public done: Promise<boolean>;
    private ticks: Candle[] = [];
    private handlers: TickHandler[] = [];
    public opts: TesterTransportOptions = {};
    public complete: Promise<void>;
    private precision: number;
    private resolve: () => void;
    private fee: number;

    constructor(opts: TesterTransportOptions = {}) {
        this.opts = opts;
        this.reset();
        this.fee = this.opts.comission / 100 || 0.0003;
    }

    public async getInstrument() {
        if (!this.ticks) {
            throw new Error('transport is not ready, set ticks before bot.start() call');
        }

        if (!this.precision) {
            // Берем 20 тиков чтобы отбросить значения где в конце 0 не пишется и ошибочно не сократить точность
            this.ticks.slice(-20).forEach((tick) => {
                const len = `${String(tick.c).split('.').pop()}`.length;

                if (len > this.precision) {
                    this.precision = len;
                }
            });
        }

        // Создадим число вида 0.00000001 (минимальное число для текущей точности)
        // Оно будет 1 пунктом, те минимальным шагом цены
        const pipSize = Number(`${parseFloat('0').toFixed(this.precision - 1)}1`);

        return {
            figi: 'test',
            ticker: this.opts.ticker,
            pipSize,
            lotPrecision: 10,
            lot: 1,
            currency: 'USD',
        } as Instrument;
    }

    public setTicks(ticks: Candle[]) {
        this.ticks = ticks.slice();
        this.precision = 0;

        if (this.opts.ohlc) {
            this.ticks = this.ticks.reduce((acc, tick) => {
                const o = { c: tick.o, o: tick.o, h: tick.o, l: tick.o, time: tick.time };
                const h = { c: tick.h, o: tick.o, h: tick.h, l: tick.o, time: tick.time };
                const l = { c: tick.l, o: tick.o, h: tick.h, l: tick.l, time: tick.time };

                if (tick.o <= tick.c) {
                    return acc.concat(o, l, h, tick);
                }

                return acc.concat(o, h, l, tick);
            }, []);

            console.log('OHLC Ticks is enabled, total ticks:', this.ticks.length);
        }
    }

    public async run(waitFor?: boolean): Promise<void> {
        if (waitFor) {
            const prev = this.handlers.length;
            await promise.sleep(1000);
            if (prev !== this.handlers.length) {
                return this.run(waitFor);
            }
        }

        return this.tickLoop();
    }

    public reset() {
        this.handlers.length = 0;

        // Установим новый ресолвер
        this.complete = new Promise((resolve) => {
            this.resolve = resolve;
        });
    }

    public subscribeToTick(ticker: string, handler: TickHandler) {
        this.handlers.push(handler);

        return Promise.resolve(() => {
            const idx = this.handlers.indexOf(handler);

            if (idx !== -1) {
                this.handlers.splice(idx, 1);
            }
        });
    }

    async tickLoop() {
        let tickIdx = 0;
        let tick = this.ticks[0];

        while (tick) {
            let handler = this.handlers[0];
            let handlerIdx = 0;

            while (handler) {
                await handler(tick);
                handler = this.handlers[++handlerIdx];
            }

            tick = this.ticks[++tickIdx];
        }

        this.resolve();
    }

    public async placeOrder(order: OrderOptions): Promise<ExecutedOrder> {
        const feeAmount = order.price * order.lots * this.fee;
        const commission = { value: feeAmount, currency: 'USD' };
        const executed: ExecutedOrder = {
            ...order,
            orderId: orders.syntheticOrderId(order),
            executedLots: order.lots,
            commission,
        };

        return executed;
    }

    public placeSandboxOrder(order: OrderOptions) {
        return this.placeOrder(order);
    }

    public async getUsdBalance() {
        return Infinity;
    }

    public prepareLots(lots: number) {
        switch (this.opts.broker) {
            case 'binance':
                return math.toFixed(lots, 6);
            case 'tinkoff':
            default:
                return Math.floor(lots) || 1;
        }
    }
}
