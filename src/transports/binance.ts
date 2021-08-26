import { cli, debug, math, orders, promise } from '@debut/plugin-utils';
import { DebutError, ErrorEnvironment } from '../modules/error';
import {
    BaseTransport,
    ExecutedOrder,
    Instrument,
    DebutOptions,
    OrderType,
    PendingOrder,
    TickHandler,
    TimeFrame,
} from '@debut/types';
import Binance, {
    Candle as BinanceCandle,
    CandleChartInterval,
    ExchangeInfo,
    FuturesOrder,
    NewFuturesOrder,
    NewOrderMargin,
    NewOrderMarketBase,
    NewOrderRespType,
    Order,
    OrderSide,
    OrderType as BinanceOrderType,
    PositionSide,
    SideEffectType,
    SymbolLotSizeFilter,
    TimeInForce,
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
    protected futuresInfo: ExchangeInfo;
    protected hedgeMode = false;

    constructor() {
        const tokens = cli.getTokens();
        let { btoken = 'binance', bsecret = 'binanceSecret' } = cli.getArgs<BinanceTransportArgs>();

        btoken = tokens[btoken];
        bsecret = tokens[bsecret];

        if (!btoken || !bsecret) {
            throw new DebutError(ErrorEnvironment.Transport, 'Binance API token and secret are required!');
        }

        // Authenticated client, can make signed calls
        this.api = Binance({
            apiKey: btoken,
            apiSecret: bsecret,
        });
    }

    public async getInstrument(opts: DebutOptions) {
        const { instrumentType, ticker } = opts;
        // Allow trade futures and non futures contracrs at same time
        const instrumentId = this.getInstrumentId(opts);
        // Getting from cache if exists
        if (this.instruments.has(instrumentId)) {
            return this.instruments.get(instrumentId);
        }

        const prices = await this.api.prices({ symbol: ticker });
        let info: ExchangeInfo;

        if (instrumentType === 'SPOT') {
            info = this.info = this.info || (await this.api.exchangeInfo());
        } else if (instrumentType === 'FUTURES') {
            info = this.futuresInfo = this.futuresInfo || (await this.api.futuresExchangeInfo());
            this.hedgeMode = (await this.api.futuresPositionMode()).dualSidePosition;
        }

        const instrument = info.symbols.find((item) => item.symbol === ticker);

        if (!prices[ticker] || !instrument) {
            throw new DebutError(ErrorEnvironment.Transport, 'Unknown instrument');
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
            type: instrumentType,
            id: instrumentId,
        };

        this.instruments.set(instrumentId, data);

        return data;
    }

    public async subscribeToTick(opts: DebutOptions, handler: TickHandler) {
        // FIXME: SDK Typings bug ws.futuresCandles are not described
        const method = opts.instrumentType === 'FUTURES' ? 'futuresCandles' : 'candles';
        const unsubscribe = this.api.ws[method](
            opts.ticker,
            convertTimeFrame(opts.interval),
            this.handlerAdapter(handler),
        );

        return () => {
            this.instruments.delete(this.getInstrumentId(opts));

            unsubscribe({
                delay: 0,
                fastClose: true,
                keepClosed: true,
            });
        };
    }

    public async placeOrder(order: PendingOrder, opts: DebutOptions): Promise<ExecutedOrder> {
        const { type, lots: requestedLots, sandbox, ticker, learning, currency, futures, margin } = order;
        order.retries = order.retries || 0;

        if (sandbox || learning) {
            return this.placeSandboxOrder(order);
        }

        const instrumentId = this.getInstrumentId(opts);

        try {
            const base: NewOrderMarketBase = {
                quantity: String(requestedLots),
                side: type === OrderType.BUY ? OrderSide.BUY : OrderSide.SELL,
                symbol: ticker,
                type: BinanceOrderType.MARKET,
            };

            let res: Order | FuturesOrder;

            switch (true) {
                case futures:
                    let positionSide = PositionSide.BOTH;

                    if (this.hedgeMode) {
                        positionSide = type === OrderType.BUY ? PositionSide.LONG : PositionSide.SHORT;

                        if (order.close) {
                            positionSide = type === OrderType.BUY ? PositionSide.SHORT : PositionSide.LONG;
                        }
                    }

                    const futuresPayload: NewFuturesOrder = {
                        ...base,
                        positionSide,
                        newOrderRespType: NewOrderRespType.RESULT,
                    };

                    res = await this.api.futuresOrder(futuresPayload);
                    break;
                case margin:
                    const marginPayload: NewOrderMargin = {
                        ...base,
                        sideEffectType: order.close ? SideEffectType.AUTO_REPAY : SideEffectType.MARGIN_BUY,
                    };

                    res = await this.api.marginOrder(marginPayload);
                    break;
                default:
                    res = await this.api.order(base);
                    break;
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

            if ('fills' in res) {
                res.fills.forEach((fill) => {
                    price += Number(fill.price);
                    qty += Number(fill.qty);

                    if (order.ticker.startsWith(fill.commissionAsset)) {
                        fees += Number(fill.commission);
                    }
                });

                price = math.toFixed(price / res.fills.length, precision);
            }

            if ('avgPrice' in res) {
                price = math.toFixed(Number(res.avgPrice), precision);
            }

            let lots: number;

            if (qty) {
                const realQty = qty - fees;
                const isInteger = parseInt(`${lots}`) === lots;
                const lotsRedunantValue = isInteger ? 1 : orders.getMinIncrementValue(lots);

                // Issue with rounding
                // Reduce lots when rounding is more than source amount
                while (lots > realQty && lots > 0) {
                    lots = this.prepareLots(lots - lotsRedunantValue, instrumentId);
                }
            }

            if ('executedQty' in res) {
                lots = Number(res.executedQty);
            }

            lots = this.prepareLots(lots, instrumentId);
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

                if (this.instruments.has(instrumentId)) {
                    return this.placeOrder(order, opts);
                }
            }

            debug.logDebug('retry failure with order', order);
            throw e;
        }
    }

    public async placeSandboxOrder(order: PendingOrder): Promise<ExecutedOrder> {
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

    public prepareLots(lots: number, instrumentId: string) {
        const instrument = this.instruments.get(instrumentId);

        if (!instrument) {
            throw new DebutError(ErrorEnvironment.Transport, `Unknown instument id ${instrumentId}`);
        }

        // Zero precision means lots is integer number
        if (instrument.lotPrecision === 0) {
            return Math.floor(lots);
        }

        return math.toFixed(lots, instrument.lotPrecision);
    }

    private handlerAdapter(handler: TickHandler) {
        return (tick: BinanceCandle) => {
            handler({
                o: parseFloat(tick.open),
                h: parseFloat(tick.high),
                l: parseFloat(tick.low),
                c: parseFloat(tick.close),
                v: parseFloat(tick.volume),
                time: tick.startTime,
            });
        };
    }

    private getInstrumentId(opts: DebutOptions) {
        return `${opts.ticker}:${opts.instrumentType}`;
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
