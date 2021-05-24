import { GenticWrapperOptions, GeneticWrapper } from './tester/genetic';
import { getBotData, BotData, getArgs } from '../utils/cli';
import { debutOptions } from '../types/debut';

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
};

const args = getArgs() as GeneticParams;
const { bot, ticker, log, amount = 10000, days = 1000, gen = 12, pop = 2000, ohlc, gap = 0, best = 5 } = args;

const schema: BotData | null = getBotData(bot);

(async function () {
    if (!schema) {
        process.stdout.write('Genetic CLI error: Incorrect configuration');
        return;
    }

    const { configs, meta } = schema;
    const config: debutOptions = { ...configs[ticker], ticker, amount: Number(amount) };
    const options: GenticWrapperOptions = {
        days,
        generations: gen,
        populationSize: pop,
        log,
        ohlc,
        gapDays: gap,
        validateSchema: meta.validate,
        score: meta.score,
        stats: meta.stats,
        create: meta.create,
        ticksFilter: meta.ticksFilter,
        best,
    };

    const genetic = new GeneticWrapper(options);
    let stats = await genetic.start(meta.parameters, config);

    stats = stats.map((item, index) => {
        item.config.id = index;
        return item;
    });

    console.log(stats);
})();
