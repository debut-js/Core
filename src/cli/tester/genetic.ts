import { math } from '@debut/plugin-utils';
import {
    DebutOptions,
    GeneticSchema,
    GenticWrapperOptions,
    WorkingEnv,
    SchemaDescriptor,
    TestingPhase,
    DebutCore,
    InstrumentType,
} from '@debut/types';
import { Genetic, GeneticOptions, Phenotype, Select } from 'async-genetic';
import { getHistory } from './history';
import { TesterTransport } from './tester-transport';

interface ScoreData {
    before: number;
    after: number;
    main: number;
}
export class GeneticWrapper {
    private genetic: Genetic<DebutCore>;
    private transport: TesterTransport;
    private internalOptions: GeneticOptions<DebutCore>;
    private schema: GeneticSchema;
    private schemaKeys: string[];
    private configLookup: Map<string, unknown> = new Map();
    private deduplicateLookup = new Set<string>();
    private scoreLookup: Map<string, ScoreData> = new Map();
    private lastIteration = false;
    private baseOpts: DebutOptions;

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

        if (options.cross) {
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
                comission: opts.fee,
                broker: opts.broker,
                ticker: opts.ticker,
            });

            const { broker = 'tinkoff', ticker, interval, futures } = opts;
            const { days, gapDays } = this.options;
            const instrumentType = futures ? InstrumentType.FUTURES : InstrumentType.SPOT;

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

            this.transport.setTicks(ticks);
            await this.genetic.seed();

            for (let i = 0; i < this.options.generations; i++) {
                this.lastIteration = i === this.options.generations - 1;

                const now = Date.now();
                if (this.options.log) {
                    console.log('Generation: ', i);
                }

                if (this.options.cross) {
                    this.transport.createCrossValidation(this.options.cross, this.onPhase);
                }

                // Запускаем транспорт в режиме ожидания пока не подпишется вся популяция
                await this.transport.run(true);
                await this.genetic.estimate();

                this.genetic.population.forEach((pair) => {
                    pair.entity.dispose();
                });

                if (this.options.log) {
                    console.log('Generation time: ', (Date.now() - now) / 1000, 's');
                    console.log('Stats: ', this.genetic.stats);
                }

                this.transport.reset();
                // Если это последняя итерация дальше скрещивать не нужно
                if (!this.lastIteration) {
                    await this.genetic.breed();
                }

                this.deduplicateLookup.clear();
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
        const storedScore = (this.scoreLookup.get(hash) || {}) as ScoreData;

        if (storedScore.main === undefined) {
            storedScore.before = 0;
            storedScore.after = 0;

            const score = this.options.score(bot);
            const stats = this.options.stats(bot);

            storedScore.main = score;
            this.scoreLookup.set(hash, storedScore);
            this.configLookup.set(hash, stats);
        }

        return storedScore.main;
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

        if (!this.scoreLookup.has(hash)) {
            await bot.start();
        }

        return bot;
    }

    private onPhase = async (phase: TestingPhase) => {
        for (const pair of this.genetic.population) {
            const hash = pair.entity.id;
            const storedScore = (this.scoreLookup.get(hash) || {}) as ScoreData;

            if (storedScore.after !== undefined) {
                continue;
            }

            if (phase === TestingPhase.main) {
                await pair.entity.closeAll();
                const stats = this.options.stats(pair.entity);
                this.configLookup.set(hash, stats);
            }

            storedScore[phase] = this.options.score(pair.entity, phase);
            this.scoreLookup.set(hash, storedScore);
        }
    };

    private optimize = (a: Phenotype<DebutCore>, b: Phenotype<DebutCore>) => {
        const ascore = this.scoreLookup.get(a.entity.id);
        const bscore = this.scoreLookup.get(b.entity.id);

        const atotal = ascore.main + ascore.before || 0 * 1.5 + ascore.after || 0 * 2;
        const btotal = bscore.main + bscore.before || 0 * 1.5 + bscore.after || 0 * 2;

        return atotal >= btotal;
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
