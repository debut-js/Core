import { TimeFrame, Candle, InstrumentType } from '@debut/types';
import { convertTimeFrame } from '../../../transports/bybit';
import { DebutError, ErrorEnvironment } from '../../../modules/error';
import { date } from '@debut/plugin-utils';
import { APIResponseV3WithTime, CategorySymbolListV5, KlineIntervalV3, OHLCVKlineV5 } from 'bybit-api';

type GetKlineResponseType = APIResponseV3WithTime<CategorySymbolListV5<OHLCVKlineV5[], 'spot' | 'linear' | 'inverse'>>;

export function createRequestBybit(instrumentType: InstrumentType) {
    let endpoint = 'api.bybit.com';
    let apiName = 'api';
    let apiVersion = 'v5';

    if (instrumentType === 'FUTURES') {
        // endpoint = 'fapi.binance.com';
        // apiName = 'fapi';
        // apiVersion = 'v1';
    }

    const apiBase = `https://${endpoint}/${apiVersion}`;

    return async function requestBybit(
        from: number,
        to: number,
        ticker: string,
        interval: TimeFrame,
    ): Promise<Candle[]> {
        const frameMs = date.intervalToMs(interval);
        const frameMin = frameMs / 1000 / 60;
        const binanceFrame: KlineIntervalV3 = convertTimeFrame(interval);
        const isSameDay = date.isSameDay(new Date(from), new Date());

        if (frameMin <= 60) {
            const middleDay = from + 12 * 60 * 60 * 1000 - 1000;

            /**
             * Sometimes there can be a duplicate of the same candle,
             * so common nu,ber of candles can be different for bybit and binances
             * example:
             * {time: 1707391800000, o: 2421.34, c: 2422.12, h: 2423.54, l: 2416.15, …}
             * ---> {time: 1707392700000, o: 2422.12, c: 2425.11, h: 2425.77, l: 2418.8, …}
             * ---> {time: 1707392700000, o: 2422.12, c: 2425.11, h: 2425.77, l: 2418.8, …}
             * {time: 1707393600000, o: 2425.11, c: 2424.98, h: 2429.5, l: 2424.23, …}
             */
            if (!isSameDay) {
                to = to - frameMs;
            }

            const urlPart1 = `${apiBase}/market/kline?category=spot&symbol=${ticker}&interval=${binanceFrame}&start=${from}&end=${middleDay}&limit=720`;
            const urlPart2 = `${apiBase}/market/kline?category=spot&symbol=${ticker}&interval=${binanceFrame}&start=${middleDay}&end=${to}&limit=720`;
            const req1: GetKlineResponseType = await fetch(urlPart1).then((res) => res.json());

            const req2: GetKlineResponseType =
                middleDay < to ? await fetch(urlPart2).then((res) => res.json()) : Promise.resolve([]);

            let candles1: [] | OHLCVKlineV5[] = [];
            let candles2: [] | OHLCVKlineV5[] = [];

            if (req1?.result?.list?.length) {
                candles1 = req1.result.list.sort((a: OHLCVKlineV5, b: OHLCVKlineV5) => +a[0] - +b[0]);
            }

            if (req2?.result?.list?.length) {
                candles2 = req2.result.list.sort((a: OHLCVKlineV5, b: OHLCVKlineV5) => +a[0] - +b[0]);
            }

            if (!Array.isArray(candles2) || !Array.isArray(candles1)) {
                throw new DebutError(ErrorEnvironment.History, candles1['msg'] || candles2['msg']);
            }

            return convertBybitTicks([...candles1, ...candles2]);
        } else {
            const url = `${apiBase}/market/kline?category=spot&symbol=${ticker}&interval=${binanceFrame}&start=${from}&end=${to}`;
            const req1: GetKlineResponseType = await fetch(url)
                .then((res) => res.json())
                .then((data) => data.result.list.sort((a: OHLCVKlineV5, b: OHLCVKlineV5) => +a[0] - +b[0]));

            let candles1: [] | OHLCVKlineV5[] = [];

            if (req1?.result?.list?.length) {
                candles1 = req1.result.list;
            }

            return convertBybitTicks(candles1);
        }
    };
}

function convertBybitTicks(data: OHLCVKlineV5[]) {
    const ticks: Candle[] = [];
    data.forEach((item) => {
        const tick: Candle = {
            time: +item[0],
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
