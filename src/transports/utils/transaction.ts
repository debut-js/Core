import { TransactionInterface, PendingOrder, ExecutedOrder, OrderType, DebutOptions } from '@debut/types';
import { placeSandboxOrder } from './utils';

export class Transaction implements TransactionInterface {
    private orders: PendingOrder[] = [];
    private reject: Function;
    private resolve: Function;
    private promise: Promise<ExecutedOrder[]>;
    private ready: Promise<void>;
    private readyResolve: Function;
    private readyTimeout: NodeJS.Timeout;

    constructor(private opts: DebutOptions, private count: number) {
        this.promise = new Promise((resolve, reject) => {
            this.reject = reject;
            this.resolve = resolve;
        });

        this.ready = new Promise((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyTimeout = setTimeout(() => {
                reject('Transaction timeout');
            }, 5000);
        });
    }

    public whenReady() {
        return this.ready;
    }

    public async add(order: PendingOrder) {
        const idx = this.orders.push(order) - 1;
        const prevOrder = this.orders[idx - 1];

        order.transactionSeq = idx === 0 ? 'first' : 'last';

        if (prevOrder && prevOrder.transactionSeq !== 'first') {
            prevOrder.transactionSeq = 'middle';
        }

        this.count--;

        if (this.count < 0) {
            this.reject('Transaction orders more than declared');
        }

        // All orders has been registered to transaction
        if (this.count === 0) {
            clearTimeout(this.readyTimeout);
            this.readyResolve();
        }

        const orders = await this.promise;

        return orders[idx];
    }

    public async execute(executeMethod: (order: PendingOrder) => Promise<ExecutedOrder>): Promise<ExecutedOrder[]> {
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

        const collapsedOrder = {
            ...this.orders[0],
            openId: 'ALL',
            lots,
        };

        const marketOrder = await executeMethod(collapsedOrder);

        // Apply same price to each order, end execute as partial
        virtualOrders.forEach((order) => (order.price = marketOrder.price));

        this.resolve(virtualOrders);

        return virtualOrders;
    }
}
