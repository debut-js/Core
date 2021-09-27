import { cli, date, debug, math, orders, promise } from '@debut/plugin-utils';
import {
    BaseTransport,
    Candle,
    DepthHandler,
    ExecutedOrder,
    Instrument,
    OrderType,
    PendingOrder,
    TickHandler,
    TimeFrame,
} from '@debut/types';
import { Bar, AlpacaClient, AlpacaStream } from '@master-chief/alpaca';
import { RawBar, RawQuote } from '@master-chief/alpaca/@types/entities';
import { DebutOptions } from '@debut/types';
import { DebutError, ErrorEnvironment } from '../modules/error';

export type AlpacaTransportArgs = {
    atoken: string;
    asecret: string;
};

export function convertTimeFrame(timeframe: TimeFrame) {
    switch (timeframe) {
        case '1min':
            return '1Min';
        case '1h':
            return '1Hour';
        case 'day':
            return '1Day';
    }

    throw `Alpaca integration does not support ${timeframe} timeframe`;
}

export function isNotSupportedTimeframe(timeframe: TimeFrame) {
    try {
        return !convertTimeFrame(timeframe);
    } catch (e) {
        return true;
    }
}

const goodStatus = ['new', 'accepted'];

export function transformAlpacaCandle(bar: Bar | RawBar): Candle {
    const rawBar = 'raw' in bar ? bar.raw() : bar;
    const time = Date.parse(rawBar.t);

    return {
        o: rawBar.o,
        h: rawBar.h,
        l: rawBar.l,
        c: rawBar.c,
        v: rawBar.v,
        time,
    };
}

export class AlpacaTransport implements BaseTransport {
    protected api: AlpacaClient;
    protected stream: AlpacaStream;
    private instruments: Map<string, Instrument> = new Map();

    constructor() {
        const tokens = cli.getTokens();
        const { atoken = 'alpacaKey', asecret = 'alpacaSecret' } = cli.getArgs<AlpacaTransportArgs>();
        const key = tokens[atoken];
        const secret = tokens[asecret];
        this.api = new AlpacaClient({ credentials: { key, secret } });
        this.stream = new AlpacaStream({
            credentials: {
                key: key,
                secret: secret,
            },
            type: 'market_data', // or "account"
            source: 'iex', // or "sip" depending on your subscription
        });

        this.stream.once('authenticated', () => {
            this.stream.on('error', (error) => console.warn(error));
        });
    }

    public async getInstrument(opts: DebutOptions) {
        const { ticker } = opts;
        const instrumentId = this.getInstrumentId(opts);
        if (this.instruments.has(instrumentId)) {
            return this.instruments.get(instrumentId);
        }

        const res = await this.api.getAsset({ asset_id_or_symbol: ticker });
        const { dailyBar, latestQuote, prevDailyBar } = await this.api.getSnapshot({ symbol: ticker });
        // known prices for pip size detection
        const prices = [
            latestQuote?.bp,
            dailyBar?.c,
            dailyBar?.o,
            dailyBar?.h,
            dailyBar?.l,
            prevDailyBar?.o,
            prevDailyBar?.h,
            prevDailyBar?.l,
            prevDailyBar?.c,
        ].filter((item) => Boolean(item) && parseInt(`${item}`) !== item);

        const pipSize = prices.reduce((pipSize, price) => {
            return Math.min(pipSize, orders.getMinIncrementValue(price));
        }, Infinity);

        const instrument: Instrument = {
            figi: res.id,
            ticker: res.symbol,
            lot: 1, // lot is 1 always
            pipSize,
            lotPrecision: 1, // support only integer lots format
            type: 'SPOT',
            id: instrumentId,
        };

        this.instruments.set(instrumentId, instrument);

        return instrument;
    }

