import 'jest';
// Результат который должен получиться
import { result } from './fixtures/ticks.json';
// Свечи м15 от сервера
import { data } from './fixtures/candles.json';
// m1 Тики от сервера
import { mticks } from './fixtures/mticks.json';
import { Candle, CandleResolution, Candles } from '@tinkoff/invest-openapi-js-sdk';

describe('Tinkoff History Provider', () => {
    test('transformTicks m1', () => {
        const generatedTicks = transformTicks(mticks as Candle[], data as Candles, '15min', data.figi);

        generatedTicks.candles.forEach((genTick, idx) => {
            const mtick = result.candles[idx];

            expect(genTick.o).toEqual(mtick.o);
            expect(genTick.h).toEqual(mtick.h);
            expect(genTick.l).toEqual(mtick.l);
            expect(genTick.c).toEqual(mtick.c);
        });
    });
});

function intervalToMs(interval: CandleResolution) {
    let time = 0;

    switch (interval) {
        case '1min':
            time = 1;
            break;
        case '5min':
            time = 5;
            break;
        case '15min':
            time = 15;
            break;
        case '30min':
            time = 30;
            break;
        case 'hour':
            time = 60;
            break;
        case 'day':
            time = 24 * 60;
            break;
    }

    if (!time) {
        throw new Error('Unsupported interval');
    }

    return time * 60 * 1000;
}

export function transformTicks(mticks: Candle[], data: Candles, interval: CandleResolution, figi: string) {
    const candleSize = intervalToMs(interval);
    const result: Candles = { figi, interval, candles: [] };

    for (let i = 0; i < data.candles.length; i++) {
        const candle = data.candles[i];
        const candleTime = candle.time;
        const endTime = candleTime + candleSize;
        let temp: Candle;

        // Положим свечу открытия
        result.candles.push({ ...candle, h: candle.o, l: candle.o, c: candle.o, v: 1 });

        for (let j = 0; j < mticks.length; j++) {
            const mtick = mticks[j];
            const mtickTime = mtick.time;

            if (mtickTime >= candleTime && mtickTime < endTime) {
                // Обьединим тики в один, чтобы они знали high low друг друга
                if (!temp) {
                    temp = { ...mtick };
                } else {
                    temp.h = Math.max(mtick.h, temp.h);
                    temp.l = Math.min(mtick.l, temp.l);
                    mtick.l = temp.l;
                    mtick.h = temp.h;
                    mtick.o = temp.o;
                }

                mtick.time = candle.time;
                mtick.interval = candle.interval;

                result.candles.push(mtick);
            }

            // Срежем остаток
            if (mtickTime > endTime) {
                break;
            }
        }
    }

    return result;
}
