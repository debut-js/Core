import { date, debug, math, orders, promise } from '@debut/plugin-utils';
import {
    BaseTransport,
    Candle,
    DebutOptions,
    DepthHandler,
    ExecutedOrder,
    Instrument,
    OrderType,
    PendingOrder,
    TickHandler,
    TimeFrame,
} from '@debut/types';
import Alpaca from '@alpacahq/alpaca-trade-api';
import { AlpacaBar, AlpacaQuote } from '@alpacahq/alpaca-trade-api/dist/resources/datav2/entityv2';
import { DebutError, ErrorEnvironment } from '../modules/error';
import { placeSandboxOrder } from './utils/utils';

export type AlpacaTransportArgs = {
    atoken: string;
    asecret: string;
};

export function convertTimeFrame(timeframe: TimeFrame) {
    switch (timeframe) {
        case '1min':
            return '1Min';
        case '5min':
            return '5Min';
        case '15min':
            return '15Min';
        case '30min':
            return '30Min';
        case '15min':
            return '15Min';
        case '1h':
            return '1Hour';
        case '4h':
            return '4Hour';
        case 'day':
            return '1Day';
    }

    throw new DebutError(ErrorEnvironment.Transport, `Alpaca integration does not support ${timeframe} timeframe`);
}

export function isNotSupportedTimeframe(timeframe: TimeFrame) {
    try {
        return !convertTimeFrame(timeframe);
    } catch (e) {
        return true;
    }
}

const goodStatus = ['new', 'pending_new', 'accepted', 'partially_filled', 'filled'];

export function transformAlpacaCandle(bar: AlpacaBar): Candle {
    const time = Date.parse(bar.Timestamp);

    return {
        o: bar.OpenPrice,
        h: bar.HighPrice,
        l: bar.LowPrice,
        c: bar.ClosePrice,
        v: bar.Volume,
        time,
    };
}

export class AlpacaTransport implements BaseTransport {
    protected api: Alpaca;
    private instruments: Map<string, Instrument> = new Map();
    private setAuthenticated: (value: unknown) => void;
    private authentificated = new Promise((resolve) => {
        this.setAuthenticated = resolve;
    });

    constructor(key: string, secret: string) {
        if (!key || !secret) {
            throw new DebutError(ErrorEnvironment.Transport, 'key or secret are incorrect');
        }

        this.api = new Alpaca({
            keyId: key,
            secretKey: secret,
            feed: 'iex', // or "sip" depending on your subscription
            paper: true, // for tests
        });

        this.api.data_stream_v2.connect();
        this.api.data_stream_v2.onConnect(() => {
            this.api.data_stream_v2.onError((error) => {
                // console.warn('stocks', error);

                // Delayed reconnect
                setTimeout(() => {
                    this.api.data_stream_v2.connect();
                }, 1_000);
            });
            this.api.crypto_stream_v1beta3.onError((error) => console.warn('crypto', error));
            this.setAuthenticated(true);
        });
    }

    public async getInstrument(opts: DebutOptions) {
        const { ticker } = opts;
        const instrumentId = this.getInstrumentId(opts);

        if (this.instruments.has(instrumentId)) {
            return this.instruments.get(instrumentId);
        }

        await this.authentificated;

        const res = await this.api.getAsset(ticker);
        const minQuantity = 0.01;
        const lotPrecision = math.getPrecision(minQuantity);
        const instrument: Instrument = {
            figi: res.id,
            ticker: res.symbol,
            lot: 1,
            minNotional: 1,
            minQuantity,
            lotPrecision,
            type: 'SPOT',
            id: instrumentId,
        };

        this.instruments.set(instrumentId, instrument);

        return instrument;
    }

