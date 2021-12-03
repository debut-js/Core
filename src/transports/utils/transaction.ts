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
    private orders: PendingOrder[] = [];
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
        return !this.orders.length || this.orders[0].type === order.type;
    }

    public async add(order: PendingOrder) {
        this.lastOrder = order;

        const idx = this.orders.push(order) - 1;
        const orders = await this.promise;

        return orders[idx];
    }

    public async execute(): Promise<ExecutedOrder[]> {
        let lots: number = 0;
        let type: OrderType;
        const length = this.orders.length;
        const virtualOrders: ExecutedOrder[] = [];

        for (let i = 0; i < length; i++) {
            const closing = this.orders[i];

            if ((type && closing.type !== type) || !closing.close) {
                this.reject('Incorrect transaction orders, must be closed order and same type');
            }

            lots += closing.lots;
            type = closing.type;

            const executed = placeSandboxOrder(closing, this.opts);
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
            };
            const marketOrder = await this.transport.placeOrder(collapsedOrder, this.opts);

            // Apply same price to each order, end execute as partial
            virtualOrders.forEach((order) => (order.price = marketOrder.price));
        }

        this.resolve(virtualOrders);

        return virtualOrders;
    }
}
