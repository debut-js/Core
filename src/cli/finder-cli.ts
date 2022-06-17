import { cli, file } from '@debut/plugin-utils';
import { GeneticType, GeneticWFOType, GenticWrapperOptions } from '@debut/types';
import { DebutError, ErrorEnvironment } from '../modules/error';
import { GeneticWrapper } from './tester/genetic';

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
    wfo?: GeneticWFOType;
    gaType?: GeneticType;
    gaContinent?: boolean;
};

const args = cli.getArgs<Params>();
const {
    bot,
    ticker,
    log,
    amount = 10000,
    days = 1000,
    gen = 12,
    pop = 2000,
    ohlc,
    gap = 0,
    crypt,
    wfo,
    gaContinent,
    gaType,
} = args;
let schema: cli.BotData | null;

(async function () {
    try {
        schema = await cli.getBotData(bot);
    } catch (e) {
        throw new DebutError(ErrorEnvironment.Tester, `${e}`);
    }

    if (!schema) {
        process.stdout.write('Genetic CLI error: Incorrect configuration');
        return;
    }

    const options: GenticWrapperOptions = {
        score: schema.meta.score,
        stats: schema.meta.stats,
        ticksFilter: schema.meta.ticksFilter,
        validateSchema: schema.meta.validate,
        validateForwardStats: schema.meta.validateStats,
        create: schema.meta.create,
        days,
        generations: gen,
        populationSize: pop,
        log,
        ohlc,
        gapDays: gap,
        wfo,
        gaType,
        gaContinent,
    };
    const { configs, meta } = schema;
    const cfgKeys = Object.keys(configs);
    const originCfg = configs[ticker || cfgKeys[0]];

    if (meta.validate) {
        options.validateSchema = meta.validate;
    }

    const stockPath = crypt ? 'crypt.json' : 'stocks.json';
    const stocks = JSON.parse(file.readFile(stockPath));
    const currentTicker = stocks.pop();

    if (!currentTicker) {
        return;
    }

    const genetic = new GeneticWrapper(options);
    const config = { ...originCfg, ticker: currentTicker, amount: Number(amount) };

    file.saveFile(stockPath, stocks);

    let stats = await genetic.start(meta.parameters, config);
    const path = `public/reports/${bot}/${config.interval}/tickers/${currentTicker}.json`;

    stats = stats
        .map((item, index) => {
            item.config.id = index;
            return item;
        })
        .filter((stat) => stat.stats);

    if (stats.length) {
        file.ensureFile(path);
        file.saveFile(path, stats);
    }
})();
