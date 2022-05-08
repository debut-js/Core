import { debug, math, orders, promise } from '@debut/plugin-utils';
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
    DepthHandler,
    DepthOrder,
} from '@debut/types';
import Binance, {
    BidDepth,
    Candle as BinanceCandle,
    CandleChartInterval,
    Depth,
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
} from 'binance-api-node';
import { placeSandboxOrder } from './utils/utils';
import { Transaction } from './utils/transaction';

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

const badStatus = ['CANCELED', 'EXPIRED', 'PENDING_CANCEL', 'REJECTED'];
export class BinanceTransport implements BaseTransport {
    public api: ReturnType<typeof Binance>;
    protected instruments: Map<string, Instrument> = new Map();
    protected info: ExchangeInfo;
    protected futuresInfo: ExchangeInfo;
    protected hedgeMode = false;

    constructor(apiKey: string, apiSecret: string) {
        if (!apiKey || !apiSecret) {
            throw new DebutError(ErrorEnvironment.Transport, 'apiKey or apiSecret are incorrect');
        }

        // Authenticated client, can make signed calls
        this.api = Binance({ apiKey, apiSecret });
    }

    public async getInstrument(opts: DebutOptions) {
        const { instrumentType, ticker } = opts;
        // Allow trade futures and non futures contracrs at same time
        const instrumentId = this.getInstrumentId(opts);
        // Getting from cache if exists
        if (this.instruments.has(instrumentId)) {
            return this.instruments.get(instrumentId);
        }

        let info: ExchangeInfo;

        if (instrumentType === 'FUTURES') {
            info = this.futuresInfo = this.futuresInfo || (await this.api.futuresExchangeInfo());
            this.hedgeMode = (await this.api.futuresPositionMode()).dualSidePosition;
        } else {
            info = this.info = this.info || (await this.api.exchangeInfo());
        }

        const instrument = info.symbols.find((item) => item.symbol === ticker);

        if (!instrument) {
            throw new DebutError(ErrorEnvironment.Transport, 'Unknown instrument');
        }

        let minQuantity = 0;
        let minNotional = 0;

        for (const filter of instrument.filters) {
            if (filter.filterType === 'LOT_SIZE') {
                minQuantity = Number(filter.minQty);
            } else if (filter.filterType === 'MIN_NOTIONAL') {
                // @ts-ignore
                minNotional = Number(filter.minNotional) || Number(filter.notional);
            }

            if (minQuantity && minNotional) {
                break;
            }
        }

        // 0.0000100 -> 0.00001
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

    public setleverage(ticker: string, leverage: number = 20) {
        return this.api.futuresLeverage({ symbol: ticker, leverage });
    }

    public async subscribeOrderBook(opts: DebutOptions, handler: DepthHandler) {
        const method = opts.instrumentType === 'FUTURES' ? 'futuresDepth' : 'depth';
        const unsubscribe = this.api.ws[method](opts.ticker, this.depthAdapter(handler));

        return () => {
            unsubscribe({
                delay: 0,
                fastClose: true,
                keepClosed: true,
            });
        };
    }

    public async placeOrder(order: PendingOrder, opts: DebutOptions): Promise<ExecutedOrder> {
        const { type, lots, sandbox, learning } = order;
        const instrument = await this.getInstrument(opts);
        const { instrumentType, currency } = opts;
        const { id, ticker } = instrument;
        order.retries = order.retries || 0;

        if (sandbox || learning) {
            return placeSandboxOrder(order, opts);
        }

        const base: NewOrderMarketBase = {
            quantity: String(lots),
            side: type === OrderType.BUY ? OrderSide.BUY : OrderSide.SELL,
            symbol: ticker,
            type: BinanceOrderType.MARKET,
        };

        let res: Order | FuturesOrder;
        // Only network condition should be try catch wrapped and retried, for prevent network retries when error throws from JS error

        try {
            switch (instrumentType) {
                case 'FUTURES':
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
                case 'MARGIN':
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

        const precision = math.getPrecision(order.price);
        // avg trade price
        let fees = 0;
        let price = 0;
        let qty = 0;

        if ('fills' in res) {
            res.fills.forEach((fill) => {
                price += Number(fill.price);
                qty += Number(fill.qty);

                if (ticker.startsWith(fill.commissionAsset)) {
                    fees += Number(fill.commission);
                }
            });

            price = math.toFixed(price / res.fills.length, precision);
        }

        if ('avgPrice' in res) {
            price = math.toFixed(Number(res.avgPrice), precision);
        }

        let executedLots: number;

        if (qty) {
            const realQty = qty - fees;
            executedLots = this.prepareLots(realQty, id);
        } else if ('executedQty' in res) {
            executedLots = Number(res.executedQty);
        }

        const feeAmount = fees && isFinite(fees) ? fees : price * order.lots * (opts.fee / 100);
        const commission = { value: feeAmount, currency };
        const executed: ExecutedOrder = {
            ...order,
            orderId: `${res.orderId}`,
            executedLots: executedLots,
            lots: executedLots,
            commission,
            price,
        };

        return executed;
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

        return resultLots;
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

    private depthAdapter(handler: DepthHandler) {
        function migrateData(depth: BidDepth, result: DepthOrder[]) {
            const price = parseFloat(depth.price);
            const qty = parseFloat(depth.quantity);

            if (qty !== 0) {
                result.push({ price, qty });
            }
        }

        return (depth: Depth) => {
            const bids: DepthOrder[] = [];
            const asks: DepthOrder[] = [];

            depth.bidDepth.forEach((item) => {
                migrateData(item, bids);
            });

            depth.askDepth.forEach((item) => {
                migrateData(item, asks);
            });

            handler({ bids, asks });
        };
    }

    private getInstrumentId(opts: DebutOptions) {
        return `${opts.ticker}:${opts.instrumentType}`;
    }

    private canRetry(e: Error) {
        if (e.message.includes('ReduceOnly Order is rejected')) {
            return false;
        }

        return true;
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
    throw new DebutError(ErrorEnvironment.Transport, 'Unsupported interval');
}
