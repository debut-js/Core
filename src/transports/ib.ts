import {
    BaseTransport,
    Candle,
    DepthHandler,
    ExecutedOrder,
    Instrument,
    InstrumentType,
    OrderType,
    PendingOrder,
    TickHandler,
    TimeFrame,
} from '@debut/types';
import { DebutOptions } from '@debut/types';
import { DebutError, ErrorEnvironment } from '../modules/error';
import { placeSandboxOrder } from './utils/utils';
import IBApi, {
    BarSizeSetting,
    Contract,
    ContractDescription,
    EventName,
    Order,
    OrderAction,
    OrderType as ibOrderType,
    SecType,
    TimeInForce,
    OrderState,
    Stock,
} from '@stoqey/ib';
import { date, debug, math, promise } from '@debut/plugin-utils';
import TickType from '@stoqey/ib/dist/api/market/tickType';

export const IB_GATEWAY_PORT = 8888;

export function convertIBSymbolType(type: InstrumentType) {
    switch (type) {
        case 'FUTURES':
            return SecType.FUT;
        case 'SPOT':
            return SecType.STK;
        case 'MARGIN':
            return SecType.STK;
        default:
            throw new DebutError(ErrorEnvironment.Transport, 'Unknown instrument type');
    }
}

export function convertIBTimeFrame(interval: TimeFrame) {
    switch (interval) {
        case '1min':
            return BarSizeSetting.MINUTES_ONE;
        case '3min':
            return BarSizeSetting.MINUTES_THREE;
        case '5min':
            return BarSizeSetting.MINUTES_FIVE;
        case '15min':
            return BarSizeSetting.MINUTES_FIFTEEN;
        case '30min':
            return BarSizeSetting.MINUTES_THIRTY;
        case '1h':
            return BarSizeSetting.HOURS_ONE;
        case '2h':
            return BarSizeSetting.HOURS_TWO;
        case '4h':
            return BarSizeSetting.HOURS_FOUR;
        case 'day':
            return BarSizeSetting.DAYS_ONE;
        case 'month':
            return BarSizeSetting.MONTHS_ONE;
    }

    throw new DebutError(ErrorEnvironment.Transport, 'Unsupported interval');
}

export function isNotSupportedTimeframe(timeframe: TimeFrame) {
    try {
        return !convertIBTimeFrame(timeframe);
    } catch (e) {
        return true;
    }
}

export function transformIBCandle(date: number, o: number, h: number, l: number, c: number, v: number): Candle {
    const time = date * 1000;

    return { o, h, l, c, v, time };
}

let globalReqId = 0;

interface IBInstrument extends Instrument {
    primaryExch?: string;
}

export class IBTransport implements BaseTransport {
    public static getReqId() {
        return ++globalReqId;
    }
    // XXX Only nasday supported for beta
    public static exchange = 'SMART';
    public static trustedExchanges = ['NYSE', 'NASDAQ'];

    protected api: IBApi;
    private instruments: Map<string, IBInstrument> = new Map();

    constructor(protected accountId: string) {
        this.api = new IBApi({ port: IB_GATEWAY_PORT });
        this.api.once(EventName.nextValidId, (orderId) => {
            globalReqId = ++orderId;
        });
        this.api.connect();
        this.api.reqIds();
    }

    public async getInstrument(opts: DebutOptions) {
        const { ticker, instrumentType } = opts;
        const instrumentId = this.getInstrumentId(opts);

        if (this.instruments.has(instrumentId)) {
            return this.instruments.get(instrumentId);
        }

        const res = await this.getInstrumentData(ticker, instrumentType);
        const instrument: IBInstrument = {
            figi: String(res.conId),
            ticker: res.symbol,
            lot: 1, // lot is 1 always for stocks
            minNotional: 0, // does not provided from api
            minQuantity: 0, // does not provided from api
            lotPrecision: 1, // support only integer lots format
            type: 'SPOT',
            id: instrumentId,
            primaryExch: res.primaryExch,
        };

        this.instruments.set(instrumentId, instrument);

        return instrument;
    }

    public async subscribeToTick(opts: DebutOptions, handler: TickHandler) {
        const contract = this.getContract(opts);
        const mktDateReqId = IBTransport.getReqId();
        const realTimeReqId = IBTransport.getReqId();
        const intervalMs = date.intervalToMs(opts.interval);

        let currentBar: Candle = null;

        const realtimeBarHandler = (riId: number, t: number, o: number, h: number, l: number, c: number, v: number) => {
            if (riId !== realTimeReqId) {
                return;
            }

            currentBar = transformIBCandle(t, o, h, l, c, v);
            currentBar.time = ~~(currentBar.time / intervalMs) * intervalMs;

            handler(currentBar);
        };

        const tickPriceHandler = (reqId: number, field: TickType, value: number) => {
            if (mktDateReqId !== reqId || !currentBar) {
                return;
            }

            if (field === TickType.ASK || field === TickType.LAST || field === TickType.DELAYED_ASK) {
                currentBar.c = value;
                handler(currentBar);
            }
        };

        const unsubscribe = () => {
            this.api.cancelRealTimeBars(realTimeReqId);
            this.api.cancelMktData(mktDateReqId);
            this.api.off(EventName.tickPrice, tickPriceHandler);
            this.api.off(EventName.realtimeBar, realtimeBarHandler);
        };

        this.api.reqMarketDataType(1);
        this.api.reqMktData(mktDateReqId, contract, '', false, false);
        this.api.on(EventName.tickPrice, tickPriceHandler);

        this.api.reqRealTimeBars(realTimeReqId, contract, 5, 'ASK', true);
        this.api.on(EventName.realtimeBar, realtimeBarHandler);

        return unsubscribe;
    }

