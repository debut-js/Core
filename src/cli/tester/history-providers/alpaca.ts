import { HistoryIntervalOptions, HistoryOptions } from '../history';
import { cli, date, file } from '@debut/plugin-utils';
import { Candle, TimeFrame } from '@debut/types';
import { createProgress } from './utils';
import { AlpacaClient } from '@master-chief/alpaca';
import { transformAlpacaCandle, convertTimeFrame, AlpacaTransportArgs } from '../../../transports/alpaca';

const DAY = 86400000;
const tokens = cli.getTokens();
const { atoken = 'alpacaKey', asecret = 'alpacaSecret' } = cli.getArgs<AlpacaTransportArgs>();
const key = tokens[atoken];
const secret = tokens[asecret];
let client: AlpacaClient = null;

function getClient() {
    if (!client) {
        client = new AlpacaClient({ credentials: { key, secret } });
    }

    return client;
}

export async function getHistoryIntervalAlpaca({
    ticker,
    start,
    end,
    interval,
}: HistoryIntervalOptions): Promise<Candle[]> {
    const filterFrom = start;
    const filterTo = end;

    start = ~~(start / DAY) * DAY;
    end = ~~(end / DAY) * DAY;

    const reqs = [];
    let tries = 0;
    let from = start;
    let to = from;
    let chunkStart: number;
    let result: Candle[] = [];

    while (to <= end) {
        try {
            to = from + DAY;

            if (!chunkStart) {
                chunkStart = from;
            }

            reqs.push(requestDay(from, Math.min(to, end), ticker, interval));

            if (reqs.length === 50 || to >= end) {
                const data = await collectCandles(reqs);
                result = result.concat(data);

                reqs.length = 0;
                tries = 0;
                chunkStart = to;
            }

            from = to;
        } catch (e) {
            tries++;
            reqs.length = 0;
            from = chunkStart;
            await new Promise((resolve) => setTimeout(resolve, Math.pow(2, tries) * 10_000));
        }
    }

    return result.filter((candle) => candle.time >= filterFrom && candle.time <= filterTo);
}

export async function getHistoryFromAlpaca({ ticker, days, interval, gapDays }: HistoryOptions) {
    const reqs = [];
    const fifteenMin = 900100; // 15 min + 100 ms
    const now = new Date();
    const stamp = gapDays ? ~~(now.getTime() / DAY) * DAY : now.getTime();

    let end = stamp - DAY * gapDays;
    let from = ~~((end - DAY * days) / DAY) * DAY;
    let to = from;
    let chunkStart: number;
    let tries = 0;
    let result: Candle[] = [];
    let progressValue = 0;

    // alpaca premiun only has access to last 15min
    // ltes remove 15 min from end, if gapDays is 0
    // and try to get last 15 min in different request as is posiible optional
    if (!gapDays) {
        end -= fifteenMin;
    }

    console.log(`History loading from ${new Date(from).toLocaleDateString()}:\n`);
    const progress = createProgress();
    progress.start(days, 0);

    while (to <= end) {
        try {
            to = from + DAY;

            if (!chunkStart) {
                chunkStart = from;
            }

            // console.log(from, Math.min(to, end));
            reqs.push(requestDay(from, Math.min(to, end), ticker, interval));

            if (reqs.length === 50 || to >= end) {
                const data = await collectCandles(reqs);
                result = result.concat(data);

                reqs.length = 0;
                tries = 0;
                chunkStart = to;
            }

            progressValue++;
            progress.update(progressValue);
            from = to;
        } catch (e) {
            tries++;
            progressValue -= reqs.length - 1;
            progress.update(progressValue);
            reqs.length = 0;
            from = chunkStart;

            if (e.code || !e.code) {
                console.log(e.message);
                throw e;
            }

            await new Promise((resolve) => setTimeout(resolve, Math.pow(2, tries) * 10_000));
        }
    }

    // Premium zone
    if (!gapDays) {
        try {
            const req = requestDay(end - 1000, end + fifteenMin, ticker, interval);
            const data = await collectCandles([req]);
            result = result.concat(data);
        } catch (e) {}
    }

    progress.update(days);
    progress.stop();

    return result;
}

function saveDay(path: string, data: Candle[]) {
    file.ensureFile(path);
    file.saveFile(path, data);
}

function getPath(ticker: string, interval: TimeFrame, from: number, to: number) {
    return `history/alpaca/${ticker}/${interval}/${from / 100000}-${to / 100000}.txt`;
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

async function requestDay(from: number, to: number, ticker: string, interval: TimeFrame): Promise<Candle[]> {
    // Не запрашиваем историю текущего дня
    if (date.isWeekend(from)) {
        return Promise.resolve([]);
    }

    const path = getPath(ticker, interval, from, to);
    const historyFile = file.readFile(path);

    if (historyFile) {
        return Promise.resolve(JSON.parse(historyFile));
    }

    const candles = await getClient().getBars({
        symbol: ticker,
        start: new Date(from),
        end: new Date(to),
        timeframe: convertTimeFrame(interval),
    });

    const result = candles.bars.map(transformAlpacaCandle);

    if (!date.isSameDay(new Date(), new Date(from))) {
        saveDay(path, result);
    }

    return result;
}
