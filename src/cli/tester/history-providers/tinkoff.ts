import { cli, date } from '@debut/plugin-utils';
import { TimeFrame } from '@debut/types';
import { TinkoffInvestApi } from 'tinkoff-invest-api';
import { findInstrumentByTicker, transformTinkoffCandle } from '../../../transports/tinkoff';
import { DebutError, ErrorEnvironment } from '../../../modules/error';
import { RequestFn } from '../history';
import { CandleInterval } from 'tinkoff-invest-api/cjs/generated/marketdata';

const tokens = cli.getTokens();
const token: string = tokens['tinkoff'];

let client: TinkoffInvestApi = null;
let figiCache: Map<string, string> = null;

function getClient() {
    if (!client) {
        figiCache = new Map();
        client = new TinkoffInvestApi({ token, appName: 'debut' });
    }

    return client;
}

async function getFigi(ticker: string) {
    if (!figiCache?.has(ticker)) {
        const { figi } = await findInstrumentByTicker(getClient(), ticker);
        figiCache.set(ticker, figi);
    }

    return figiCache.get(ticker);
}

export const requestTinkoff: RequestFn = async (from, to, ticker, interval) => {
    const figi = await getFigi(ticker);

    // Skip weekend history
    if (date.isWeekend(from)) {
        return [];
    }

    const { candles } = await getClient().marketdata.getCandles({
        from: new Date(from),
        to: new Date(to),
        figi,
        interval: transformTimeFrameToCandleInterval(interval),
    });

    return candles.map(transformTinkoffCandle);
};

function transformTimeFrameToCandleInterval(interval: TimeFrame): CandleInterval {
    switch (interval) {
        case '1min':
            return CandleInterval.CANDLE_INTERVAL_1_MIN;
        case '5min':
            return CandleInterval.CANDLE_INTERVAL_5_MIN;
        case '15min':
            return CandleInterval.CANDLE_INTERVAL_15_MIN;
        case '1h':
            return CandleInterval.CANDLE_INTERVAL_HOUR;
        case 'day':
            return CandleInterval.CANDLE_INTERVAL_DAY;
    }

    throw new DebutError(ErrorEnvironment.History, `Unsupported interval: ${interval}`);
}
