import { cli } from '@debut/plugin-utils';
import { TinkoffTransport } from '../tinkoff';

const { tinkoff, tinkoffAccountId } = cli.getTokens();

function createTransport() {
    return new TinkoffTransportTest(tinkoff, tinkoffAccountId);
}

class TinkoffTransportTest extends TinkoffTransport {
    getApi() {
        return this.api;
    }
}

test('constructor: empty token/accountId', async () => {
    expect(() => new TinkoffTransport('', '123')).toThrow('token is incorrect');
    expect(() => new TinkoffTransport('123', '')).toThrow('accountId is empty');
});

test('getInstrument', async () => {
    const transport = createTransport();
    const instrument = await transport.getInstrument({
        broker: 'tinkoff',
        ticker: 'UBER',
        currency: 'usd',
        interval: '5min',
        amount: 1,
        instrumentType: 'SPOT',
    });
    expect(instrument).toEqual({
        figi: 'BBG002B04MT8',
        ticker: 'UBER',
        id: 'UBER:SPOT',
        lot: 1,
        lotPrecision: 1,
        minNotional: 0,
        minQuantity: 1,
        type: 'SPOT',
    });
});

test('prepareLots', () => {
    const transport = createTransport();
    const lots = transport.prepareLots(2.1);
    expect(lots).toEqual(2);
});

// test pass only when moex works
test('subscribeToTick', async () => {
    const transport = createTransport();
    try {
        let resolve;
        const promise = new Promise((_) => (resolve = _));
        const unsubscribe = await transport.subscribeToTick(
            {
                broker: 'tinkoff',
                ticker: 'SBER',
                currency: 'rub',
                interval: '1min',
                amount: 1,
                instrumentType: 'SPOT',
            },
            resolve,
        );
        const data = await promise;
        unsubscribe();
        expect(data).toHaveProperty('c');
        expect(data).toHaveProperty('time');
    } finally {
        transport.getApi().stream.market.cancel();
    }
});

test('subscribeOrderBook', async () => {
    const transport = createTransport();
    try {
        let resolve;
        const promise = new Promise((_) => (resolve = _));
        const unsubscribe = await transport.subscribeOrderBook(
            {
                broker: 'tinkoff',
                ticker: 'SBER',
                currency: 'rub',
                interval: '1min',
                amount: 1,
                instrumentType: 'SPOT',
            },
            resolve,
        );
        const data = await promise;
        unsubscribe();
        expect(data).toHaveProperty('bids');
        expect(data).toHaveProperty('asks');
    } finally {
        transport.getApi().stream.market.cancel();
    }
});

test.skip('placeOrder', async () => {});
