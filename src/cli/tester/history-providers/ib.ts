import { date } from '@debut/plugin-utils';
import { Candle, TimeFrame } from '@debut/types';
import { EventName, Contract, SecType } from '@stoqey/ib';
import { DebutError, ErrorEnvironment } from '../../../modules/error';
import { IBTransport, convertIBTimeFrame, disposeClient, getClient } from '../../../transports/ib';

function createIBDate(timestamp: number) {
    const date = new Date(timestamp);

    let datePart = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
        .map((n, i) => n.toString().padStart(i === 0 ? 4 : 2, '0'))
        .join('');
    let timePart = [date.getHours(), date.getMinutes(), date.getSeconds()]
        .map((n, i) => n.toString().padStart(2, '0'))
        .join(':');

    return `${datePart} ${timePart} UTC`;
}

const correctionMaxInterval = date.intervalToMs('day');

export async function requestIB(
    from: number,
    to: number,
    ticker: string,
    interval: TimeFrame,
    currency: string,
): Promise<Candle[]> {
    // Skip weekend history requests
    if (date.isWeekend(from)) {
        return Promise.resolve([]);
    }

    const client = getClient();
    const contract: Contract = {
        symbol: ticker,
        exchange: IBTransport.exchange,
        secType: SecType.STK,
        currency,
    };

    const intervalMs = date.intervalToMs(interval);
    const candles: Candle[] = [];
    const sendReqId = IBTransport.getReqId();
    const result = new Promise<Candle[]>((resolve, reject) => {
        /**
         * Unsubscribe from history events
         */
        function unsubscribe() {
            client.off(EventName.historicalData, historyDataHandler);
        }

        /**
         * Create history data handler & transformer
         */
        function historyDataHandler(reqId: number, t: string, o: number, h: number, l: number, c: number, v: number) {
            let time = parseInt(t) * 1000;

            // Skip Another request
            if (reqId !== sendReqId) {
                return;
            }

            // Sequence ended
            if (o === -1 && c === -1 && h === -1 && l === -1) {
                resolve(candles);
                unsubscribe();
                disposeClient();
                return;
            }

            // Interval more that 30 minutes
            // Interval less than 1d
            if (
                intervalMs > 30 * 60 * 1000 &&
                intervalMs < correctionMaxInterval &&
                ~~((time % 86_400_000) % 3_600_000) === 0
            ) {
                // XXX: Hacky way to fix half hour part of candles more that 1H
                // Get minutes for not rounded hour
                time += 30 * 60 * 1000;
            }

            // Skip out of date range
            if (time < from || time > to) {
                return;
            }

            candles.push({ o, h, l, c, v, time });
        }

        client.on(EventName.historicalData, historyDataHandler);
        client.once(EventName.error, (error: Error) => {
            reject(error);
            unsubscribe();
            throw new DebutError(ErrorEnvironment.History, error.message);
        });
    });

    const ibEndDate = createIBDate(to);
    const ibInterval = convertIBTimeFrame(interval);

    client.reqHistoricalData(sendReqId, contract, ibEndDate, '86400 S', ibInterval, 'TRADES', 1, 2, false);

    return result;
}
