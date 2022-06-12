import { cli } from '@debut/plugin-utils';
import { DebutOptions, GenticWrapperOptions } from '@debut/types';
import { DebutError, ErrorEnvironment } from '../modules/error';
import { GeneticWrapper } from './tester/genetic';

type GeneticParams = {
    bot: string;
    ticker: string;
    log?: boolean;
    days?: number;
    amount?: number;
    gen?: number;
    pop?: number;
    ohlc?: boolean;
    gap?: number;
    best?: number;
    walkFwd?: 'aggressive' | 'conservative';
};

const args = cli.getArgs() as GeneticParams;
const { bot, ticker, log, amount = 500, days = 1000, gen = 12, pop = 2000, ohlc, gap = 0, best = 5, walkFwd } = args;
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

    const { configs, meta } = schema;
    const config: DebutOptions = { ...configs[ticker], ticker, amount: Number(amount) };
    const options: GenticWrapperOptions = {
        days,
        generations: gen,
        populationSize: pop,
        log,
        ohlc,
        gapDays: gap,
        validateSchema: meta.validate,
        validateForwardStats: meta.validateStats,
        score: meta.score,
        stats: meta.stats,
        create: meta.create,
        ticksFilter: meta.ticksFilter,
        best,
        walkFwd,
    };

    const genetic = new GeneticWrapper(options);
    let stats = await genetic.start(meta.parameters, config);

    stats = stats.map((item, index) => {
        item.config.id = index;
        return item;
    });

    console.log(stats);
})();
