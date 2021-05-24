import { GenticWrapperOptions, GeneticWrapper } from './tester/genetic';
import { getBotData, BotData, getArgs } from '../utils/cli';
import { ensureFile, readFile, saveFile } from '../utils/file';

type Params = {
    bot: string;
    ticker: string;
    log?: boolean;
    days?: number;
    gen?: number;
    pop?: number;
    ohlc?: boolean;
    gap?: number;
    amount?: number;
    crypt?: boolean;
};

const args = getArgs() as Params;

const { bot, ticker, log, amount = 10000, days = 1000, gen = 12, pop = 2000, ohlc, gap = 0, crypt } = args;
const schema: BotData | null = getBotData(bot);

(async function () {
    if (!schema) {
        process.stdout.write('Genetic CLI error: Incorrect configuration');
        return;
    }

    const options: GenticWrapperOptions = {
        score: schema.meta.score,
        stats: schema.meta.stats,
        ticksFilter: schema.meta.ticksFilter,
        validateSchema: schema.meta.validate,
        create: schema.meta.create,
        days,
        generations: gen,
        populationSize: pop,
        log,
        ohlc,
        gapDays: gap,
    };
    const { configs, meta } = schema;
    const cfgKeys = Object.keys(configs);
    const originCfg = configs[ticker || cfgKeys[0]];

    if (meta.validate) {
        options.validateSchema = meta.validate;
    }

    const stockPath = crypt ? 'crypt.json' : 'stocks.json';
    const stocks = JSON.parse(readFile(stockPath));
    const currentTicker = stocks.pop();

    if (!currentTicker) {
        return;
    }

    const genetic = new GeneticWrapper(options);
    const config = { ...originCfg, ticker: currentTicker, amount: Number(amount) };

    saveFile(stockPath, stocks);

    let stats = await genetic.start(meta.parameters, config);
    const path = `public/reports/${bot}/${config.interval}/tickers/${currentTicker}.json`;

    stats = stats
        .map((item, index) => {
            item.config.id = index;
            return item;
        })
        .filter((stat) => stat.stats);

    if (stats.length) {
        ensureFile(path);
        saveFile(path, stats);
    }
})();