    public async subscribeToTick(opts: DebutOptions, handler: TickHandler) {
        try {
            await this.authentificated;

            const { interval, ticker } = opts;
            const intervalTime = date.intervalToMs(interval);
            let startTime: number = ~~(Date.now() / intervalTime) * intervalTime;
            let endTime: number = startTime + intervalTime;
            let candle: Candle = { o: 0, h: -Infinity, l: Infinity, c: 0, v: 0, time: startTime };

            const listener = (update: AlpacaBar | AlpacaQuote) => {
                if (update.Symbol !== opts.ticker) {
                    return;
                }

                if ('Volume' in update) {
                    // When Bar
                    candle = transformAlpacaCandle(update);
                    handler({ ...candle });
                    startTime = candle.time + intervalTime;
                    endTime = startTime + intervalTime;
                } else {
                    // When quote
                    const time = Date.parse(update.Timestamp);

                    if (time < endTime && candle.c !== update.BidPrice) {
                        if (!candle.o) {
                            candle.o = update.BidPrice;
                        }

                        candle = {
                            ...candle,
                            time: startTime,
                            h: Math.max(candle.h, update.BidPrice),
                            l: Math.min(candle.l, update.BidPrice),
                            c: update.BidPrice,
                            v: candle.v + update.BidSize + update.AskSize,
                        };

                        handler({ ...candle });
                    }
                }
            };

            this.api.data_stream_v2.subscribeForBars([ticker]);
            this.api.data_stream_v2.subscribeForQuotes([ticker]);

            this.api.data_stream_v2.onStockBar(listener);
            this.api.data_stream_v2.onStockQuote(listener);

            return () => {
                this.instruments.delete(this.getInstrumentId(opts));
                this.api.data_stream_v2.unsubscribeFromBars([ticker]);
                this.api.data_stream_v2.unsubscribeFromQuotes([ticker]);
                this.api.data_stream_v2.removeListener('bar', listener);
                this.api.data_stream_v2.removeListener('quote', listener);
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
        const { type, lots, sandbox, learning } = order;
        const instrument = await this.getInstrument(opts);
        const feeAmount = order.price * order.lots * (opts.fee / 100);
        const commission = { value: feeAmount, currency: 'USD' };
        const { id, ticker } = instrument;

        order.retries = order.retries || 0;

        if (sandbox || learning) {
            return placeSandboxOrder(order, opts);
        }

        try {
            let res: Record<string, any>;

            if (order.close) {
                // @ts-expect-error
                res = await this.api.closePosition(ticker, { qty: order.lots });
            } else {
                res = await this.api.createOrder({
                    symbol: ticker,
                    side: type === OrderType.BUY ? 'buy' : 'sell',
                    type: 'market',
                    qty: lots,
                    time_in_force: 'day',
                    order_id: order.cid,
                });
            }

            if (!goodStatus.includes(res.status)) {
                throw new DebutError(ErrorEnvironment.Transport, res.status);
            }

            let filled = await this.api.getOrder(res.id);

            if (!goodStatus.includes(filled.status)) {
                throw new DebutError(ErrorEnvironment.Transport, res.status);
            }

            let attempts = 0;

            while (filled.status !== 'filled') {
                filled = await this.api.getOrder(res.id);
                attempts++;

                if (!goodStatus.includes(filled.status)) {
                    throw new DebutError(ErrorEnvironment.Transport, res.status);
                }

                if (attempts > 3) {
                    await this.api.cancelOrder(res.id);
                    filled = await this.api.getOrder(res.id);
                    break;
                }
            }

            if (Number(filled.filled_qty) === 0) {
                throw new DebutError(ErrorEnvironment.Transport, 'Order cannot be executed');
            }

            if (order.retries > 0) {
                debug.logDebug(' retry success');
            }

            const executed: ExecutedOrder = {
                ...order,
                commission,
                executedLots: filled.filled_qty || order.lots,
                lots: filled.filled_qty || order.lots,
                orderId: `${res.id}`,
                price: filled.filled_avg_price || order.price,
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

                if (this.instruments.has(id)) {
                    return this.placeOrder(order, opts);
                }
            }

            debug.logDebug(' retry failure with order', order);
            throw new DebutError(ErrorEnvironment.Transport, e.message);
        }
    }

    public prepareLots(lots: number, instrumentId: string) {
        const instrument = this.instruments.get(instrumentId);

        if (!instrument) {
            throw new DebutError(ErrorEnvironment.Transport, `Unknown instument id ${instrumentId}`);
        }

        const isInteger = instrument.lotPrecision === 0;
        let resultLots = isInteger ? Math.round(lots) : math.toFixed(lots, instrument.lotPrecision);
        const lotsRedunantValue = isInteger ? 1 : orders.getMinIncrementValue(instrument.minQuantity);

        if (Math.abs(resultLots - lots) > lotsRedunantValue) {
            const rev = resultLots < lots ? 1 : -1;

            // Issue with rounding
            // Reduce lots when rounding is more than source amount and incrase when it less than non rounded lots
            while (Math.abs(resultLots - lots) >= lotsRedunantValue) {
                resultLots = math.toFixed(resultLots + lotsRedunantValue * rev, instrument.lotPrecision);
            }
        }

        if (resultLots === 0) {
            resultLots = lotsRedunantValue;
        }

        return resultLots;
    }

    private getInstrumentId(opts: DebutOptions) {
        return `${opts.ticker}:${opts.instrumentType}`;
    }
}
