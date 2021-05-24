import { OrderType, ExecutedOrder, OrderOptions } from '../types/order';
import { getPrecision } from './math';

/**
 * Reverse order type
 */
export function inverseType(type: OrderType) {
    return type === OrderType.BUY ? OrderType.SELL : OrderType.BUY;
}

/**
 * Generate synthetic order id from order
 */
export function syntheticOrderId(order: ExecutedOrder | OrderOptions) {
    return `${order.time}-${order.type}-${order.price}`;
}

/**
 * Get minimal increment value for float number with current precision
 */
export function getMinIncrementValue(price: number | string) {
    const precision = getPrecision(price);
    return Number(`${parseFloat('0').toFixed(precision - 1)}1`);
}
