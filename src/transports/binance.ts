import { cli, debug, math, orders, promise } from '@debut/plugin-utils';
import {
    BaseTransport,
    ExecutedOrder,
    Instrument,
    OrderOptions,
    OrderType,
    TickHandler,
    TimeFrame,
} from '@debut/types';
import Binance, {
    Candle as BinanceCandle,
    CandleChartInterval,
    ExchangeInfo,
    NewOrder,
    Order,
    OrderSide,
    OrderType as BinanceOrderType,
    SideEffectType,
    SymbolLotSizeFilter,
} from 'binance-api-node';

/**
 * Example order data
 * {
  symbol: 'BTCUSDT',
  orderId: 4751786422,
  orderListId: -1,
  clientOrderId: '******',
  transactTime: 1612972674047,
  price: '0.00000000',
  origQty: '0.00340000',
  executedQty: '0.00340000',
  cummulativeQuoteQty: '150.43075600',
  status: 'FILLED',
  timeInForce: 'GTC',
  type: 'MARKET',
  side: 'BUY',
  fills: [
    {
      price: '44244.34000000',
      qty: '0.00340000',
      commission: '0.00000340',
      commissionAsset: 'BTC',
      tradeId: 632828595
    }
  ]
}
 */

/** Binance cli arguments */
type BinanceTransportArgs = { btoken: string; bsecret: string };

const badStatus = ['CANCELED', 'EXPIRED', 'PENDING_CANCEL', 'REJECTED'];
export class BinanceTransport implements BaseTransport {
    public api: ReturnType<typeof Binance>;
    protected instruments: Map<string, Instrument> = new Map();
    protected info: ExchangeInfo;

    constructor() {
        const tokens = cli.getTokens();
        let { btoken = 'binance', bsecret = 'binanceSecret' } = cli.getArgs<BinanceTransportArgs>();

        btoken = tokens[btoken];
        bsecret = tokens[bsecret];

        if (!btoken || !bsecret) {
            throw 'Binance API token and secret are required!';
        }

        // Authenticated client, can make signed calls
        this.api = Binance({
            apiKey: btoken,
            apiSecret: bsecret,
        });
    }

    public async getInstrument(ticker: string) {
        // Возьмем из кеша если есть
        if (this.instruments.has(ticker)) {
            return this.instruments.get(ticker);
        }

        const prices = await this.api.prices({ symbol: ticker });

        this.info = this.info || (await this.api.exchangeInfo());

        const instrument = this.info.symbols.find((item) => item.symbol === ticker);

        if (!prices[ticker] || !instrument) {
            throw 'Unknown instrument';
        }

        const lotFilter = instrument.filters.find((filter) => filter.filterType === 'LOT_SIZE') as SymbolLotSizeFilter;
        // 0.0000100 -> 0.00001
        const minQty = Number(lotFilter.minQty);
        const lotPrecision = minQty === 1 ? 0 : math.getPrecision(minQty);

        const data: Instrument = {
            figi: ticker,
            ticker: ticker,
            pipSize: orders.getMinIncrementValue(prices[ticker]),
            lot: 1,
            lotPrecision,
        };

        this.instruments.set(ticker, data);

        return data;
    }

    public async subscribeToTick(ticker: string, handler: TickHandler, interval: TimeFrame) {
        const unsubscribe = this.api.ws.candles(ticker, convertTimeFrame(interval), this.handlerAdapter(handler));

        return () => {
            this.instruments.delete(ticker);

            unsubscribe({
                delay: 0,
                fastClose: true,
                keepClosed: true,
            });
        };
    }

