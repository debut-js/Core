import { orders } from '@debut/plugin-utils';
import { DebutOptions, ExecutedOrder, PendingOrder } from '@debut/types';

export function placeSandboxOrder(order: PendingOrder, opts: DebutOptions) {
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
