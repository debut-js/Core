import {
    TransactionInterface,
    PendingOrder,
    ExecutedOrder,
    OrderType,
    DebutOptions,
    BaseTransport,
} from '@debut/types';
import { placeSandboxOrder } from './utils';

export class Transaction implements TransactionInterface {
    private pendingOrders: PendingOrder[] = [];
    private reject: Function;
    private resolve: Function;
    private promise: Promise<ExecutedOrder[]>;
    private lastOrder: PendingOrder;

    constructor(private opts: DebutOptions, private transport: BaseTransport) {
        this.promise = new Promise((resolve, reject) => {
            this.reject = reject;
            this.resolve = resolve;
        });
    }

    public canAppendOrder(order: PendingOrder) {
        return !this.pendingOrders.length || this.pendingOrders[0].type === order.type;
    }

    public async add(order: PendingOrder) {
        this.lastOrder = order;

        const idx = this.pendingOrders.push(order) - 1;
        const orders = await this.promise;

        return orders[idx];
    }

    public async execute(): Promise<ExecutedOrder[]> {
        let lots: number = 0;
        let type: OrderType;
        const length = this.pendingOrders.length;
        const virtualOrders: ExecutedOrder[] = [];
        const transaction: Array<string | number> = [];

        for (let i = 0; i < length; i++) {
            const pending = this.pendingOrders[i];

            if ((type && pending.type !== type) || !pending.close) {
                this.reject('Incorrect transaction orders, must be closed order and same type');
            }

            lots += pending.lots;
            type = pending.type;

            transaction.push(pending.openId);

            const executed = placeSandboxOrder(pending, this.opts);
            virtualOrders.push(executed);
        }

        // Change prices, if all orders is sandbox or learning, keep original prices
        if (lots > 0) {
            const instrument = await this.transport.getInstrument(this.opts);
            const collapsedOrder = {
                // Last order may be not sandboxed or not learning, copy from most actual order data
                ...this.lastOrder,
                openId: 'ALL',
                lots: this.transport.prepareLots(lots, instrument.id),
                transaction,
            };
            const marketOrder = await this.transport.placeOrder(collapsedOrder, this.opts);

            // Apply same price to each order, end execute as partial
            virtualOrders.forEach((order) => (order.price = marketOrder.price));
        }

        this.resolve(virtualOrders);

        return virtualOrders;
    }
}
