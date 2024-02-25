import {
    BaseTransport,
    Candle,
    DepthHandler,
    ExecutedOrder,
    Instrument,
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
    TickByTickDataType,
    TimeInForce,
    OrderState,
    OrderStatus,
    WhatToShow,
} from '@stoqey/ib';
import { debug, math, orders, promise } from '@debut/plugin-utils';

export const IB_GATEWAY_PORT = 4002;
export function convertIBTimeFrame(interval: TimeFrame) {
    switch (interval) {
        case '1min':
            return BarSizeSetting.MINUTES_ONE;
        case '5min':
            return BarSizeSetting.MINUTES_FIVE;
        case '15min':
            return BarSizeSetting.MINUTES_FIFTEEN;
        case '30min':
            return BarSizeSetting.MINUTES_THIRTY;
        case '1h':
            return BarSizeSetting.HOURS_ONE;
        case '4h':
            return BarSizeSetting.HOURS_FOUR;
        case 'day':
            return BarSizeSetting.DAYS_ONE;
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

export class IBTransport implements BaseTransport {
    public static getReqId() {
        return ++globalReqId;
    }
    // XXX Only nasday supported for beta
    public static exchange = 'NASDAQ';

    protected api: IBApi;
    private instruments: Map<string, Instrument> = new Map();

    constructor() {
        this.api = new IBApi({ port: IB_GATEWAY_PORT, clientId: IBTransport.getReqId() });
        this.api.connect();
        this.api.reqIds();
        this.api.once(EventName.nextValidId, (orderId) => {
            globalReqId = ++orderId;
        });
    }

    public async getInstrument(opts: DebutOptions) {
        const { ticker } = opts;
        const instrumentId = this.getInstrumentId(opts);

        if (this.instruments.has(instrumentId)) {
            return this.instruments.get(instrumentId);
        }

        const res = await this.getInstrumentData(ticker);
        const instrument: Instrument = {
            figi: String(res.conId),
            ticker: res.symbol,
            lot: 1, // lot is 1 always for stocks
            minNotional: 0, // does not provided from api
            minQuantity: 0, // does not provided from api
            lotPrecision: 1, // support only integer lots format
            type: 'SPOT',
            id: instrumentId,
        };

        this.instruments.set(instrumentId, instrument);

        return instrument;
    }

    public async subscribeToTick(opts: DebutOptions, handler: TickHandler) {
        const reqId = IBTransport.getReqId();
        const realtimeBarHandler = (riId: number, t: number, o: number, h: number, l: number, c: number, v: number) => {
            if (riId !== reqId) {
                return;
            }

            handler(transformIBCandle(t, o, h, l, c, v));
        };

        try {
            const contract = await this.getContract(opts);

            this.api.reqRealTimeBars(reqId, contract, 5, WhatToShow.TRADES, false);
            this.api.on(EventName.realtimeBar, realtimeBarHandler);

            return () => {
                this.api.cancelRealTimeBars(reqId);
            };
        } catch (e) {
            this.api.off(EventName.realtimeBar, realtimeBarHandler);
            this.api.cancelRealTimeBars(reqId);
        }
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

        const ibOrder = this.createIbOrder(order);

        return new Promise<ExecutedOrder>(async (resolve) => {
            const openOrderFailureHandler = (error: Error, code: number, rId: number) => {
                console.log(error);
                if (rId === reqId) {
                    this.api.off(EventName.openOrder, openOrderHandler);
                    throw new DebutError(ErrorEnvironment.Transport, error.message);
                }
            };

            const openOrderHandler = (orderId: Number, contract: Contract, filled: Order, state: OrderState) => {
                console.log(filled, state, orderId, reqId);

                if (orderId != ibOrder.orderId) {
                    return;
                }

                this.api.off(EventName.openOrder, openOrderHandler);
                this.api.off(EventName.error, openOrderFailureHandler);

                if (state.status !== OrderStatus.Filled) {
                    throw new DebutError(ErrorEnvironment.Transport, state.warningText);
                }

                const executedOrder: ExecutedOrder = {
                    ...order,
                    lots: filled.totalQuantity,
                    executedLots: filled.totalQuantity,
                    price: filled.triggerPrice,
                    commission: {
                        currency: state.commissionCurrency,
                        value: state.commission,
                    },
                    orderId: `${ibOrder.orderId}`,
                };

                resolve(executedOrder);
            };

            try {
                const contract = await this.getContract(opts);
                this.api.placeOrder(reqId, contract, ibOrder);
                this.api.on(EventName.openOrder, openOrderHandler);
                this.api.on(EventName.orderBound, (reqId, ...args) => {
                    console.log(...args);
                });
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

    private async getInstrumentData(ticker: string): Promise<Contract> {
        return new Promise((resolve) => {
            const reqId = IBTransport.getReqId();
            // XXX Only Stock for NASDAQ for beta
            const handler = (incomingReqId: number, contracts: ContractDescription[]) => {
                if (incomingReqId !== reqId) {
                    return;
                }

                const target = contracts.find(
                    ({ contract }) =>
                        contract.secType === SecType.STK &&
                        contract.symbol === ticker &&
                        contract.primaryExch === IBTransport.exchange,
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

    private async getContract(opts: DebutOptions): Promise<Contract> {
        const instrument = await this.getInstrument(opts);

        return {
            conId: Number(instrument.figi),
            secIdType: SecType.STK,
            exchange: IBTransport.exchange,
        };
    }

    private createIbOrder(pendingOrder: PendingOrder): Order {
        const action = pendingOrder.type === OrderType.BUY ? OrderAction.BUY : OrderAction.SELL;

        return {
            orderId: IBTransport.getReqId(),
            action,
            totalQuantity: pendingOrder.lots,
            orderType: ibOrderType.MKT, // XXX MARKET ONLY
            tif: TimeInForce.IOC,
        };
    }
}
