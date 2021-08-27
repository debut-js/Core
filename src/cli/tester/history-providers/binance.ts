import { TimeFrame, Candle, InstrumentType } from '@debut/types';
import { convertTimeFrame } from '../../../transports/binance';
import { DebutError, ErrorEnvironment } from '../../../modules/error';

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
        const urlPart1 = `${apiBase}/klines?symbol=${ticker}&interval=${frameMin}&startTime=${from}&endTime=${middleDay}&limit=720`;
        const urlPart2 = `${apiBase}/klines?symbol=${ticker}&interval=${frameMin}&startTime=${middleDay}&endTime=${to}&limit=720`;
        const req1: Promise<[]> = fetch(urlPart1).then((res) => res.json());
        const req2: Promise<[]> = middleDay < to ? fetch(urlPart2).then((res) => res.json()) : Promise.resolve([]);
        const candles1 = (await req1) || [];
        const candles2 = (await req2) || [];

        if (!Array.isArray(candles2) || !Array.isArray(candles1)) {
            throw new DebutError(ErrorEnvironment.History, candles1['msg'] || candles2['msg']);
        }

        return convertBinanceTicks([...candles1, ...candles2]);
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
