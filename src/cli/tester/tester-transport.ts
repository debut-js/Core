import { math } from '@debut/plugin-utils';
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
    private handlers: Set<TickHandler> = new Set();
    public opts: TesterTransportOptions;
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

    public async run(): Promise<void> {
        await this.tickLoop(this.ticks);
    }

    public reset() {
        this.handlers.clear();
    }

    public subscribeToTick(opts: DebutOptions, handler: TickHandler) {
        this.handlers.add(handler);

        return Promise.resolve(() => {
            this.handlers.delete(handler);
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
            for (const handler of this.handlers) {
                await handler(tick);
            }

            tick = ticks[++tickIdx];
        }
    }

    private getInstrumentId(opts: DebutOptions) {
        return `${opts.ticker}:${opts.instrumentType}`;
    }
}
