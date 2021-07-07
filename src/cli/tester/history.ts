import { date, file, promise } from '@debut/plugin-utils';
import { Candle, TimeFrame } from '@debut/types';
import { SingleBar, Presets } from 'cli-progress';
import { DebutError, ErrorEnvironment } from '../../modules/error';
import { requestAlpaca } from './history-providers/alpaca';
import { requestBinance } from './history-providers/binance';
import { requestTinkoff } from './history-providers/tinkoff';

const DAY = 86400000;
export type RequestFn = (from: number, to: number, ticker: string, interval: TimeFrame) => Promise<Candle[]>;
export interface HistoryOptions {
    broker: 'tinkoff' | 'binance' | 'alpaca';
    ticker: string;
    days: number;
    interval: TimeFrame;
    gapDays: number;
    noProgress?: boolean;
}

/**
 * Get history from different providers, depends on broker name in `HistoryOptions`
 */
export async function getHistory(options: HistoryOptions): Promise<Candle[]> {
    let requestFn: RequestFn;

    switch (options.broker) {
        case 'tinkoff':
            requestFn = requestTinkoff;
            break;
        case 'binance':
            requestFn = requestBinance;
            break;
        case 'alpaca':
            requestFn = requestAlpaca;
            break;
    }

    return createHistory(options, requestFn);
}

/**
 * Create history data, using current provider request function.
 * All history data will be stored in local cache file and than never been requested again.
 * Current history day will not be cached, because its not ended yet.
 * History validation is inside. If something is broken you will see error.
 */
async function createHistory(options: HistoryOptions, requestFn: RequestFn) {
    const { ticker, days, interval, gapDays, broker, noProgress = false } = options;
    const reqs = [];
    const now = new Date();
    const stamp = gapDays ? roundDay(now.getTime()) : now.getTime();

    let end = stamp - DAY * gapDays;
    let from = roundDay(end - DAY * days);
    let to = from;
    let chunkStart: number;
    let tries = 0;
    let result: Candle[] = [];
    let progressValue = 0;

    console.log(`History loading from [${broker}] ${new Date(from).toLocaleDateString()}:\n`);
    const progress = noProgress ? null : createProgress();
    progress?.start(days, 0);

    while (to <= end) {
        try {
            to = from + DAY;

            if (!chunkStart) {
                chunkStart = from;
            }

            reqs.push(createRequest(broker, ticker, interval, from, Math.min(to, end), requestFn));

            if (reqs.length === 50 || to >= end) {
                const data = await collectCandles(reqs);
                result = result.concat(data);

                reqs.length = 0;
                tries = 0;
                chunkStart = to;
            }

            progressValue++;
            progress?.update(progressValue);
            from = to;
        } catch (e: unknown | DebutError) {
            if (e instanceof DebutError) {
                return Promise.reject(e.message);
            }

            tries++;
            progressValue = Math.max(progressValue - reqs.length, 0);
            progress?.update(progressValue);
            reqs.length = 0;
            from = chunkStart;
            await promise.sleep(Math.pow(2, tries) * 10_000);
        }
    }

    progress?.update(days);
    progress?.stop();

    return result;
}

/**
 * Make a network or cache history request.
 */
async function createRequest(
    broker: string,
    ticker: string,
    interval: TimeFrame,
    from: number,
    to: number,
    requestFn: RequestFn,
) {
    const validFrom = from / 100000;
    const validTo = to / 100000;
    const path = `history/${broker}/${ticker}/${interval}/${validFrom}-${validTo}.txt`;
    const historyFile = file.readFile(path);

    if (validFrom !== ~~validFrom) {
        throw new DebutError(
            ErrorEnvironment.History,
            `Incorrect day request interval, 'from' should be start of day, from: ${from}`,
        );
    }

    if (historyFile) {
        return Promise.resolve(JSON.parse(historyFile));
    }

    const candles = await requestFn(from, to, ticker, interval);

    if (!date.isSameDay(new Date(), new Date(from))) {
        file.ensureFile(path);
        file.saveFile(path, candles);
    }

    return candles;
}

async function collectCandles(reqs: Array<Promise<Candle[]>>) {
    const res: Array<Candle[]> = await Promise.all(reqs);
    let result: Candle[] = [];

    res.forEach((candles) => {
        if (!candles) {
            console.log('missed data');
            return;
        }

        result = result.concat(candles.filter(Boolean));
    });

    return result;
}

export function createProgress(title: string = '') {
    return new SingleBar(
        {
            format: `${title} [{bar}] {percentage}% | {value} of {total} days`,
            stopOnComplete: true,
        },
        Presets.shades_grey,
    );
}

function roundDay(stamp: number) {
    return ~~(stamp / DAY) * DAY;
}

export function generateOHLC(candles: Candle[]) {
    const result: Candle[] = [];

    for (let i = 0; i < candles.length; i++) {
        const candle = candles[i];
        const volume = ~~(candle.v / 4);
        const openTick: Candle = { ...candle, h: candle.o, l: candle.o, c: candle.o, v: volume };
        let highTick: Candle = { ...openTick, h: candle.h, c: candle.h };
        let lowTick: Candle = { ...highTick, l: candle.l, c: candle.l };
        let closeTick: Candle = { ...lowTick, c: candle.c };
        const isBullishCandle = candle.o < candle.c;

        if (isBullishCandle) {
            lowTick = { ...openTick, l: candle.l, c: candle.l };
            highTick = { ...lowTick, h: candle.h, c: candle.h };
            closeTick = { ...highTick, c: candle.c };

            result.push(openTick, lowTick, highTick, closeTick);
        } else {
            result.push(openTick, highTick, lowTick, closeTick);
        }
    }

    return result;
}
