import { date, file, promise } from '@debut/plugin-utils';
import { Candle, InstrumentType, TimeFrame } from '@debut/types';
import { SingleBar, Presets } from 'cli-progress';
import { DebutError, ErrorEnvironment } from '../../modules/error';
import { createRequestAlpaca } from './history-providers/alpaca';
import { createRequestBinance } from './history-providers/binance';
import { requestTinkoff } from './history-providers/tinkoff';
import { requestIB } from './history-providers/ib';

const DAY = 86400000;
export type RequestFn = (
    from: number,
    to: number,
    ticker: string,
    interval: TimeFrame,
    currency?: string,
) => Promise<Candle[]>;
export interface HistoryOptions {
    broker: 'tinkoff' | 'binance' | 'alpaca' | 'ib';
    ticker: string;
    instrumentType: InstrumentType;
    days: number;
    interval: TimeFrame;
    gapDays: number;
    noProgress?: boolean;
    currency?: string;
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
            requestFn = createRequestBinance(options.instrumentType);
            break;
        case 'alpaca':
            requestFn = createRequestAlpaca(options.instrumentType);
            break;
        case 'ib':
            requestFn = requestIB;

            break;
        default:
            throw new DebutError(ErrorEnvironment.History, `Broker ${options.broker} is not supported in debut`);
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
    const { ticker, days, interval, gapDays, broker, noProgress = false, instrumentType, currency } = options;
    const reqs = [];
    const now = new Date();
    const stamp = gapDays ? roundDay(now.getTime()) : now.getTime();

    if (!days) {
        throw new DebutError(ErrorEnvironment.History, 'History start date does not passed use `--days N`');
    }

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

    while (to < end) {
        try {
            to = Math.min(from + DAY, end);

            if (!chunkStart) {
                chunkStart = from;
            }

            reqs.push(createRequest(broker, ticker, interval, from, to, instrumentType, requestFn, currency));

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
            if (e instanceof DebutError && progress) {
                progress.stop();

                throw e;
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

    // Connection for days days should be validated
    // TODO: How to do this for another brokers? (known days start and end)
    // if (broker === 'binance') {
    //     strictSequenceAssert(interval, result);
    // }

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
    instrumentType: InstrumentType,
    requestFn: RequestFn,
    currency: string,
) {
    const validFrom = from / 100000;
    const validTo = to / 100000;
    const subfolder = instrumentType === 'FUTURES' ? '/futures/' : '';
    const path = `history/${broker}/${subfolder}${ticker}/${interval}/${validFrom}-${validTo}.txt`;
    const historyFile = file.readFile(path);

    if (validFrom !== ~~validFrom) {
        throw new DebutError(
            ErrorEnvironment.History,
            `Incorrect day request interval, 'from' should be start of day, from: ${from}`,
        );
    }

    let candles: Candle[] = [];

    if (historyFile) {
        candles = JSON.parse(historyFile);
    } else {
        candles = await requestFn(from, to, ticker, interval, currency);

        if (!date.isSameDay(new Date(), new Date(from))) {
            file.ensureFile(path);
            file.saveFile(path, candles);
        }
    }

    // TODO: How to do this for another brokers? (known days start and end)
    if (broker === 'binance') {
        strictSequenceAssert(interval, candles);
    }

    return candles;
}

export function strictSequenceAssert(interval: TimeFrame, candles: Candle[]) {
    const intervalMs = date.intervalToMs(interval);

    if (!candles.length) {
        return;
    }

    for (let i = 0; i < candles.length; i++) {
        const current = candles[i];
        const next = candles[i + 1];

        if (next && next.time !== current.time + intervalMs) {
            console.warn(
                ErrorEnvironment.History,
                'History contains invalid data sequence, please clean history for current ticker if error still exists plesae create github issue',
            );
        }
    }
}

export function daysConnectionAssert(interval: TimeFrame, lastDayCandle: Candle, nextDayCandle: Candle) {
    const intervalMs = date.intervalToMs(interval);

    if (lastDayCandle && nextDayCandle && lastDayCandle.time + intervalMs !== nextDayCandle.time) {
        throw new DebutError(
            ErrorEnvironment.History,
            'history days connection is invalid, please clean history for current ticker if error still exists plesae create github issue',
        );
    }
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
