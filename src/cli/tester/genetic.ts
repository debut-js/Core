import { math } from '@debut/plugin-utils';
import {
    DebutOptions,
    GeneticSchema,
    GenticWrapperOptions,
    WorkingEnv,
    SchemaDescriptor,
    DebutCore,
} from '@debut/types';
import { Genetic, GeneticOptions, Phenotype, Select } from 'async-genetic';
import { getHistory } from './history';
import { TesterTransport } from './tester-transport';
import { Candle } from '@debut/types';

export class GeneticWrapper {
    private genetic: Genetic<DebutCore>;
    private transport: TesterTransport;
    private internalOptions: GeneticOptions<DebutCore>;
    private schema: GeneticSchema;
    private schemaKeys: string[];
    private configLookup: Map<string, unknown> = new Map();
    private deduplicateLookup = new Set<string>();
    private scoreLookup: Map<string, number> = new Map();
    private lastIteration = false;
    private baseOpts: DebutOptions;
    private forwardSegments: Array<Candle[][]> = [];

    constructor(private options: GenticWrapperOptions) {
        this.internalOptions = {
            randomFunction: this.getRandomSolution,
            fitnessFunction: this.fitness, // previously described to measure how good your solution is
            mutationFunction: this.mutate, // previously described to implement mutation
            crossoverFunction: this.crossover, // previously described to produce child solution by combining two parents
            populationSize: 100,
            select1: Select.FittestLinear,
            select2: Select.Tournament3,
            fittestNSurvives: 1,
            mutateProbablity: 0.3,
            crossoverProbablity: 0.6,
            deduplicate: this.deduplicate,
        };

        if (options.fwdGaps) {
            this.internalOptions.optimize = this.optimize;
        }

        this.genetic = new Genetic({ ...this.internalOptions, ...this.options });
    }

    async start(schema: GeneticSchema, opts: DebutOptions) {
        try {
            this.schema = schema;
            this.schemaKeys = Object.keys(schema);
            this.configLookup = new Map();
            this.baseOpts = opts;
            this.transport = new TesterTransport({
                ohlc: this.options.ohlc,
                broker: opts.broker,
                ticker: opts.ticker,
            });

            const { broker = 'tinkoff', ticker, interval, instrumentType } = opts;
            const { days, gapDays } = this.options;

            let ticks = await getHistory({
                broker,
                ticker,
                interval,
                days,
                gapDays,
                instrumentType,
            });

            if (this.options.ticksFilter) {
                ticks = ticks.filter(this.options.ticksFilter(opts));
            }

            if (this.options.log) {
                console.log(`\n----- Genetic Start with ${ticks.length} candles ----- \n`);
            }

            const segments = this.options.fwdGaps ? 4 : 1;
            const walkTestSize = this.options.fwdGaps ? 0.25 : 0;

            this.forwardSegments = crateForwardGaps(ticks, segments, walkTestSize);
            await this.genetic.seed();

            for (let k = 0; k < this.forwardSegments.length; k++) {
                const [backtest, walkTest] = this.forwardSegments[k];

                for (let i = 0; i < this.options.generations; i++) {
                    this.transport.setTicks(backtest);

                    await this.subscribePopulation();

                    this.lastIteration = i === this.options.generations - 1;

                    const now = Date.now();

                    if (this.options.log) {
                        console.log('Generation: ', i);
                    }

                    await this.transport.run();
                    await this.genetic.estimate();

                    if (this.options.log) {
                        console.log('Generation time: ', (Date.now() - now) / 1000, 's');
                        console.log('Stats: ', this.genetic.stats);
                    }

                    await this.disposePopulation();

                    // Если это последняя итерация дальше скрещивать не нужно
                    if (!this.lastIteration) {
                        this.transport.reset();
                        await this.genetic.breed();
                    }

                    this.deduplicateLookup.clear();
                }

                if (walkTest?.length > 0) {
                    console.log('Walk forward test started');

                    this.transport.reset();
                    this.scoreLookup.clear();
                    this.transport.setTicks(walkTest);

                    await this.subscribePopulation();
                    await this.transport.run();
                    await this.genetic.estimate();

                    this.genetic.population = this.genetic.population.filter((item) => {
                        const score = this.scoreLookup.get(item.entity.id);

                        return score && score > 0;
                    });

                    console.log('Population after walk forward test:', this.genetic.population.length);
                }
            }

            return this.genetic
                .best(this.options.best || 30)
                .reverse()
                .map((bot) => ({ config: bot.opts, stats: this.configLookup.get(bot.id) }));
        } catch (e) {
            console.log(e);

            return [];
        }
    }

