import { TimeFrame, Candle } from '@debut/types';
import { convertTimeFrame } from '../../../transports/binance';

export async function requestBinance(from: number, to: number, ticker: string, interval: TimeFrame): Promise<Candle[]> {
    const frameMin = convertTimeFrame(interval);

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

    return convertBinanceTicks([...candles1, ...candles2]);
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
