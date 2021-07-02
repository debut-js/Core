import OpenAPI from '@tinkoff/invest-openapi-js-sdk';
import { convertTimeFrame, transformTinkoffCandle } from '../../../transports/tinkoff';
import { cli, date } from '@debut/plugin-utils';
import { TimeFrame } from '@debut/types';
import { RequestFn } from '../history';

const tokens = cli.getTokens();
const token: string = tokens['tinkoff'];
const apiURL = 'https://api-invest.tinkoff.ru/openapi';
const socketURL = 'wss://api-invest.tinkoff.ru/openapi/md/v1/md-openapi/ws';

let client: OpenAPI = null;
let figiCache: Map<string, string> = null;

function getClient() {
    if (!client) {
        figiCache = new Map();
        client = new OpenAPI({ apiURL, secretToken: token, socketURL });
    }

    return client;
}

async function getFigi(ticker: string) {
    if (!figiCache?.has(ticker)) {
        const { figi } = await getClient().searchOne({ ticker });
        figiCache.set(ticker, figi);
    }

    return figiCache.get(ticker);
}

export const requestTinkoff: RequestFn = async (from: number, to: number, ticker: string, interval: TimeFrame) => {
    const figi = await getFigi(ticker);

    // Skip weekend history
    if (date.isWeekend(from)) {
        return Promise.resolve([]);
    }

    const payload = {
        from: date.toIsoString(from),
        to: date.toIsoString(to),
        figi,
        interval: convertTimeFrame(interval),
    };
    const candles = await getClient()
        .candlesGet(payload)
        .then((data) => data.candles);

    const result = candles.map(transformTinkoffCandle);

    return result;
};
