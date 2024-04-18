import { cli, date } from '@debut/plugin-utils';
import { Candle, TimeFrame } from '@debut/types';
import Alpaca from '@alpacahq/alpaca-trade-api';
import { transformAlpacaCandle, convertTimeFrame, AlpacaTransportArgs } from '../../../transports/alpaca';

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

export async function requestAlpaca(from: number, to: number, ticker: string, interval: TimeFrame): Promise<Candle[]> {
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

    try {
        for await (const b of barsFeed) {
            bars.push(transformAlpacaCandle(b));
        }
    } catch (e) {
        console.log(e);
    }

    return bars;
}
