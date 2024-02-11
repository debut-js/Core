import {
    RestClientV5,
    CategoryV5,
    InstrumentInfoResponseV5,
    APIResponseV3WithTime,
    OrderParamsV5,
    OrderResultV5,
    APIResponseV3,
    GetAccountHistoricOrdersParamsV5,
    WebsocketClient,
    DefaultLogger,
    WsTopic,
    CategoryCursorListV5,
    AccountOrderV5,
} from 'bybit-api';
import { debug, math, orders, promise } from '@debut/plugin-utils';
import { DebutError, ErrorEnvironment } from '../modules/error';

import {
    BaseTransport,
    DebutOptions,
    DepthHandler,
    ExecutedOrder,
    Instrument,
    OrderType,
    PendingOrder,
    TickHandler,
    TimeFrame,
} from '@debut/types';
import { placeSandboxOrder } from './utils/utils';

export function convertTimeFrame(interval: TimeFrame) {
    switch (interval) {
        case '1min':
            return '1';
        case '5min':
            return '5';
        case '15min':
            return '15';
        case '30min':
            return '30';
        case '1h':
            return '60';
        case '4h':
            return '240';
    }
    throw new DebutError(ErrorEnvironment.Transport, 'Bybit Unsupported interval');
}

const logger = {
    ...DefaultLogger,
    silly: () => {},
};

export type TickData = {
    type: string;
    topic: string;
    data: [
        {
            start: number;
            end: number;
            interval: string;
            open: string;
            close: string;
            high: string;
            low: string;
            volume: string;
            turnover: string;
            confirm: boolean;
            timestamp: number;
        },
    ];
    ts: number;
    wsKey: string;
};

const ORDER_CATEGORY_SPOT = 'spot';
const ORDER_TYPE_MARKET = 'Market';
const ORDER_SIDE_BUY = 'Buy';
const ORDER_SIDE_SELL = 'Sell';

// Rewrite as code.
// https://bybit-exchange.github.io/docs/v5/error
const ignoredErrorsList = [
    'Order quantity exceeded lower limit',
    'You are not authorized to execute this request',
    'Invalid API-key, IP, or permissions for action',
    'Compliance rules triggered',
];

export class BybitTransport implements BaseTransport {
    public api: RestClientV5;
    public ws: WebsocketClient;
    protected info: APIResponseV3WithTime<InstrumentInfoResponseV5<'spot'>> | undefined;
    protected instruments: Map<string, Instrument> = new Map();

    constructor(apiKey: string, apiSecret: string, testMode: number | string = 0) {
        if (!apiKey || !apiSecret) {
            throw new DebutError(ErrorEnvironment.Transport, 'apiKey or apiSecret are incorrect');
        }

        // Authenticated client, can make signed calls
        this.api = new RestClientV5({
            key: apiKey,
            secret: apiSecret,
            testnet: !!Number(testMode),
        });

        this.ws = new WebsocketClient(
            {
                key: apiKey,
                secret: apiSecret,
                market: 'v5',
                testnet: !!Number(testMode),
            },
            logger,
        );

        this.ws.on('open', (data) => {
            console.log('connection opened open:', data.wsKey);
        });
        this.ws.on('response', (data) => {
            console.log('log response: ', JSON.stringify(data, null, 2));
        });
        this.ws.on('reconnect', ({ wsKey }) => {
            console.log('ws automatically reconnecting.... ', wsKey);
        });
        this.ws.on('reconnected', (data) => {
            console.log('ws has reconnected ', data?.wsKey);
        });
        this.ws.on('error', (data) => {
            console.error('ws exception: ', data);
        });
    }

    public async subscribeToTick(opts: DebutOptions, handler: TickHandler) {
        const wsTopic: WsTopic = `kline.${convertTimeFrame(opts.interval)}.${opts.ticker}`;
        this.ws.subscribeV5(wsTopic, ORDER_CATEGORY_SPOT);
        this.ws.on('update', this.handlerAdapter(handler));

        return () => {
            this.instruments.delete(this.getInstrumentId(opts));
            this.ws.unsubscribeV5(wsTopic, ORDER_CATEGORY_SPOT);
        };
    }

    private handlerAdapter(handler: TickHandler) {
        return (tick: TickData) => {
            if (tick?.data?.length) {
                const candle = tick.data[0];
                handler({
                    o: parseFloat(candle.open),
                    h: parseFloat(candle.high),
                    l: parseFloat(candle.low),
                    c: parseFloat(candle.close),
                    v: parseFloat(candle.volume),
                    time: candle.start,
                });
            }
        };
    }

    private getInstrumentId(opts: DebutOptions) {
        return `${opts.ticker}:${opts.instrumentType}`;
    }

    private canRetry(e: Error) {
        for (const ignoreText of ignoredErrorsList) {
            if (e.message.includes(ignoreText)) {
                return false;
            }
        }

        return true;
    }

