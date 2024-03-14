import { cli, date } from '@debut/plugin-utils';
import { Candle, TimeFrame } from '@debut/types';
import { AlpacaClient, Bar } from '@master-chief/alpaca';
import { transformAlpacaCandle, convertTimeFrame, AlpacaTransportArgs } from '../../../transports/alpaca';

const tokens = cli.getTokens();
const { atoken = 'alpacaKey', asecret = 'alpacaSecret' } = cli.getArgs<AlpacaTransportArgs>();
const key = tokens[atoken];
const secret = tokens[asecret];
let client: AlpacaClient = null;

function getClient() {
    if (!client) {
        client = new AlpacaClient({ credentials: { key, secret } });
    }

    return client;
}

export async function requestAlpaca(from: number, to: number, ticker: string, interval: TimeFrame): Promise<Candle[]> {
    // Skip weekend history requests
    if (date.isWeekend(from)) {
        return Promise.resolve([]);
    }

    const response = await getClient().getBars({
        symbol: ticker,
        start: new Date(from),
        end: new Date(to),
        timeframe: convertTimeFrame(interval),
    });

    return [...response.bars].map(transformAlpacaCandle);
}
