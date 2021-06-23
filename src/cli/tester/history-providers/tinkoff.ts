import OpenAPI from '@tinkoff/invest-openapi-js-sdk';
import { HistoryIntervalOptions, HistoryOptions } from '../history';
import { convertTimeFrame, transformTinkoffCandle } from '../../../transports/tinkoff';
import { cli, date, file } from '@debut/plugin-utils';
import { Candle, TimeFrame } from '@debut/types';
import { createProgress } from './utils';

const tokens = cli.getTokens();
const token: string = tokens['tinkoff'];
const apiURL = 'https://api-invest.tinkoff.ru/openapi';
const socketURL = 'wss://api-invest.tinkoff.ru/openapi/md/v1/md-openapi/ws';
const DAY = 86400000;

let client: OpenAPI = null;

function getClient() {
    if (!client) {
        client = new OpenAPI({ apiURL, secretToken: token, socketURL });
    }

    return client;
}

export async function getHistoryIntervalTinkoff({
    ticker,
    start,
    end,
    interval,
}: HistoryIntervalOptions): Promise<Candle[]> {
    const { figi } = await api.searchOne({ ticker });
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

            reqs.push(requestDay(from, Math.min(to, end), figi, ticker, interval));

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

export async function getHistoryFromTinkoff({ ticker, days, interval, gapDays }: HistoryOptions) {
    const reqs = [];
    const { figi } = await getClient().searchOne({ ticker });
    const now = new Date();
    const stamp = gapDays ? ~~(now.getTime() / DAY) * DAY : now.getTime();

    let end = stamp - DAY * gapDays;
    let from = ~~((end - DAY * days) / DAY) * DAY;
    let to = from;
    let chunkStart: number;
    let tries = 0;
    let result: Candle[] = [];
    let progressValue = 0;

    console.log(`History loading from ${new Date(from).toLocaleDateString()}:\n`);
    const progress = createProgress();
    progress.start(days, 0);

    while (to <= end) {
        try {
            to = from + DAY;

            if (!chunkStart) {
                chunkStart = from;
            }

            reqs.push(requestDay(from, Math.min(to, end), figi, ticker, interval));

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
            progressValue -= reqs.length;
            progress.update(progressValue);
            reqs.length = 0;
            from = chunkStart;
            await new Promise((resolve) => setTimeout(resolve, Math.pow(2, tries) * 10_000));
        }
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
    return `history/tinkoff/${ticker}/${interval}/${from / 100000}-${to / 100000}.txt`;
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

async function requestDay(
    from: number,
    to: number,
    figi: string,
    ticker: string,
    interval: TimeFrame,
): Promise<Candle[]> {
    // Не запрашиваем историю текущего дня
    if (date.isWeekend(from)) {
        return Promise.resolve([]);
    }

    const path = getPath(ticker, interval, from, to);
    const historyFile = file.readFile(path);

    if (historyFile) {
        return Promise.resolve(JSON.parse(historyFile));
    }

    const payload = {
        from: date.toIsoString(from),
        to: date.toIsoString(to),
        figi,
        interval: convertTimeFrame(interval),
    };
    const candles = await getClient()
        .candlesGet(payload)
        .then((data) => data.candles);

    const result = candles.map(transformTinkoffCandle);

    if (!date.isSameDay(new Date(), new Date(from))) {
        saveDay(path, result);
    }

    return result;
}
