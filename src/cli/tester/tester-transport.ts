import { promise, math } from '@debut/plugin-utils';
import {
    BaseTransport,
    TickHandler,
    Instrument,
    ExecutedOrder,
    Candle,
    DebutOptions,
    DepthHandler,
    PendingOrder,
} from '@debut/types';
import { generateOHLC } from './history';
import { placeSandboxOrder } from '../../transports/utils/utils';

type TesterTransportOptions = {
    ticker: string;
    ohlc?: boolean;
    broker?: string;
};

export class TesterTransport implements BaseTransport {
    public done: Promise<boolean>;
    private handlers: TickHandler[] = [];
    public opts: TesterTransportOptions;
    public complete: Promise<void>;
    private resolve: () => void;
    private ticks: Array<Candle> = [];

    constructor(opts: TesterTransportOptions) {
        this.opts = opts;
        this.reset();
    }

    public async getInstrument(opts: DebutOptions) {
        const instrumentId = this.getInstrumentId(opts);

        if (!this.ticks.length) {
            throw new Error('transport is not ready, set ticks before bot.start() call');
        }

        return {
            figi: 'test',
            ticker: this.opts.ticker,
            lotPrecision: 10,
            lot: 1,
            currency: 'USD',
            id: instrumentId,
            type: opts.instrumentType,
            minNotional: 0,
            minQuantity: 0,
        } as Instrument;
    }

    public setTicks(ticks: Candle[]) {
        ticks = ticks.slice();

        if (this.opts.ohlc) {
            ticks = generateOHLC(ticks);
            console.log('OHLC Ticks is enabled, total ticks:', ticks.length);
        }

        this.ticks = ticks;
    }

    public async run(waitFor?: boolean): Promise<void> {
        if (waitFor) {
            const prev = this.handlers.length;
            await promise.sleep(1000);

            if (prev !== this.handlers.length) {
                return this.run(waitFor);
            }
        }

        await this.tickLoop(this.ticks);
    }

    public reset() {
        this.handlers.length = 0;

        // Установим новый ресолвер
        this.complete = new Promise((resolve) => {
            this.resolve = resolve;
        });
    }

    public subscribeToTick(opts: DebutOptions, handler: TickHandler) {
        this.handlers.push(handler);

        return Promise.resolve(() => {
            const idx = this.handlers.indexOf(handler);

            if (idx !== -1) {
                this.handlers.splice(idx, 1);
            }
        });
    }

    public subscribeOrderBook(opts: DebutOptions, handler: DepthHandler) {
        return null;
    }

    public async placeOrder(order: PendingOrder, opts: DebutOptions): Promise<ExecutedOrder> {
        return placeSandboxOrder(order, opts);
    }

    public async getUsdBalance() {
        return Infinity;
    }

    public prepareLots(lots: number) {
        switch (this.opts.broker) {
            case 'binance':
                return math.toFixed(lots, 4);
            case 'tinkoff':
            default:
                return Math.round(lots) || 1;
        }
    }

    private async tickLoop(ticks: Candle[]) {
        let tickIdx = 0;
        let tick = ticks[0];

        while (tick) {
            let handler = this.handlers[0];
            let handlerIdx = 0;

            while (handler) {
                await handler(tick);
                handler = this.handlers[++handlerIdx];
            }

            tick = ticks[++tickIdx];
        }

        this.resolve();
    }

    private getInstrumentId(opts: DebutOptions) {
        return `${opts.ticker}:${opts.instrumentType}`;
    }
}
