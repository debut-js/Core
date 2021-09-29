import { TesterTransport } from './tester/tester-transport';
import { getHistory } from './tester/history';
import { cli } from '@debut/plugin-utils';
import { DebutMeta, DebutOptions, InstrumentType, WorkingEnv } from '@debut/types';

type Params = {
    bot: string;
    ticker: string;
    days?: number;
    ohlc?: boolean;
    gap?: number;
};

const args = cli.getArgs<Params>();
const { bot, ticker, days = 1000, ohlc, gap = 0 } = args;
const schema: cli.BotData | null = cli.getBotData(bot);

(async function () {
    if (!schema) {
        process.stdout.write('Genetic CLI error: Incorrect configuration');
        return;
    }

    const { configs, meta } = schema;
    const cfg = configs[ticker];

    test(cfg, meta);
})();

async function test(opts: DebutOptions, meta: DebutMeta) {
    try {
        const transport = new TesterTransport({ ohlc, broker: opts.broker, ticker: opts.ticker });
        const bot = await meta.create(transport, opts, WorkingEnv.tester);
        // const logger = new TesterLogger(transport);

        if (!opts) {
            process.stdout.write('Genetic CLI error: Put config in bot cfgs.ts file');
        }

        const { broker = 'tinkoff', ticker, interval, instrumentType } = opts;

        let ticks = await getHistory({
            broker,
            ticker,
            interval,
            days,
            gapDays: gap,
            instrumentType,
        });

        if (meta.ticksFilter) {
            ticks = ticks.filter(meta.ticksFilter(opts));
        }

        console.log('\n---- Tinkoff [' + opts.ticker + '] ----\n');
        console.log('Tested in ', ticks.length, ' candles...');
        transport.setTicks(ticks);
        await bot.start();
        await transport.run();
        await bot.closeAll();
        await bot.dispose();
        console.log(meta.stats(bot));
    } catch (e) {
        console.log(e);
    }
}