    public async getInstrument(opts: DebutOptions) {
        const { instrumentType, ticker } = opts;
        // Allow trade futures and non futures contracrs at same time
        const instrumentId = this.getInstrumentId(opts);
        // Getting from cache if exists
        if (this.instruments.has(instrumentId)) {
            return this.instruments.get(instrumentId);
        }

        let info: APIResponseV3WithTime<InstrumentInfoResponseV5<'spot'>> | undefined;

        info = this.info = this.info || (await this.api.getInstrumentsInfo({ category: ORDER_CATEGORY_SPOT }));

        const instrument = info?.result?.list.find((item) => item.symbol === ticker);

        if (!instrument) {
            throw new DebutError(ErrorEnvironment.Transport, 'Unknown instrument');
        }

        let minQuantity = 0;
        let minNotional = 0;

        if (instrument.status === 'Trading') {
            minQuantity = +instrument.lotSizeFilter.minOrderQty;
        }

        const lotPrecision = minQuantity === 1 ? 0 : math.getPrecision(minQuantity);

        const data: Instrument = {
            figi: ticker,
            ticker: ticker,
            minNotional,
            minQuantity,
            lot: 1,
            lotPrecision,
            type: instrumentType,
            id: instrumentId,
        };

        this.instruments.set(instrumentId, data);

        return data;
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

    public async subscribeOrderBook(opts: DebutOptions, handler: DepthHandler) {
        // const method = opts.instrumentType === 'FUTURES' ? 'futuresDepth' : 'depth';
        // const unsubscribe = this.api.ws[method](opts.ticker, this.depthAdapter(handler));

        return () => {
            // unsubscribe({
            //     delay: 0,
            //     fastClose: true,
            //     keepClosed: true,
            // });
        };
    }

    public async placeOrder(order: PendingOrder, opts: DebutOptions): Promise<ExecutedOrder> {
        const { type, lots, sandbox, learning } = order;
        const instrument: Instrument = await this.getInstrument(opts);
        const { instrumentType, currency } = opts;
        const { id, ticker } = instrument;
        order.retries = order.retries || 0;

        if (sandbox || learning) {
            return placeSandboxOrder(order, opts);
        }
        const feeRate = await this.api.getFeeRate({ category: ORDER_CATEGORY_SPOT, symbol: ticker });
        let takerFee = 0;
        if (feeRate?.result?.list?.length) {
            takerFee = +feeRate.result.list[0].takerFeeRate;
        }

        const base: OrderParamsV5 = {
            category: ORDER_CATEGORY_SPOT,
            orderType: ORDER_TYPE_MARKET,
            /*
                The currency for buying and selling is different. For more details, please refer to this
                https://bybit-exchange.github.io/docs/v5/order/create-order#request-parameters
            */
            qty:
                type === OrderType.BUY
                    ? String((lots * order.price).toFixed(5))
                    : String((lots - lots * takerFee).toFixed(5)),
            side: type === OrderType.BUY ? ORDER_SIDE_BUY : ORDER_SIDE_SELL,
            symbol: ticker,
        };

        let res: APIResponseV3<OrderResultV5> & { time: number };

        try {
            res = await this.api.submitOrder(base);

            if (res.retCode !== 0) {
                debug.logDebug('error order place', res);
                console.error(res);
                throw res;
            }
        } catch (e) {
            if (order.retries <= 10 && this.canRetry(e)) {
                debug.logDebug('error order place', e);
                order.retries++;
                // 10 ретраев чтобы точно попасть в период блокировки биржи изза скачков цены на 30 минут
                // тк блокировка длится в среднем 30 минут
                const timeout = Math.floor(
                    math.clamp(Math.pow(3 + Math.random(), order.retries) * 1000, 3000, 300000) + 60000 * Math.random(),
                );
                await promise.sleep(timeout);

                // Проверяем, что подписка все еще актуальна
                if (this.instruments.has(instrument.id)) {
                    return this.placeOrder(order, opts);
                }
            }

            debug.logDebug('retry failure with order', order);

            throw new DebutError(ErrorEnvironment.Transport, e.message);
        }

        if (order.retries > 0) {
            debug.logDebug('retry success');
        }

        // avg trade price
        let feeAmount = 0;
        let executedLots = 0;
        let price = 0;

        const params: GetAccountHistoricOrdersParamsV5 = {
            category: ORDER_CATEGORY_SPOT,
            orderId: res.result.orderId,
        };

        const historyRes: APIResponseV3WithTime<CategoryCursorListV5<AccountOrderV5[], CategoryV5>> =
            await this.api.getHistoricOrders(params);
        if (historyRes?.result?.list?.length) {
            const { avgPrice, cumExecFee, cumExecQty } = historyRes.result.list[0];
            price = +avgPrice;
            executedLots = +cumExecQty;
            feeAmount = +cumExecFee;
        }

        const commission = { value: feeAmount, currency };
        const executed: ExecutedOrder = {
            ...order,
            orderId: `${res?.result.orderId}`,
            executedLots: executedLots,
            lots: executedLots,
            commission,
            price,
        };

        return executed;
    }
}
