import { debug, math, orders, promise } from '@debut/plugin-utils';
import {
    DepthOrder,
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
import {
    CandleInterval,
    HistoricCandle,
    MarketDataRequest,
    SubscriptionAction,
    SubscriptionInterval,
} from 'tinkoff-sdk-grpc-js/dist/generated/marketdata';
import { createSdk } from 'tinkoff-sdk-grpc-js';
import { DebutError, ErrorEnvironment } from '../modules/error';
import { Transaction } from './utils/transaction';
import { placeSandboxOrder } from './utils/utils';

const badStatus = ['Decline', 'Cancelled', 'Rejected', 'PendingCancel'];

type TinkoffTransportArgs = { token: string; proxyPort: number | string };

/**
 * Хелперы.
 * See: https://tinkoff.github.io/investAPI/faq_custom_types/
 */

import ms, { StringValue } from 'ms';
import { DeepPartial, MoneyValue, Quotation } from 'tinkoff-sdk-grpc-js/dist/generated/common';
import { InstrumentIdType } from 'tinkoff-sdk-grpc-js/dist/generated/instruments';
export class Helpers {
    static toQuotation(value: number): Quotation {
        const units = Math.floor(value);
        const nano = (value - units) * 1000000000;
        return { units, nano };
    }

    static toMoney(value: number, currency: string): MoneyValue {
        const { units, nano } = Helpers.toQuotation(value);
        return { units, nano, currency };
    }

    static toNumber(value: Quotation | MoneyValue | undefined) {
        return value ? value.units + value.nano / 1000000000 : value;
    }

    /**
     * Возвращает интервал времени в формате { from, to }.
     * Для смещения используется формат из https://github.com/vercel/ms
     */
    static fromTo(offset: string, base = new Date()) {
        // Не использую StringValue, т.к. с ним больше мороки: нужно импортить при использовании итд.
        const offsetMs = ms(offset as StringValue);
        const date = new Date(base.valueOf() + offsetMs);
        const [from, to] = offsetMs > 0 ? [base, date] : [date, base];
        return { from, to };
    }
}

export function transformTinkoffCandle(candle: HistoricCandle): Candle {
    return {
        o: Helpers.toNumber(candle.open),
        h: Helpers.toNumber(candle.high),
        l: Helpers.toNumber(candle.low),
        c: Helpers.toNumber(candle.close),
        time: candle.time.getTime(),
        v: candle.volume,
    };
}

export function convertTimeFrame(interval: TimeFrame): CandleInterval {
    switch (interval) {
        case '1min':
            return CandleInterval.CANDLE_INTERVAL_1_MIN;
        case '5min':
            return CandleInterval.CANDLE_INTERVAL_5_MIN;
        case '15min':
            return CandleInterval.CANDLE_INTERVAL_15_MIN;
        case '1h':
            return CandleInterval.CANDLE_INTERVAL_HOUR;
        case 'day':
            return CandleInterval.CANDLE_INTERVAL_DAY;
    }

    throw new DebutError(ErrorEnvironment.Transport, 'Unsupported interval');
}
export class TinkoffTransport implements BaseTransport {
    protected api: ReturnType<typeof createSdk>;
    private instruments: Map<string, Instrument> = new Map();

    constructor(token: string) {
        if (!token) {
            throw new DebutError(ErrorEnvironment.Transport, 'token is incorrect');
        }

        this.api = createSdk(token, 'debut');
    }

    public async getInstrument(opts: DebutOptions) {
        const { ticker } = opts;
        const instrumentId = this.getInstrumentId(opts);

        if (this.instruments.has(instrumentId)) {
            return this.instruments.get(instrumentId);
        }

        const res = await this.api.instruments.getInstrumentBy({
            id: ticker,
            classCode: 'SPBXM',
            idType: InstrumentIdType.INSTRUMENT_ID_TYPE_TICKER,
        });

        const instrument: Instrument = {
            figi: res.instrument.figi,
            ticker: res.instrument.ticker,
            lot: res.instrument.lot,
            minQuantity: res.instrument.lot,
            minNotional: 0,
            lotPrecision: 1, // Tinkoff support only integer lots format
            id: instrumentId,
            type: 'SPOT', // Other types does not supported yet
        };

        this.instruments.set(instrumentId, instrument);

        return instrument;
    }

    public async subscribeToTick(opts: DebutOptions, handler: TickHandler) {
        try {
            const { interval } = opts;
            const { figi } = await this.getInstrument(opts);
            const unsubscribe = this.api.candle({ figi, interval: convertTimeFrame(interval) }, (tick) => {
                handler(transformTinkoffCandle(tick));
            });

            return () => {
                this.instruments.delete(this.getInstrumentId(opts));
                unsubscribe();
            };
        } catch (e) {
            debug.logDebug(e);
        }
    }

    public async subscribeOrderBook(opts: DebutOptions, handler: DepthHandler) {
        const instrument = await this.getInstrument(opts as DebutOptions);
        const unsubscribe = this.api.orderbook({ figi: instrument.figi }, this.depthAdapter(handler));

        return () => {
            unsubscribe();
        };
    }

    public async placeOrder(order: PendingOrder, opts: DebutOptions): Promise<ExecutedOrder> {
        const { type, lots, sandbox, learning } = order;

        order.retries = order.retries || 0;

        if (sandbox || learning) {
            return placeSandboxOrder(order, opts);
        }

        const instrument = await this.getInstrument(opts);
        const { figi, id } = instrument;

        try {
            const operation = type === OrderType.BUY ? 'Buy' : 'Sell';
            const res = await this.api.marketOrder({ figi, lots, operation });
            if (res.rejectReason || res.message || badStatus.includes(res.status)) {
                throw res;
            }

            if (order.retries > 0) {
                debug.logDebug(' retry success');
            }

            const executedOrder: ExecutedOrder = {
                ...order,
                orderId: res.orderId,
                executedLots: res.executedLots,
                lots: res.executedLots,
                commission: res.commission,
            };

            // TODO: prices hack does not working yet!
            // const prices = await this.updateOrderPrices(order);

            // order = { ...order, ...prices };
            // order.time = tickTime;

            return executedOrder;
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
            throw new DebutError(ErrorEnvironment.Transport, e.payload?.message || e.message);
        }
    }

    public prepareLots(lots: number) {
        return Math.round(lots) || 1;
    }

    private getInstrumentId(opts: DebutOptions) {
        return `${opts.ticker}:${opts.instrumentType}`;
    }

    private depthAdapter(handler: DepthHandler) {
        return (depth: OrderbookStreaming) => {
            const bids: DepthOrder[] = depth.bids.map((item) => ({
                price: item[0],
                qty: item[1],
            }));

            const asks: DepthOrder[] = depth.asks.map((item) => ({
                price: item[0],
                qty: item[1],
            }));

            handler({ bids, asks });
        };
    }

    private async *createSubscriptionCandleRequest(
        figi: string,
        interval: TimeFrame,
    ): AsyncIterable<DeepPartial<MarketDataRequest>> {
        let stop = false;
        yield MarketDataRequest.fromPartial({
            subscribeCandlesRequest: {
                subscriptionAction: SubscriptionAction.SUBSCRIPTION_ACTION_SUBSCRIBE,
                instruments: [{ figi, interval: SubscriptionInterval.SUBSCRIPTION_INTERVAL_UNSPECIFIED }],
            },
        });
    }

    // @deprecated
    // private async updateOrderPrices(order: Partial<ExecutedOrder>): Promise<Partial<ExecutedOrder>> {
    //     try {
    //         const orders = await this.api.orders();
    //         const updatedOrder = orders.find((target) => target.orderId === order.orderId);

    //         if (updatedOrder) {
    //             logDebug('order from orders()', updatedOrder);
    //             return {
    //                 executedLots: order.lots,
    //                 price: updatedOrder.price,
    //             };
    //         }
    //     } catch (e) {
    //         logDebug('Ошибка получения информации через orders()', e);
    //     }

    //     if (order.close) {
    //         return order;
    //     }

    //     // Подождем 30 секунд, чтобы сделка точно успела исполниться
    //     await sleep(30_000);

    //     // План Б создадим информацию об ордере вручную через баланс
    //     try {
    //         const { positions = [] } = await this.api.portfolio();
    //         const asset = positions.find((item) => item.figi === order.figi);

    //         if (!asset) {
    //             throw 'Позиция не найдена на балансе';
    //         }

    //         logDebug('asset from portfolio()', asset);

    //         const price = asset.averagePositionPrice?.value || asset.averagePositionPriceNoNkd?.value || order.price;

    //         return {
    //             executedLots: order.lots,
    //             price,
    //         };
    //     } catch (e) {
    //         logDebug('Ошибка получения информации через portfolio()', e);
    //     }

    //     return order;
    // }

    // private handlerAdapter(handler: TickHandler) {
    //     return (tick: CandleStreaming) => {
    //         handler({
    //             o: tick.o,
    //             h: tick.h,
    //             l: tick.l,
    //             c: tick.c,
    //             v: tick.v,
    //             time: tick.time,
    //         });
    //     };
    // }
}
