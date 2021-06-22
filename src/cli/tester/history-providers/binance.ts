import { promise, file, date } from '@debut/plugin-utils';
import { TimeFrame, Candle } from '@debut/types';
import { convertTimeFrame } from '../../../transports/binance';
import { HistoryOptions, HistoryIntervalOptions } from '../history';

const DAY = 86400000;
export async function getHistoryIntervalBinance({ interval, ticker, start, end }: HistoryIntervalOptions) {
    const frameMin = convertTimeFrame(interval);
    const url = `https://api.binance.com/api/v1/klines?symbol=${ticker}&interval=${frameMin}&startTime=${start}&endTime=${end}&limit=720`;
    const result = await fetch(url).then((data) => data.json());
    return convertBinanceTicks(result);
}

export async function getHistoryFromBinance(options: HistoryOptions): Promise<Candle[]> {
    const { interval, ticker, days, gapDays } = options;
    const reqs = [];
    const now = new Date();
    const stamp = gapDays ? ~~(now.getTime() / DAY) * DAY : now.getTime();

    let end = stamp - DAY * gapDays;
    let from = ~~((end - DAY * days) / DAY) * DAY;
    let to = from;
    let chunkStart: number;
    let tries = 0;

    console.log(`Binance history loading from ${new Date(from).toString()}...`);
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

            await promise.sleep(Math.pow(2, tries) * 10_000);
        }
    }

    return [...result];
}

async function requestDay(from: number, to: number, ticker: string, interval: TimeFrame): Promise<Candle[]> {
    const frameMin = convertTimeFrame(interval);
    const path = getPath(ticker, interval, from, to);
    const historyFile = file.readFile(path);
    let candles: Candle[] = [];

    if (historyFile) {
        candles = JSON.parse(historyFile);
    } else {
        const middleDay = from + 12 * 60 * 60 * 1000 - 1000;
        const urlPart1 = `https://api.binance.com/api/v1/klines?symbol=${ticker}&interval=${frameMin}&startTime=${from}&endTime=${middleDay}&limit=720`;
        const urlPart2 = `https://api.binance.com/api/v1/klines?symbol=${ticker}&interval=${frameMin}&startTime=${middleDay}&endTime=${to}&limit=720`;
        const req1: Promise<[]> = fetch(urlPart1).then((res) => res.json());
        const req2: Promise<[]> = fetch(urlPart2).then((res) => res.json());
        const candles1 = (await req1) || [];
        const candles2 = (await req2) || [];

        if (!Array.isArray(candles2) || !Array.isArray(candles1)) {
            throw candles1['msg'] || candles2['msg'];
        }

        candles = convertBinanceTicks([...candles1, ...candles2]);

        if (!date.isSameDay(new Date(), new Date(from))) {
            saveDay(path, candles);
        }
    }

    return candles;
}

function saveDay(path: string, data: Candle[]) {
    file.ensureFile(path);
    file.saveFile(path, data);
}

function getPath(ticker: string, interval: TimeFrame, from: number, to: number) {
    return `history/binance/${ticker}/${interval}/${Math.floor(from / 100000)}-${Math.floor(to / 100000)}.json`;
}

async function collectCandles(reqs: Array<Promise<Candle[]>>) {
    const res = await Promise.all(reqs);

    let candles: Candle[] = [];

    res.forEach((data) => {
        if (!data) {
            console.log('missed data');
            return;
        }

        candles = candles.concat(data.filter(Boolean));
    });

    return candles;
}

function convertBinanceTicks(data: []) {
    const ticks: Candle[] = [];
    data.forEach((item) => {
        const tick: Candle = {
            time: item[0],
            o: parseFloat(item[1]),
            c: parseFloat(item[4]),
            h: parseFloat(item[2]),
            l: parseFloat(item[3]),
            v: parseFloat(item[5]),
        };

        if (tick.c) {
            ticks.push(tick);
        }
    });

    return ticks;
}
