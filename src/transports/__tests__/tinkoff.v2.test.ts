import { TinkoffTransport } from '../tinkoff.v2';

function createTransport() {
    return new TinkoffTransportTest(process.env.TINKOFF_API_TOKEN);
}

class TinkoffTransportTest extends TinkoffTransport {
    getApi() {
        return this.api;
    }
}

test('constructor: empty token', async () => {
    const fn = () => new TinkoffTransport('');
    expect(fn).toThrow('token is incorrect');
});

test('getInstrument', async () => {
    const transport = createTransport();
    const instrument = await transport.getInstrument({
        broker: 'tinkoff',
        ticker: 'UBER',
        currency: 'usd',
        interval: '5min',
        amount: 1,
    });
    expect(instrument).toEqual({
        figi: 'BBG002B04MT8',
        ticker: 'UBER',
        id: 'UBER:undefined',
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
