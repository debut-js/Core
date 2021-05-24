import { TimeFrame } from './common';

/**
 * Type of order for placing
 */
export const enum OrderType {
    'BUY' = 'BUY',
    'SELL' = 'SELL',
}

/**
 * Debut order parameters
 */
export interface OrderOptions {
    // Current broker, supported "Binance", "Tinkoff"
    broker: string;
    // Order type
    type: OrderType;
    // Ticker name
    ticker: string;
    // Current candle time
    time: string;
    // Broker asset id (if exists)
    figi?: string;
    // Currency name
    currency: string;
    // Candle time frame
    interval: TimeFrame;
    // Order owner name
    author: string;
    // Requested price
    price: number;
    // Requested lots
    lots: number;
    // Asset lot size, 1=1 by default
    lotSize: number;
    // Pip size (minimal price increment value)
    pipSize: number;
    // Sandbox marker
    sandbox: boolean;
    // Close marker, true when current order is close of previous order
    close: boolean;
    // Open price (only for close order)
    openPrice?: number;
    // Open order id (only for close order)
    openId?: string;
    // Lots will be multiplied to this value (preferred for martingale systems)
    lotsMultiplier?: number;
    // How many equity you want use from balance. In percent values between 0 and 1, e.g. 0.97 = 97%
    equityLevel?: number;
    // Learning marker, mean order created in learning phase
    learning?: boolean;
    // Use margin, if supported and may be configured by broker API
    margin?: boolean;
    // Use futures, if possible
    futures?: boolean;
}

/**
 * Executed order data
 */
export interface ExecutedOrder extends OrderOptions {
    // Placed order identifier
    orderId: string;
    // How many lots are filled. May be not equal with lots field if order have partial fill
    executedLots: number;
    // Fees size
    commission: { currency: string; value: number };
    // Error code
    error?: number; // TODO: implement error codes
    // Processing indicator
    processing?: boolean;
}
