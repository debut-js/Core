import { TickHandler, TimeFrame } from './common';
import { ExecutedOrder, OrderOptions } from './order';

/**
 * Base transport interface for different brokers support
 */
export interface BaseTransport {
    // Add listener to every tick in real market or market emulation
    subscribeToTick(ticker: string, handler: TickHandler, interval?: TimeFrame): Promise<() => void>;
    // Place order with customized parameters
    placeOrder(order: OrderOptions): Promise<ExecutedOrder>;
    // Place sandbox order. Order will be executed locally immediate, without sending to broker
    placeSandboxOrder(order: OrderOptions): Promise<ExecutedOrder>;
    // Get instrument meta information
    getInstrument(ticker: string): Promise<Instrument>;
    // Prepare lots for broker
    prepareLots(lots: number, ticker: string): number;
}

/**
 * Debut trading instrument information
 */
export interface Instrument {
    // Broker instrument ID (if exists)
    figi?: string;
    // Ticker
    ticker: string;
    // Minimal price change (pip size)
    pipSize?: number;
    // One lot size
    lot: number;
    // Number of digits of a lot number
    lotPrecision: number;
}
