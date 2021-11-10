import { orders } from '@debut/plugin-utils';
import { Instrument, OrderOptions } from '@debut/types';
import { DebutOptions, ExecutedOrder, PendingOrder } from '@debut/types';

export async function placeSandboxOrder(order: PendingOrder, opts: DebutOptions, instrument: Instrument) {
    const feeAmount = order.price * order.lots * (opts.fee / 100);
    const commission = { value: feeAmount, currency: 'USD' };
    const executed: ExecutedOrder = {
        ...order,
        ...createOrderOptions(instrument, opts),
        orderId: orders.syntheticOrderId(order),
        executedLots: order.lots,
        commission,
    };

    return executed;
}

export function createOrderOptions(instrument: Instrument, opts: DebutOptions): OrderOptions {
    const { broker, ticker, currency, interval, instrumentType, lotsMultiplier, equityLevel } = opts;

    return {
        broker,
        ticker,
        figi: instrument.figi,
        currency,
        interval,
        instrumentType,
        lotsMultiplier,
        equityLevel,
    };
}
