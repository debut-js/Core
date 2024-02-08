import { TimeFrame, Candle, InstrumentType } from '@debut/types';
import { convertTimeFrame } from '../../../transports/bybit';
import { DebutError, ErrorEnvironment } from '../../../modules/error';
import { date } from '@debut/plugin-utils';

interface MyResponse {
    result: {
        list: [];
    };
}

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
        const binanceFrame = convertTimeFrame(interval);
        const isSameDay = date.isSameDay(new Date(from), new Date());

        if (frameMin <= 60) {
            const middleDay = from + 12 * 60 * 60 * 1000 - 1000;

            /**
             * XXX Sometimes history crossing and this triggered validation asserts
             * history from should exclude 3:00 first of next day candles, exclude last day (current day) because
             * current day still not completed
             */
            if (!isSameDay) {
                to = to - frameMs;
            }

            const urlPart1 = `${apiBase}/market/kline?category=spot&symbol=${ticker}&interval=${binanceFrame}&start=${from}&end=${middleDay}&limit=720`;
            const urlPart2 = `${apiBase}/market/kline?category=spot&symbol=${ticker}&interval=${binanceFrame}&start=${middleDay}&end=${to}&limit=720`;
            const req1: Promise<[]> = fetch(urlPart1)
                .then((res) => res.json())
                .then((data: MyResponse) => data.result.list.sort((a, b) => a[0] - b[0]));
            const req2: Promise<[]> =
                middleDay < to
                    ? fetch(urlPart2)
                          .then((res) => res.json())
                          .then((data: MyResponse) => data.result.list.sort((a, b) => a[0] - b[0]))
                    : Promise.resolve([]);
            const candles1 = (await req1) || [];
            const candles2 = (await req2) || [];

            if (!Array.isArray(candles2) || !Array.isArray(candles1)) {
                throw new DebutError(ErrorEnvironment.History, candles1['msg'] || candles2['msg']);
            }

            return convertBybitTicks([...candles1, ...candles2]);
        } else {
            const url = `${apiBase}/market/kline?category=spot&symbol=${ticker}&interval=${binanceFrame}&start=${from}&end=${to}`;
            const req1: Promise<[]> = fetch(url)
                .then((res) => res.json())
                .then((data: MyResponse) => data.result.list.sort((a, b) => a[0] - b[0]));
            const candles1 = (await req1) || [];

            return convertBybitTicks(candles1);
        }
    };
}

function convertBybitTicks(data: []) {
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

// https://bybit-exchange.github.io/docs/v5/market/kline
// > list[0]: startTime	string	Start time of the candle (ms)
// > list[1]: openPrice	string	Open price
// > list[2]: highPrice	string	Highest price
// > list[3]: lowPrice	string	Lowest price
// > list[4]: closePrice	string	Close price. Is the last traded price when the candle is not closed
// > list[5]: volume	string	Trade volume. Unit of contract: pieces of contract. Unit of spot: quantity of coins
// > list[6]: turnover	string	Turnover. Unit of figure: quantity of quota coin

// v5
// "1706128200000",   0
// "38619.98",  o     1
// "38699.79",  h     2
// "38619.96",   l    3
// "38699.7",  c      4
// "0.176011",  v     5
// "6809.01243343"    6

// v3
// "t":1706128200000,
// "s":"BTCUSDT",
// "sn":"BTCUSDT",
// "c":"38699.78",
// "h":"38699.79",
// "l":"38619.96",
// "o":"38619.98",
// "v":"0.242449"
