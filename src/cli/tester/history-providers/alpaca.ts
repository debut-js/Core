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

    // Alpaca Premium zone
    const fifteenMin = 900100; // 15 min + 100 ms
    const now = Date.now();
    const separateRequest = now - fifteenMin < to;
    let premiumBars = [];

    if (separateRequest) {
        to -= fifteenMin;

        try {
            const response = await getClient().getBars({
                symbol: ticker,
                start: new Date(to - fifteenMin + 60_000),
                end: new Date(to + fifteenMin),
                timeframe: convertTimeFrame(interval),
            });

            premiumBars = response.bars;
        } catch (e) {}
    }

    const response = await getClient().getBars({
        symbol: ticker,
        start: new Date(from),
        end: new Date(to),
        timeframe: convertTimeFrame(interval),
    });

    return [...response.bars, ...premiumBars].map(transformAlpacaCandle);
}
