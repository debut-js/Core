import { TesterTransport } from './tester/tester-transport';
import { getBotData, BotData, getArgs } from '../utils/cli';
import { getHistory } from './tester/history';
import { DebutOptions, DebutMeta } from '../types/debut';
import { WorkingEnv } from '../types/common';

type Params = {
    bot: string;
    ticker: string;
    days?: number;
    ohlc?: boolean;
    gap?: number;
};

const args = getArgs() as Params;
const { bot, ticker, days = 1000, ohlc, gap = 0 } = args;
const schema: BotData | null = getBotData(bot);

(async function () {
    if (!schema) {
        process.stdout.write('Genetic CLI error: Incorrect configuration');
        return;
    }

    const { configs, meta } = schema;
    const cfg = configs[ticker];

    test(cfg, meta);
})();

async function test(cfg: DebutOptions, meta: DebutMeta) {
    try {
        const transport = new TesterTransport({ ohlc, comission: cfg.fee, broker: cfg.broker });
        const bot = await meta.create(transport, cfg, WorkingEnv.tester);
        // const logger = new TesterLogger(transport);

        if (!cfg) {
            process.stdout.write('Genetic CLI error: Put config in bot cfgs.ts file');
        }

        const { broker = 'tinkoff', ticker, interval } = cfg;
        let ticks = await getHistory({ broker, ticker, interval, days, gapDays: gap });

        if (meta.ticksFilter) {
            ticks = ticks.filter(meta.ticksFilter(cfg));
        }

        console.log('\n---- Tinkoff [' + cfg.ticker + '] ----\n');
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