    public async subscribeToTick(opts: DebutOptions, handler: TickHandler) {
        try {
            const { interval, ticker } = opts;
            const intervalTime = date.intervalToMs(interval);
            let startTime: number = ~~(Date.now() / intervalTime) * intervalTime;
            let endTime: number = startTime + intervalTime;
            let candle: Candle = { o: 0, h: -Infinity, l: Infinity, c: 0, v: 0, time: startTime };

            const listener = (update: RawBar | RawQuote) => {
                if ('v' in update) {
                    candle = transformAlpacaCandle(update);
                    handler({ ...candle });
                    startTime = candle.time + intervalTime;
                    endTime = startTime + intervalTime;
                } else {
                    const time = Date.parse(update.t);

                    if (time < endTime && candle.c !== update.bp) {
                        if (!candle.o) {
                            candle.o = update.bp;
                        }

                        candle = {
                            ...candle,
                            time: startTime,
                            h: Math.max(candle.h, update.bp),
                            l: Math.min(candle.l, update.bp),
                            c: update.bp,
                            v: 0,
                        };

                        handler({ ...candle });
                    }
                }
            };

            this.stream.subscribe('bars', [ticker]);
            this.stream.subscribe('quotes', [ticker]);
            this.stream.addListener('bar', listener);
            this.stream.addListener('quote', listener);

            return () => {
                this.instruments.delete(this.getInstrumentId(opts));
                this.stream.unsubscribe('bars', [ticker]);
                this.stream.unsubscribe('quotes', [ticker]);
                this.stream.removeListener('bar', listener);
                this.stream.removeListener('quote', listener);
            };
        } catch (e) {
            debug.logDebug(e);
        }
    }

    public async subscribeOrderBook(opts: DebutOptions, handler: DepthHandler): Promise<() => void> {
        throw new DebutError(
            ErrorEnvironment.Transport,
            'Alpaca transport does not supported orderbook subscribtion yet!',
        );
    }

    public async placeOrder(order: PendingOrder, opts: DebutOptions): Promise<ExecutedOrder> {
        const { type, lots, sandbox, learning, ticker, currency } = order;
        const instrumentId = this.getInstrumentId(opts);

        order.retries = order.retries || 0;

        if (sandbox || learning) {
            return this.placeSandboxOrder(order);
        }

        try {
            const res = await this.api.placeOrder({
                symbol: ticker,
                side: type === OrderType.BUY ? 'buy' : 'sell',
                type: 'market',
                qty: lots,
                time_in_force: 'fok',
            });

            if (!goodStatus.includes(res.status)) {
                throw res;
            }

            if (order.retries > 0) {
                debug.logDebug(' retry success');
            }

            const executed: ExecutedOrder = {
                ...order,
                executedLots: res.filled_qty || order.lots,
                orderId: `${res.id}`,
                commission: { currency, value: 0 },
                price: res.filled_avg_price || order.price,
            };

            return executed;
        } catch (e) {
            if (order.retries <= 10) {
                debug.logDebug(' error order place \n', e);
                order.retries++;
                // 10 ретраев чтобы точно попасть в период блокировки биржи изза скачков цены на 30 минут
                // тк блокировка длится в среднем 30 минут
                const timeout = Math.floor(
                    math.clamp(Math.pow(3 + Math.random(), order.retries) * 1000, 3000, 300000) + 60000 * Math.random(),
                );
                await promise.sleep(timeout);

                if (this.instruments.has(instrumentId)) {
                    return this.placeOrder(order, opts);
                }
            }

            debug.logDebug(' retry failure with order', order);
            throw e;
        }
    }

    public async placeSandboxOrder(order: PendingOrder): Promise<ExecutedOrder> {
        const feeAmount = order.price * order.lots * 0.0005;
        const commission = { value: feeAmount, currency: order.currency };
        const executed: ExecutedOrder = {
            ...order,
            orderId: orders.syntheticOrderId(order),
            executedLots: order.lots,
            commission,
        };

        return executed;
    }

    public prepareLots(lots: number) {
        return Math.floor(lots) || 1;
    }

    private getInstrumentId(opts: DebutOptions) {
        return `${opts.ticker}:${opts.instrumentType}`;
    }
}