    private async subscribePopulation() {
        for (let i = 0; i < this.genetic.population.length; i++) {
            const pair = this.genetic.population[i];

            if (!this.scoreLookup.has(pair.entity.id)) {
                await pair.entity.start();
            }
        }
    }

    private async disposePopulation() {
        for (let i = 0; i < this.genetic.population.length; i++) {
            const pair = this.genetic.population[i];

            await pair.entity.dispose();
        }
    }

    private getRandomSolution = async () => {
        const config = { ...this.baseOpts };

        this.schemaKeys.forEach((key) => {
            config[key] = getRandomByRange(this.schema[key]);
        });

        if (this.options.validateSchema(config)) {
            return this.createBot(config);
        }

        return this.getRandomSolution();
    };

    private fitness = async (bot: DebutCore) => {
        const hash = bot.id;
        let storedScore = this.scoreLookup.get(hash);

        if (!storedScore) {
            const stats = this.options.stats(bot);
            const score = this.options.score(bot);

            storedScore = score;

            this.scoreLookup.set(hash, storedScore);
            this.configLookup.set(hash, stats);
        }

        return storedScore;
    };

    private mutate = async (bot: DebutCore) => {
        const config = { ...bot.opts };

        if (Math.random() < 0.3) {
            this.schemaKeys.forEach((key) => {
                if (key in this.schema) {
                    config[key] = getRandomByRange(this.schema[key]);
                }
            });
        }

        if (this.options.validateSchema(config)) {
            return this.createBot(config);
        }

        return this.mutate(bot);
    };

    private crossover = async (mother: DebutCore, father: DebutCore, i = 0) => {
        // two-point crossover
        const sonConfig: DebutOptions = { ...father.opts };
        const daughterConfig: DebutOptions = { ...mother.opts };

        this.schemaKeys.forEach((key: string) => {
            const source1 = Math.random() > 0.5 ? mother.opts : father.opts;
            const source2 = Math.random() > 0.5 ? father.opts : mother.opts;

            sonConfig[key] = source1[key];
            daughterConfig[key] = source2[key];
        });

        if (i >= 10 || (this.options.validateSchema(sonConfig) && this.options.validateSchema(daughterConfig))) {
            return [await this.createBot(sonConfig), await this.createBot(daughterConfig)];
        }

        return this.crossover(mother, father, ++i);
    };

    private deduplicate = (bot: DebutCore) => {
        const hash = bot.id;

        if (this.deduplicateLookup.has(hash)) {
            bot.dispose();
            return false;
        }

        this.deduplicateLookup.add(hash);

        return true;
    };

    private async createBot(config: DebutOptions) {
        const hash = JSON.stringify(config, Object.keys(config).sort());
        const bot = await this.options.create(this.transport, config, WorkingEnv.genetic);
        bot.id = hash;

        return bot;
    }

    private optimize = (a: Phenotype<DebutCore>, b: Phenotype<DebutCore>) => {
        const ascore = this.scoreLookup.get(a.entity.id);
        const bscore = this.scoreLookup.get(b.entity.id);

        return ascore >= bscore;
    };
}

function getRandomByRange(range: SchemaDescriptor) {
    let randomValue: number | boolean;

    if ('bool' in range) {
        randomValue = Math.random() > 0.5;
    } else if (range.int) {
        randomValue = math.getRandomInt(range.min, range.max, range.odd);
    } else {
        randomValue = math.getRandomArbitrary(range.min, range.max, range.odd);
    }

    return randomValue;
}
/**
 * @experimental Function for cross validating with formward testing on history
 */
function crateForwardGaps(ticks: Candle[], segments = 4, fwd = 0.25) {
    const totalSize = ticks.length;
    const fwdSize = Math.round((totalSize / segments) * fwd);
    const intervalSize = Math.round(totalSize / segments);
    const pairs: Array<Candle[][]> = [];

    let startPos = 0;
    let endPos = intervalSize;

    for (let i = 0; i < segments; i++) {
        const pair = [ticks.slice(startPos, endPos - fwdSize), ticks.slice(endPos - fwdSize, endPos)];

        startPos += fwdSize;
        endPos += fwdSize;

        pairs.push(pair);
    }

    return pairs;
}
