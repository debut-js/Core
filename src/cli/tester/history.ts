import { Candle, TimeFrame } from '@debut/types';
import { Presets, SingleBar } from 'cli-progress';
import { getHistoryFromAlpaca, getHistoryIntervalAlpaca } from './history-providers/alpaca';
import { getHistoryFromBinance, getHistoryIntervalBinance } from './history-providers/binance';
import { getHistoryFromTinkoff, getHistoryIntervalTinkoff } from './history-providers/tinkoff';

export interface HistoryOptions {
    broker: 'tinkoff' | 'binance' | 'alpaca';
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
            return getHistoryFromBinance(options);
        case 'alpaca':
            return getHistoryFromAlpaca(options);
    }
}

export async function getHistoryInterval(options: HistoryIntervalOptions) {
    switch (options.broker) {
        case 'tinkoff':
            return getHistoryIntervalTinkoff(options);
        case 'binance':
            return getHistoryIntervalBinance(options);
        case 'alpaca':
            return getHistoryIntervalAlpaca(options);
    }
}
