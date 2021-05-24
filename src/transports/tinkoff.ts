import OpenAPI, { MoneyAmount } from '@tinkoff/invest-openapi-js-sdk';
import { logDebug } from '../utils/debug';
import { sleep } from '../utils/promise';
import { clamp } from '../utils/math';
import { readFile } from '../utils/file';
import { syntheticOrderId } from '../utils/orders';
import { getArgs } from '../utils/cli';
import { convertTimeFrame } from '../cli/tester/history-providers/tinkoff';
import { BaseTransport, Instrument } from '../types/transport';
import { TickHandler, TimeFrame } from '../types/common';
import { ExecutedOrder, OrderOptions, OrderType } from '../types/order';

const badStatus = ['Decline', 'Cancelled', 'Rejected', 'PendingCancel'];

type TinkoffTransportArgs = { token: string; proxyPort: number | string };
export class TinkoffTransport implements BaseTransport {
    protected api: OpenAPI;
    private instruments: Map<string, Instrument> = new Map();

    constructor() {
        let { token, proxyPort } = getArgs<TinkoffTransportArgs>();
        const tokens: Record<string, string> = JSON.parse(readFile(`${process.cwd()}/.tokens.json`));

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
    }

    public async subscribeToTick(ticker: string, handler: TickHandler, interval?: TimeFrame) {
        try {
            const { figi } = await this.getInstrument(ticker);
            const unsubscribe = this.api.candle({ figi, interval: convertTimeFrame(interval) }, (tick) => {
                handler(tick);
            });

            return unsubscribe;
        } catch (e) {
            logDebug(e);
        }
    }

    public async placeOrder(order: OrderOptions): Promise<ExecutedOrder> {
        const { figi, type, lots, sandbox } = order;
        let retry = 0;

        if (sandbox) {
            return this.placeSandboxOrder(order);
        }

        try {
            const operation = type === OrderType.BUY ? 'Buy' : 'Sell';
            const res = await this.api.marketOrder({ figi, lots, operation });

            if (res.rejectReason || res.message || badStatus.includes(res.status)) {
                throw res;
            }

            if (retry) {
                logDebug(' retry success');
            }

            order = { ...res, ...order };
            // TODO: prices hack does not working yet!
            // const prices = await this.updateOrderPrices(order);

            // order = { ...order, ...prices };
            // order.time = tickTime;

            return order as ExecutedOrder;
        } catch (e) {
            if (!retry || retry <= 10) {
                logDebug(' error order place \n', e);
                retry++;
                // 10 ретраев чтобы точно попасть в период блокировки биржи изза скачков цены на 30 минут
                // тк блокировка длится в среднем 30 минут
                const timeout = Math.floor(
                    clamp(Math.pow(3 + Math.random(), retry) * 1000, 3000, 300000) + 60000 * Math.random(),
                );
                await sleep(timeout);

                return this.placeOrder(order);
            }

            logDebug(' retry failure with order', order);
            throw e;
        }
    }

    public async placeSandboxOrder(order: OrderOptions): Promise<ExecutedOrder> {
        const feeAmount = order.price * order.lots * 0.0005;
        const commission: MoneyAmount = { value: feeAmount, currency: 'USD' };
        const executed: ExecutedOrder = {
            ...order,
            orderId: syntheticOrderId(order),
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
