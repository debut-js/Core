import { TimeFrame, Candle, InstrumentType } from '@debut/types';
import { convertTimeFrame } from '../../../transports/binance';
import { DebutError, ErrorEnvironment } from '../../../modules/error';
import { date } from '@debut/plugin-utils';

export function createRequestBinance(instrumentType: InstrumentType) {
    let endpoint = 'api.binance.com';
    let apiName = 'api';
    let apiVersion = 'v3';

    if (instrumentType === 'FUTURES') {
        endpoint = 'fapi.binance.com';
        apiName = 'fapi';
        apiVersion = 'v1';
    }

    const apiBase = `https://${endpoint}/${apiName}/${apiVersion}`;

    return async function requestBinance(
        from: number,
        to: number,
        ticker: string,
        interval: TimeFrame,
    ): Promise<Candle[]> {
        const frameMin = convertTimeFrame(interval);
        const middleDay = from + 12 * 60 * 60 * 1000 - 1000;
        const frameMs = date.intervalToMs(interval);
        // Eclude last candle from timeframe
        to = to - frameMs;

        const urlPart1 = `${apiBase}/klines?symbol=${ticker}&interval=${frameMin}&startTime=${from}&endTime=${middleDay}&limit=720`;
        const urlPart2 = `${apiBase}/klines?symbol=${ticker}&interval=${frameMin}&startTime=${middleDay}&endTime=${to}&limit=720`;
        const req1: Promise<[]> = fetch(urlPart1).then((res) => res.json());
        const req2: Promise<[]> = middleDay < to ? fetch(urlPart2).then((res) => res.json()) : Promise.resolve([]);
        const candles1 = (await req1) || [];
        const candles2 = (await req2) || [];

        if (!Array.isArray(candles2) || !Array.isArray(candles1)) {
            throw new DebutError(ErrorEnvironment.History, candles1['msg'] || candles2['msg']);
        }

        const result = convertBinanceTicks([...candles1, ...candles2]);

        const startMinutes = new Date(result[0].time).getMinutes();
        const endMinutes = new Date(result[result.length - 1].time).getMinutes();
        const expectedStartMinutes = 0;
        const expectedEndMinutes = 60 - frameMs;

        // Assert invalid dates
        if (expectedStartMinutes !== startMinutes || expectedEndMinutes !== endMinutes) {
            console.warn('Invalid history chunk, report to debut maintainer');
        }

        return result;
    };
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
