import { cli, debug, math, orders, promise } from '@debut/plugin-utils';
import {
    BaseTransport,
    Candle,
    ExecutedOrder,
    Instrument,
    OrderOptions,
    OrderType,
    TickHandler,
    TimeFrame,
} from '@debut/types';
import OpenAPI, {
    MoneyAmount,
    Candle as TinkoffCandle,
    CandleStreaming,
    CandleResolution,
} from '@tinkoff/invest-openapi-js-sdk';

const badStatus = ['Decline', 'Cancelled', 'Rejected', 'PendingCancel'];

type TinkoffTransportArgs = { token: string; proxyPort: number | string };

export function transformTinkoffCandle(candle: TinkoffCandle | CandleStreaming): Candle {
    return { o: candle.o, h: candle.h, l: candle.l, c: candle.c, time: Date.parse(candle.time), v: candle.v };
}

export function convertTimeFrame(interval: TimeFrame): CandleResolution {
    switch (interval) {
        case '1min':
            return '1min';
        case '5min':
            return '5min';
        case '15min':
            return '15min';
        case '30min':
            return '30min';
        case '1h':
            return 'hour';
        case 'day':
            return 'day';
    }

    throw new Error('Unsupported interval');
}
export class TinkoffTransport implements BaseTransport {
    protected api: OpenAPI;
    private instruments: Map<string, Instrument> = new Map();

    constructor() {
        let { token = 'tinkoff', proxyPort } = cli.getArgs<TinkoffTransportArgs>();
        const tokens = cli.getTokens();

        proxyPort = proxyPort && Number(proxyPort);
        token = tokens[token];

        if (!token) {
            throw new Error('invalid tinkoff transport start params');
        }

        const apiURL = 'https://api-invest.tinkoff.ru/openapi';
        let socketURL = 'wss://api-invest.tinkoff.ru/openapi/md/v1/md-openapi/ws';

        // Connect to proxy server instead of tinkoff proxy direct connection
        if (proxyPort) {
            socketURL = `ws://localhost:${proxyPort}`;
        }

        this.api = new OpenAPI({ apiURL, socketURL, secretToken: token });
    }

    public async getPrice(ticker: string) {
        const instument = await this.getInstrument(ticker);
        const orderbook = await this.api.orderbookGet({ figi: instument.figi, depth: 1 });
        const price = orderbook.lastPrice || orderbook.closePrice;

        return price;
    }

    public async getInstrument(ticker: string) {
        if (this.instruments.has(ticker)) {
            return this.instruments.get(ticker);
        }

        const res = await this.api.searchOne({ ticker });

        const instrument: Instrument = {
            figi: res.figi,
            ticker: res.ticker,
            lot: res.lot,
            pipSize: res.minPriceIncrement,
            lotPrecision: 1, // Tinkoff support only integer lots format
        };

        this.instruments.set(ticker, instrument);

        return instrument;
    }

    public async subscribeToTick(ticker: string, handler: TickHandler, interval?: TimeFrame) {
        try {
            const { figi } = await this.getInstrument(ticker);
            const unsubscribe = this.api.candle({ figi, interval: convertTimeFrame(interval) }, (tick) => {
                handler(transformTinkoffCandle(tick));
            });

            return () => {
                this.instruments.delete(ticker);
                unsubscribe();
            };
        } catch (e) {
            debug.logDebug(e);
        }
    }

    public async placeOrder(order: OrderOptions): Promise<ExecutedOrder> {
        const { figi, type, lots, sandbox, learning } = order;
        order.retries = 0;

        if (sandbox || learning) {
            return this.placeSandboxOrder(order);
        }

        try {
            const operation = type === OrderType.BUY ? 'Buy' : 'Sell';
            const res = await this.api.marketOrder({ figi, lots, operation });

            if (res.rejectReason || res.message || badStatus.includes(res.status)) {
                throw res;
            }

            if (order.retries > 0) {
                debug.logDebug(' retry success');
            }

            order = { ...res, ...order };
            // TODO: prices hack does not working yet!
            // const prices = await this.updateOrderPrices(order);

            // order = { ...order, ...prices };
            // order.time = tickTime;

            return order as ExecutedOrder;
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

                if (this.instruments.has(order.ticker)) {
                    return this.placeOrder(order);
                }
            }

            debug.logDebug(' retry failure with order', order);
            throw e;
        }
    }

    public async placeSandboxOrder(order: OrderOptions): Promise<ExecutedOrder> {
        const feeAmount = order.price * order.lots * 0.0005;
        const commission: MoneyAmount = { value: feeAmount, currency: 'USD' };
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
