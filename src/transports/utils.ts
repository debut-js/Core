import { orders } from '@debut/plugin-utils';
import { Instrument } from '@debut/types';
import { DebutOptions, ExecutedOrder, PendingOrder } from '@debut/types';

export async function placeSandboxOrder(order: PendingOrder, opts: DebutOptions, instrument: Instrument) {
    const feeAmount = order.price * order.lots * (opts.fee / 100);
    const commission = { value: feeAmount, currency: 'USD' };
    const executed: ExecutedOrder = {
        ...order,
        orderId: orders.syntheticOrderId(order),
        executedLots: order.lots,
        commission,
    };

    return executed;
}
