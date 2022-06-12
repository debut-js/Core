import { debug } from '@debut/plugin-utils';
import {
    BaseTransport,
    Candle,
    DebutOptions,
    DepthHandler,
    DepthOrder,
    ExecutedOrder,
    Instrument,
    OrderType,
    PendingOrder,
    TickHandler,
    TimeFrame,
} from '@debut/types';
import { TinkoffInvestApi, Helpers } from 'tinkoff-invest-api';
import { TinkoffApiError } from 'tinkoff-invest-api/cjs/api-error.js';
import { InstrumentIdType } from 'tinkoff-invest-api/cjs/generated/instruments.js';
import {
    SubscriptionInterval,
    HistoricCandle as TinkoffHistoricCandle,
    Candle as TinkoffStreamCandle,
    Order as TinkoffStreamOrder,
} from 'tinkoff-invest-api/cjs/generated/marketdata.js';
import { OrderDirection, OrderType as TinkoffOrderType } from 'tinkoff-invest-api/cjs/generated/orders.js';
import { Status } from 'nice-grpc';
import { DebutError, ErrorEnvironment } from '../modules/error';
import { placeSandboxOrder } from './utils/utils';

export class TinkoffTransport implements BaseTransport {
    protected api: TinkoffInvestApi;
    protected instruments: Map<string, Instrument> = new Map();

    constructor(token: string, protected accountId: string) {
        if (!token) {
            throw new DebutError(ErrorEnvironment.Transport, 'token is incorrect');
        }

        if (!accountId) {
            throw new DebutError(ErrorEnvironment.Transport, 'accountId is empty');
        }

        this.api = new TinkoffInvestApi({ token, appName: 'debut' });
    }

    public async getInstrument(opts: DebutOptions) {
        const { ticker, instrumentType } = opts;

        if (instrumentType !== 'SPOT') {
            throw new DebutError(
                ErrorEnvironment.Transport,
                `Only SPOT instrumentType supported, got ${instrumentType}`,
            );
        }

        const instrumentId = this.getInstrumentId(opts);

        if (this.instruments.has(instrumentId)) {
            return this.instruments.get(instrumentId);
        }

        const { figi, lot } = await findInstrumentByTicker(this.api, ticker);

        const instrument: Instrument = {
            figi,
            ticker,
            lot,
            minQuantity: lot,
            minNotional: 0,
            lotPrecision: 1, // Tinkoff support only integer lots format
            id: instrumentId,
            type: instrumentType,
        };

        this.instruments.set(instrumentId, instrument);

        return instrument;
    }

    public async placeOrder(order: PendingOrder, opts: DebutOptions): Promise<ExecutedOrder> {
        const { type, lots, sandbox, learning } = order;

        order.retries = order.retries || 0;

        if (sandbox || learning) {
            return placeSandboxOrder(order, opts);
        }

        const { figi } = await this.getInstrument(opts);

        try {
            const direction =
                type === OrderType.BUY ? OrderDirection.ORDER_DIRECTION_BUY : OrderDirection.ORDER_DIRECTION_SELL;

            const res = await this.api.orders.postOrder({
                accountId: this.accountId,
                figi,
                quantity: lots,
                direction,
                orderType: TinkoffOrderType.ORDER_TYPE_MARKET,
                orderId: Math.random().toString(),
            });

            const executedOrder: ExecutedOrder = {
                ...order,
                orderId: res.orderId,
                executedLots: res.lotsExecuted,
                lots: res.lotsRequested,
                commission: {
                    value: Helpers.toNumber(res.initialCommission),
                    currency: res.initialCommission.currency,
                },
            };

            // TODO: prices hack does not working yet!
            // const prices = await this.updateOrderPrices(order);

            // order = { ...order, ...prices };
            // order.time = tickTime;

            return executedOrder;
        } catch (e) {
            // todo: support retries (separate fn?)
            debug.logDebug(' retry failure with order', order);
            throw new DebutError(ErrorEnvironment.Transport, e.payload?.message || e.message);
        }
    }

    public async subscribeToTick(opts: DebutOptions, handler: TickHandler) {
        try {
            const { figi } = await this.getInstrument(opts);
            const interval = transformTimeFrameToSubscriptionsInterval(opts.interval);
            const unsubscribe = this.api.stream.market.on('data', ({ candle }) => {
                if (candle) {
                    handler(transformTinkoffCandle(candle));
                }
            });
            this.api.stream.market.watch({ candles: [{ figi, interval }] });
            return () => {
                this.removeInstrumentFromCache(opts);
                unsubscribe();
            };
        } catch (e) {
            debug.logDebug(e);
        }
    }

    public async subscribeOrderBook(opts: DebutOptions, handler: DepthHandler) {
        try {
            const { figi } = await this.getInstrument(opts);
            const unsubscribe = this.api.stream.market.on('data', ({ orderbook }) => {
                if (orderbook) {
                    const bids = orderbook.bids.map(transformTinkoffStreamOrder);
                    const asks = orderbook.asks.map(transformTinkoffStreamOrder);
                    handler({ bids, asks });
                }
            });
            // See: https://github.com/debut-js/Core/pull/20#discussion_r890268385
            const MAX_DEPTH = 50;
            this.api.stream.market.watch({ orderBook: [{ figi, depth: MAX_DEPTH }] });
            return () => {
                this.removeInstrumentFromCache(opts);
                unsubscribe();
            };
        } catch (e) {
            debug.logDebug(e);
        }
    }

    public prepareLots(lots: number) {
        return Math.round(lots) || 1;
    }

    private getInstrumentId(opts: DebutOptions) {
        return `${opts.ticker}:${opts.instrumentType}`;
    }

    private removeInstrumentFromCache(opts: DebutOptions) {
        this.instruments.delete(this.getInstrumentId(opts));
    }
}

/**
 * Returns instrument info by ticker.
 * See: https://github.com/debut-js/Core/pull/20#discussion_r890240512
 */
export async function findInstrumentByTicker(api: TinkoffInvestApi, ticker: string) {
    const classCodes = ['SPBXM', 'TQBR'];
    for (const classCode of classCodes) {
        try {
            const { instrument } = await api.instruments.getInstrumentBy({
                id: ticker,
                classCode,
                idType: InstrumentIdType.INSTRUMENT_ID_TYPE_TICKER,
            });
            return instrument;
        } catch (e) {
            if (e instanceof TinkoffApiError && e.code === Status.NOT_FOUND) {
                continue;
            } else {
                throw e;
            }
        }
    }

    throw new DebutError(ErrorEnvironment.Transport, `Instrument not found: ${ticker}`);
}

export function transformTinkoffCandle(candle: TinkoffStreamCandle | TinkoffHistoricCandle): Candle {
    return {
        o: Helpers.toNumber(candle.open),
        h: Helpers.toNumber(candle.high),
        l: Helpers.toNumber(candle.low),
        c: Helpers.toNumber(candle.close),
        time: candle.time.getTime(),
        v: candle.volume,
    };
}

function transformTimeFrameToSubscriptionsInterval(interval: TimeFrame): SubscriptionInterval {
    switch (interval) {
        case '1min':
            return SubscriptionInterval.SUBSCRIPTION_INTERVAL_ONE_MINUTE;
        case '5min':
            return SubscriptionInterval.SUBSCRIPTION_INTERVAL_FIVE_MINUTES;
    }

    throw new DebutError(ErrorEnvironment.Transport, 'Unsupported SubscriptionInterval');
}

function transformTinkoffStreamOrder(order: TinkoffStreamOrder): DepthOrder {
    return {
        price: Helpers.toNumber(order.price),
        qty: order.quantity,
    };
}
