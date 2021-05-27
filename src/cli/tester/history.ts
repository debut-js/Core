import { Candle, TimeFrame } from '@debut/types';
import { getTicksFromBinance, getTicksIntervalBinance } from './history-providers/binance';
import { getHistoryFromTinkoff, getHistoryIntervalTinkoff } from './history-providers/tinkoff';

export interface HistoryOptions {
    broker: 'tinkoff' | 'binance';
    ticker: string;
    days: number;
    interval: TimeFrame;
    gapDays: number;
}

export interface HistoryIntervalOptions {
    start: number;
    end: number;
    ticker: string;
    broker: string;
    interval: TimeFrame;
}

export async function getHistory(options: HistoryOptions): Promise<Candle[]> {
    switch (options.broker) {
        case 'tinkoff':
            return getHistoryFromTinkoff(options);
        case 'binance':
            return getTicksFromBinance(options);
    }
}

export async function getHistoryInterval(options: HistoryIntervalOptions) {
    switch (options.broker) {
        case 'tinkoff':
            return getHistoryIntervalTinkoff(options);
        case 'binance':
            return getTicksIntervalBinance(options);
    }
}
