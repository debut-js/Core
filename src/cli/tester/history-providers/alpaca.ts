import { cli, date } from '@debut/plugin-utils';
import { Candle, InstrumentType, TimeFrame } from '@debut/types';
import Alpaca from '@alpacahq/alpaca-trade-api';
import {
    transformAlpacaCandle,
    convertTimeFrame,
    AlpacaTransportArgs,
    convertCryptoTicker,
} from '../../../transports/alpaca';

const tokens = cli.getTokens();
const { atoken = 'alpacaKey', asecret = 'alpacaSecret' } = cli.getArgs<AlpacaTransportArgs>();
const key = tokens[atoken];
const secret = tokens[asecret];
let client: Alpaca = null;
let feed = 'iex'; // or "sip" depending on your subscription

function getClient() {
    if (!client) {
        client = new Alpaca({
            keyId: key,
            secretKey: secret,
            feed,
        });
    }

    return client;
}

export function createRequestAlpaca(instrumentType: InstrumentType) {
    async function requestAlpacaStock(
        from: number,
        to: number,
        ticker: string,
        interval: TimeFrame,
    ): Promise<Candle[]> {
        // Skip weekend history requests
        if (date.isWeekend(from)) {
            return Promise.resolve([]);
        }

        const bars = [];
        const barsFeed = getClient().getBarsV2(ticker, {
            start: new Date(from),
            end: new Date(to),
            timeframe: convertTimeFrame(interval),
            feed,
        });

        for await (const b of barsFeed) {
            bars.push(transformAlpacaCandle(b));
        }

        return bars;
    }

    async function requestAlpacaCrypt(
        from: number,
        to: number,
        ticker: string,
        interval: TimeFrame,
        currency: string,
    ): Promise<Candle[]> {
        ticker = convertCryptoTicker(ticker, currency);

        const barsFeed = await getClient().getCryptoBars([ticker], {
            start: new Date(from),
            end: new Date(to),
            timeframe: convertTimeFrame(interval),
        });
        const bars = barsFeed.get(ticker);
        const debutBars = [];

        for (const bar of bars) {
            debutBars.push(transformAlpacaCandle(bar));
        }

        return debutBars;
    }

    return instrumentType === 'CRYPTO' ? requestAlpacaCrypt : requestAlpacaStock;
}
