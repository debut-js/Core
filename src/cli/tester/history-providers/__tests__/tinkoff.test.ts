import { requestTinkoff } from '../tinkoff';

test('requestTinkoff', async () => {
    const from = new Date('2022-06-08T07:00:00.000Z').getTime();
    const to = new Date('2022-06-08T07:10:00.000Z').getTime();
    const candles = await requestTinkoff(from, to, 'SBER', '1min');
    expect(candles).toHaveLength(10);
    expect(new Date(candles[0].time).toISOString()).toEqual('2022-06-08T07:00:00.000Z');
    expect(new Date(candles.slice(-1)[0].time).toISOString()).toEqual('2022-06-08T07:09:00.000Z');
});
