import { debug, math, promise } from '@debut/plugin-utils';
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
import {
    OrderDirection,
    OrderExecutionReportStatus,
    OrderState,
    PostOrderResponse,
    OrderType as TinkoffOrderType,
} from 'tinkoff-invest-api/cjs/generated/orders.js';
import { Status } from 'nice-grpc';
import { DebutError, ErrorEnvironment } from '../modules/error';
import { placeSandboxOrder } from './utils/utils';
import { ErrorCodes } from 'binance-api-node';

const GoodStatuses = [
    OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_NEW,
    OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_FILL,
    OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_PARTIALLYFILL,
];

export class TinkoffTransport implements BaseTransport {
    public api: TinkoffInvestApi;
    protected instruments: Map<string, Instrument> = new Map();

    constructor(token: string, protected accountId: string) {
        if (!token) {
            throw new DebutError(ErrorEnvironment.Transport, 'token is incorrect');
        }

        if (!accountId) {
            throw new DebutError(ErrorEnvironment.Transport, 'accountId is empty');
        }

        this.api = new TinkoffInvestApi({ token, appName: 'debut' });

        // Debug info
        this.api.stream.market.on('error', (error) => console.log('stream error', error));
        this.api.stream.market.on('close', (error) => console.log('stream closed, reason:', error));
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
        const { type, lots, sandbox, learning, cid } = order;
        const clientOrderId = String(cid);
        order.retries = order.retries || 0;

        if (sandbox || learning) {
            return placeSandboxOrder(order, opts);
        }

        const instrument = await this.getInstrument(opts);

        try {
            const direction =
                type === OrderType.BUY ? OrderDirection.ORDER_DIRECTION_BUY : OrderDirection.ORDER_DIRECTION_SELL;

            const res = await this.api.orders.postOrder({
                accountId: this.accountId,
                figi: instrument.figi,
                quantity: lots,
                direction,
                orderType: TinkoffOrderType.ORDER_TYPE_MARKET,
                orderId: clientOrderId,
            });

            if (!GoodStatuses.includes(res.executionReportStatus)) {
                throw new TinkoffApiError('debut.forced.api.tinkoff', Status.UNKNOWN, 'bad status for response');
            }

            return { ...order, ...getOrderImportantFields(res) };
        } catch (e: unknown | DebutError | TinkoffApiError) {
            // todo: support retries (separate fn?)
            debug.logDebug('retry failure with order', order);

            if (e instanceof DebutError) {
                throw e;
            }

            if (e instanceof TinkoffApiError) {
                // 10 ретраев чтобы точно попасть в период блокировки биржи изза скачков цены на 30 минут
                // тк блокировка длится в среднем 30 минут
                if (order.retries <= 10 && allowRetry(e)) {
                    order.retries++;
                    const delayInterval = math.clamp(Math.pow(3 + Math.random(), order.retries) * 1000, 3000, 300000);
                    // Randomize delay
                    const timeout = Math.floor(delayInterval + 60000 * Math.random());

                    await promise.sleep(timeout);

                    debug.logDebug('Retry for order attempt', order);

                    try {
                        const state = await this.api.orders.getOrderState({
                            orderId: clientOrderId,
                            accountId: this.accountId,
                        });

                        if (GoodStatuses.includes(state.executionReportStatus)) {
                            debug.logDebug('Order restored from state:', state);
                            return { ...order, ...getOrderImportantFields(state) };
                        }
                    } catch (statusError: unknown | TinkoffApiError) {}

                    // Проверяем, что подписка все еще актуальна
                    if (this.instruments.has(instrument.id)) {
                        debug.logDebug('Retry after error', e);
                        return this.placeOrder(order, opts);
                    }

                    debug.logDebug('Retry failure', order);

                    throw new DebutError(ErrorEnvironment.Transport, e.message);
                }
            }

            throw new DebutError(ErrorEnvironment.Transport, String(e));
        }
    }

    public async subscribeToTick(opts: DebutOptions, handler: TickHandler) {
        try {
            const { figi } = await this.getInstrument(opts);
            const interval = transformTimeFrameToSubscriptionsInterval(opts.interval);
            const request = { instruments: [{ figi, interval }], waitingClose: false };
            const unsubscribe = await this.api.stream.market.candles(request, (candle) => {
                handler(transformTinkoffCandle(candle));
            });

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
            // See: https://github.com/debut-js/Core/pull/20#discussion_r890268385
            const MAX_DEPTH = 50;
            const request = { instruments: [{ figi, depth: MAX_DEPTH }] };
            const unsubscribe = await this.api.stream.market.orderBook(request, (orderbook) => {
                const bids = orderbook.bids.map(transformTinkoffStreamOrder);
                const asks = orderbook.asks.map(transformTinkoffStreamOrder);

                handler({ bids, asks });
            });

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
    const classCodes = ['SPBXM', 'TQBR', 'SPBXM', 'MTQR',  'SPBHKEX', 'SPBKZ', 'SPBEQRU', 'SPBRU', 'TQPI', 'SPBFUT', 'CETS' ];
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

function allowRetry(e: TinkoffApiError) {
    return e.code === Status.INTERNAL || e.code === Status.UNKNOWN;
}

/**
 * Most valuable field for trading details in order, how much lots are executed, comission and other trade data
 */
function getOrderImportantFields(source: OrderState | PostOrderResponse) {
    let lots = source.lotsRequested;

    if (source.executionReportStatus === OrderExecutionReportStatus.EXECUTION_REPORT_STATUS_FILL) {
        lots = source.lotsExecuted;
    }

    return {
        orderId: source.orderId,
        executedLots: source.lotsExecuted,
        lots,
        price: Helpers.toNumber(source.executedOrderPrice),
        commission: {
            value: Helpers.toNumber(source.initialCommission),
            currency: source.initialCommission.currency,
        },
    };
}
