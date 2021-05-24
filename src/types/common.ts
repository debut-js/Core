import { Candle } from './candle';

/**
 * Debut Timeframes
 */
export type TimeFrame = '1min' | '3min' | '5min' | '15min' | '30min' | '1h' | '2h' | '4h' | 'day' | 'week' | 'month';

/** Handler for tick or candle change */
export type TickHandler = (tick: Candle) => void;

/**
 * Debut environment values
 */
export const enum WorkingEnv {
    'genetic',
    'tester',
    'production',
}
