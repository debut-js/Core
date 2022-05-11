import { TinkoffInvestApi } from 'tinkoff-invest-api';
import { InstrumentIdType } from 'tinkoff-invest-api/dist/generated/instruments';
import { convertTimeFrame, transformTinkoffCandle } from '../../../transports/tinkoff';
import { cli, date } from '@debut/plugin-utils';
import { TimeFrame } from '@debut/types';
import { RequestFn } from '../history';
import { GetCandlesRequest } from 'tinkoff-invest-api/dist/generated/marketdata';

const tokens = cli.getTokens();
const token: string = tokens['tinkoff'];

let client: TinkoffInvestApi = null;
let figiCache: Map<string, string> = null;

function getClient() {
    if (!client) {
        figiCache = new Map();
        client = new TinkoffInvestApi({ token });
    }

    return client;
}

async function getFigi(ticker: string) {
    if (!figiCache?.has(ticker)) {
        const { instrument } = await getClient().instruments.getInstrumentBy({
            id: ticker,
            classCode: 'SPBXM',
            idType: InstrumentIdType.INSTRUMENT_ID_TYPE_TICKER,
        });

        figiCache.set(ticker, instrument.figi);
    }

    return figiCache.get(ticker);
}

export const requestTinkoff: RequestFn = async (from: number, to: number, ticker: string, interval: TimeFrame) => {
    const figi = await getFigi(ticker);

    // Skip weekend history
    if (date.isWeekend(from)) {
        return Promise.resolve([]);
    }

    const payload: GetCandlesRequest = {
        from: new Date(from),
        to: new Date(to),
        figi,
        interval: convertTimeFrame(interval),
    };

    return getClient()
        .marketdata.getCandles(payload)
        .then((data) => data.candles.map(transformTinkoffCandle));
};