    public async placeOrder(order: OrderOptions): Promise<ExecutedOrder> {
        const { type, lots: requestedLots, sandbox, ticker, learning, currency } = order;
        order.retries = order.retries || 0;

        if (sandbox || learning) {
            return this.placeSandboxOrder(order);
        }

        try {
            const payload: NewOrder = {
                quantity: String(requestedLots),
                side: type === OrderType.BUY ? 'BUY' : 'SELL',
                symbol: ticker,
                type: 'MARKET',
            };

            if (order.margin && order.close) {
                payload.sideEffectType = 'AUTO_REPAY';
            }

            if (order.margin && !order.close) {
                payload.sideEffectType = 'MARGIN_BUY';
            }

            let res: Order;

            switch (true) {
                case order.futures:
                    res = await this.api.futuresOrder(payload);
                    break;
                case order.margin:
                    res = await this.api.marginOrder(payload);
                    break;
                default:
                    res = await this.api.order(payload);
            }

            if (badStatus.includes(res.status)) {
                throw res;
            }

            if (order.retries > 0) {
                debug.logDebug('retry success');
            }

            const precision = math.getPrecision(order.price);
            // avg trade price
            let fees = 0;
            let price = 0;
            let qty = 0;

            res.fills.forEach((fill) => {
                price += Number(fill.price);
                qty += Number(fill.qty);

                if (order.ticker.startsWith(fill.commissionAsset)) {
                    fees += Number(fill.commission);
                }
            });

            price = math.toFixed(price / res.fills.length, precision);

            const realQty = qty - fees;
            let lots = this.prepareLots(realQty, ticker);
            const isInteger = parseInt(`${lots}`) === lots;
            const lotsRedunantValue = isInteger ? 1 : orders.getMinIncrementValue(lots);

            // Issue with rounding
            // Reduce lots when rounding is more than source amount
            while (lots > realQty && lots > 0) {
                lots = this.prepareLots(lots - lotsRedunantValue, ticker);
            }

            const feeAmount = order.price * order.lots * 0.001;
            const commission = { value: feeAmount, currency };
            const executed: ExecutedOrder = {
                ...order,
                orderId: `${res.orderId}`,
                executedLots: lots,
                lots,
                commission,
                price,
            };

            return executed;
        } catch (e) {
            if (order.retries <= 10) {
                debug.logDebug('error order place', e);
                order.retries++;
                // 10 ретраев чтобы точно попасть в период блокировки биржи изза скачков цены на 30 минут
                // тк блокировка длится в среднем 30 минут
                const timeout = Math.floor(
                    math.clamp(Math.pow(3 + Math.random(), order.retries) * 1000, 3000, 300000) + 60000 * Math.random(),
                );
                await promise.sleep(timeout);

                if (this.instruments.has(ticker)) {
                    return this.placeOrder(order);
                }
            }

            debug.logDebug('retry failure with order', order);
            throw e;
        }
    }

    public async placeSandboxOrder(order: OrderOptions): Promise<ExecutedOrder> {
        const feeAmount = order.price * order.lots * 0.002;
        const commission = { value: feeAmount, currency: order.currency };
        const executed: ExecutedOrder = {
            ...order,
            orderId: orders.syntheticOrderId(order),
            executedLots: order.lots,
            commission,
        };

        return executed;
    }

    public prepareLots(lots: number, ticker: string) {
        const instrument = this.instruments.get(ticker);

        if (!instrument) {
            throw `Unknown instument ticker ${ticker}`;
        }

        // Zero precision means lots is integer number
        if (instrument.lotPrecision === 0) {
            return Math.floor(lots);
        }

        return math.toFixed(lots, instrument.lotPrecision);
    }

    private handlerAdapter(handler: TickHandler) {
        return (tick: BinanceCandle) => {
            console.log('new tick task planned');
            setImmediate(() => {
                console.log('new tick task executed');
                handler({
                    o: parseFloat(tick.open),
                    h: parseFloat(tick.high),
                    l: parseFloat(tick.low),
                    c: parseFloat(tick.close),
                    v: parseFloat(tick.volume),
                    time: tick.startTime,
                });
            });
        };
    }
}

export function convertTimeFrame(interval: TimeFrame) {
    switch (interval) {
        case '1min':
            return CandleChartInterval.ONE_MINUTE;
        case '5min':
            return CandleChartInterval.FIVE_MINUTES;
        case '15min':
            return CandleChartInterval.FIFTEEN_MINUTES;
        case '30min':
            return CandleChartInterval.THIRTY_MINUTES;
        case '1h':
            return CandleChartInterval.ONE_HOUR;
        case '4h':
            return CandleChartInterval.FOUR_HOURS;
        case 'day':
            return CandleChartInterval.ONE_DAY;
    }
    throw new Error('Unsupported interval');
}