    public async subscribeOrderBook(opts: DebutOptions, handler: DepthHandler): Promise<() => void> {
        throw new DebutError(
            ErrorEnvironment.Transport,
            'Alpaca transport does not supported orderbook subscribtion yet!',
        );
    }

    public async placeOrder(order: PendingOrder, opts: DebutOptions): Promise<ExecutedOrder> {
        const { sandbox, learning } = order;
        const instrument = await this.getInstrument(opts);
        const reqId = IBTransport.getReqId();

        order.retries = order.retries || 0;

        if (sandbox || learning) {
            return placeSandboxOrder(order, opts);
        }

        const ibOrder = this.createIbOrder(order, reqId);

        return new Promise<ExecutedOrder>(async (resolve, reject) => {
            const openOrderFailureHandler = (error: Error, code: number, rId: number) => {
                if (rId === reqId) {
                    // this.api.off(EventName.openOrder, openOrderHandler);
                    return reject(new DebutError(ErrorEnvironment.Transport, error.message));
                }
            };

            const openOrderHandler = (orderId: Number, contract: Contract, filled: Order, state: OrderState) => {
                if (orderId != reqId) {
                    return;
                }

                this.api.off(EventName.openOrder, openOrderHandler);
                this.api.off(EventName.error, openOrderFailureHandler);

                if (filled.filledQuantity === 0) {
                    throw new DebutError(ErrorEnvironment.Transport, 'Order not filled, rejected');
                }

                const executedOrder: ExecutedOrder = {
                    ...order,
                    lots: filled.totalQuantity,
                    executedLots: filled.totalQuantity,
                    price: filled.triggerPrice,
                    commission: {
                        currency: opts.currency,
                        value: Number(state.commissionCurrency.split('E')[0]),
                    },
                    orderId: `${ibOrder.orderId}`,
                };

                resolve(executedOrder);
            };

            try {
                const contract = this.getContract(opts);
                this.api.placeOrder(reqId, contract, ibOrder);
                this.api.on(EventName.openOrder, openOrderHandler);
                this.api.on(EventName.error, openOrderFailureHandler);

                if (order.retries > 0) {
                    debug.logDebug('retry success');
                }
            } catch (e) {
                if (order.retries <= 10) {
                    debug.logDebug(' error order place \n', e);
                    order.retries++;
                    // 10 ретраев чтобы точно попасть в период блокировки биржи изза скачков цены на 30 минут
                    // тк блокировка длится в среднем 30 минут
                    const timeout = Math.floor(
                        math.clamp(Math.pow(3 + Math.random(), order.retries) * 1000, 3000, 300000) +
                            60000 * Math.random(),
                    );
                    await promise.sleep(timeout);

                    if (this.instruments.has(instrument.id)) {
                        return this.placeOrder(order, opts);
                    }
                }

                debug.logDebug(' retry failure with order', order);
                throw new DebutError(ErrorEnvironment.Transport, e.message);
            }
        });
    }

    public prepareLots(lots: number) {
        return Math.round(lots) || 1;
    }

    private getInstrumentId(opts: DebutOptions) {
        return `${opts.ticker}:${opts.instrumentType}`;
    }

    private async getInstrumentData(ticker: string, instrumentType: InstrumentType): Promise<Contract> {
        return new Promise((resolve) => {
            const reqId = IBTransport.getReqId();
            const securityType = convertIBSymbolType(instrumentType);
            // XXX Only Stock for NASDAQ for beta
            const handler = (incomingReqId: number, contracts: ContractDescription[]) => {
                if (incomingReqId !== reqId) {
                    return;
                }

                const target = contracts.find(
                    ({ contract }) =>
                        contract.secType === securityType &&
                        contract.symbol === ticker &&
                        IBTransport.trustedExchanges.includes(contract.primaryExch),
                );

                this.api.off(EventName.symbolSamples, handler);

                if (!target) {
                    throw new DebutError(ErrorEnvironment.Transport, `Instrument info not found for ticker ${ticker}`);
                }

                resolve(target.contract);
            };

            this.api.reqMatchingSymbols(reqId, ticker);
            this.api.on(EventName.symbolSamples, handler);
        });
    }

    private getContract(opts: DebutOptions): Contract {
        switch (opts.instrumentType) {
            case 'SPOT':
                return new Stock(opts.ticker);
            default:
                throw new DebutError(
                    ErrorEnvironment.Transport,
                    `${opts.instrumentType} does not supported by IB transport`,
                );
        }
    }

    private createIbOrder(pendingOrder: PendingOrder, orderId: number): Order {
        const action = pendingOrder.type === OrderType.BUY ? OrderAction.BUY : OrderAction.SELL;
        const openClose = pendingOrder.close ? 'C' : 'O';

        return {
            account: this.accountId,
            orderType: ibOrderType.MKT,
            totalQuantity: pendingOrder.lots,
            tif: TimeInForce.IOC,
            openClose,
            transmit: true,
            orderId,
            action,
        };
    }
}
