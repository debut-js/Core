import OpenAPI, { CandleResolution } from '@tinkoff/invest-openapi-js-sdk';
import { Candle } from '../../../types/candle';
import { TimeFrame } from '../../../types/common';
import { isSameDay, isWeekend, toIsoString } from '../../../utils/date';
import { ensureFile, readFile, saveFile } from '../../../utils/file';
import { HistoryIntervalOptions, HistoryOptions } from '../history';

const tokens = JSON.parse(readFile(`${process.cwd()}/.tokens.json`));
const token: string = tokens['tinkoff'];
const apiURL = 'https://api-invest.tinkoff.ru/openapi';
const socketURL = 'wss://api-invest.tinkoff.ru/openapi/md/v1/md-openapi/ws';
const date = new Date();
const api = new OpenAPI({ apiURL, secretToken: token, socketURL });

export async function getHistoryIntervalTinkoff({
    ticker,
    start,
    end,
    interval,
}: HistoryIntervalOptions): Promise<Candle[]> {
    const { figi } = await api.searchOne({ ticker });

    const candles = await api
        .candlesGet({ figi, from: toIsoString(start), to: toIsoString(end), interval: convertTimeFrame(interval) })
        .then((data) => data.candles);

    return candles.map((candle) => {
        return { ...candle, interval } as Candle;
    });
}

export async function getHistoryFromTinkoff({ ticker, days, interval, gapDays }: HistoryOptions) {
    const reqs = [];
    const { figi } = await api.searchOne({ ticker });

    date.setMinutes(0);
    date.setHours(0);
    date.setSeconds(0);
    date.setMilliseconds(0);

    const end = date.getTime() - 86400 * 1000 * gapDays;
    let from: number = new Date(end - 86400 * 1000 * days).getTime();
    let to = from;
    let chunks = 1;
    let chunkStart: number;
    let tries = 0;

    console.log(`Tinkoff history loading from ${new Date(from).toLocaleString()}...`);

    let result: Candle[] = [];

    while (to <= end) {
        try {
            to = from + 86400 * 1000;

            if (!chunkStart) {
                chunkStart = from;
            }

            const promise: Promise<Candle[]> = requestDay(from, to, figi, ticker, interval);

            reqs.push(promise);

            if (reqs.length === 50 || to >= end) {
                chunks++;
                const data = await collectCandles(reqs);
                result = result.concat(data);

                reqs.length = 0;
                tries = 0;
                chunkStart = to;
            }

            from = to;
        } catch (e) {
            tries++;
            chunks--; // TODO Сделать вывод % загрузки истории
            reqs.length = 0;
            from = chunkStart;
            await new Promise((resolve) => setTimeout(resolve, Math.pow(2, tries) * 10_000));
        }
    }

    return result;
}

function saveDay(path: string, data: Candle[]) {
    ensureFile(path);
    saveFile(path, data);
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
    if (isWeekend(from)) {
        return Promise.resolve([]);
    }

    const path = getPath(ticker, interval, from, to);
    const file = readFile(path);

    if (file) {
        return Promise.resolve(JSON.parse(file));
    }

    const payload = { from: toIsoString(from), to: toIsoString(to), figi, interval: convertTimeFrame(interval) };
    const candles = await api.candlesGet(payload).then((data) => data.candles);

    const result = candles.map((candle) => {
        return { ...candle, interval } as Candle;
    });

    if (!isSameDay(new Date(), new Date(from))) {
        saveDay(path, result);
    }

    return result;
}

export function convertTimeFrame(interval: TimeFrame): CandleResolution {
    switch (interval) {
        case '1min':
            return '1min';
        case '5min':
            return '5min';
        case '15min':
            return '15min';
        case '30min':
            return '30min';
        case '1h':
            return 'hour';
        case 'day':
            return 'day';
    }

    throw new Error('Unsupported interval');
}
