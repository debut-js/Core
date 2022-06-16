import { math } from '@debut/plugin-utils';
import {
    DebutOptions,
    GeneticSchema,
    GenticWrapperOptions,
    WorkingEnv,
    SchemaDescriptor,
    DebutCore,
    GeneticWFOType,
    GeneticType,
} from '@debut/types';
import {
    Genetic,
    GeneticOptions,
    Select,
    IslandGeneticModel,
    IslandGeneticModelOptions,
    MigrateSelec,
} from 'async-genetic';
import { getHistory } from './history';
import { TesterTransport } from './tester-transport';
import { Candle } from '@debut/types';

// MRI - Max Recursion Iterations
const MRI = 10;

/**
 * Genetic allorithms class, it's wrapper for Debut strategies optimize
 */
export class GeneticWrapper {
    private genetic: IslandGeneticModel<DebutCore> | Genetic<DebutCore>;
    private transport: TesterTransport;
    private internalOptions: GeneticOptions<DebutCore>;
    private schema: GeneticSchema;
    private schemaKeys: string[];
    private deduplicateLookup = new Set<string>();
    private baseOpts: DebutOptions;

    constructor(private options: GenticWrapperOptions) {
        this.internalOptions = {
            randomFunction: this.getRandomSolution,
            fitnessFunction: this.fitness, // previously described to measure how good your solution is
            mutationFunction: this.mutate, // previously described to implement mutation
            crossoverFunction: this.crossover, // previously described to produce child solution by combining two parents
            populationSize: 100,
            select1: Select.FittestLinear,
            select2: Select.RandomLinearRank,
            fittestNSurvives: 2,
            mutateProbablity: 0.3,
            crossoverProbablity: 0.6,
            deduplicate: this.deduplicate,
        };

        const ilandOptions: IslandGeneticModelOptions<DebutCore> = {
            islandCount: options.populationSize * 0.01,
            islandMutationProbability: 0.8,
            islandCrossoverProbability: 0.8,
            migrationProbability: 0.1,
            migrationFunction: MigrateSelec.FittestLinear,
        };

        if (this.options.gaType === GeneticType.Island) {
            this.genetic = new IslandGeneticModel(ilandOptions, { ...this.internalOptions, ...this.options });
        } else {
            this.genetic = new Genetic<DebutCore>({ ...this.internalOptions, ...this.options });
        }

        if (!options.validateSchema) {
            options.validateSchema = (cfg: DebutOptions) => cfg;
        }

        if (!options.validateForwardStats) {
            options.validateForwardStats = () => true;
        }
    }

    /**
     * Start genetic optimization cycle
     * @param schema - optimization schema for current strategy
     * @param opts - base strategy options for initialize
     * @returns - best N (by default 30) variants of configuration for current strategy
     */
    async start(schema: GeneticSchema, opts: DebutOptions) {
        const { days, gapDays, wfo, best, ticksFilter, ohlc, gaContinent, gaType } = this.options;
        const { broker = 'tinkoff', ticker, interval, instrumentType } = opts;

        this.schema = schema;
        this.schemaKeys = Object.keys(schema);
        this.baseOpts = opts;
        this.transport = new TesterTransport({
            ohlc: ohlc,
            broker: opts.broker,
            ticker: opts.ticker,
        });

        let ticks = await getHistory({
            broker,
            ticker,
            interval,
            days,
            gapDays,
            instrumentType,
        });

        if (ticksFilter) {
            ticks = ticks.filter(ticksFilter(opts));
        }

        const optimisation = wfo ? 'Walk-Forward' : 'None';
        const optimisationType = wfo ? (wfo === GeneticWFOType.Rolling ? '(Rolling)' : '(Classic)') : '';
        const gaMode = gaType === GeneticType.Island ? 'Islands' : 'Classic';
        const gaExtra = gaType === GeneticType.Island && gaContinent ? '+ Continent' : '';

        console.log(`\nOptimisation: ${optimisation} ${optimisationType}`);
        console.log(`\nGenetic Mode: ${gaMode} ${gaExtra}`);
        console.log(`\nTicks count: ${ticks.length}`);

        if (wfo) {
            await this.wfoGenetic(ticks, wfo);
        } else {
            await this.pureGenetic(ticks);
        }

        return this.genetic
            .best(best || 30)
            .reverse()
            .map((ph) => ({ config: ph.entity.opts, stats: ph.state }));
    }

    /**
     * Subscribe all strategies to transport for next transport ticks listening
     */
    private async subscribePopulation() {
        const population = this.genetic.population;

        for (let i = 0; i < population.length; i++) {
            const pair = population[i];

            await pair.entity.start();
        }
    }

    /**
     * Destroy strategy listeners in transport, off tick listeners and call destructor in strategy (dispose method)
     */
    private async disposePopulation() {
        this.transport.reset();

        const population = this.genetic.population;

        for (let i = 0; i < population.length; i++) {
            const pair = population[i];

            await pair.entity.dispose();
        }
    }

    /**
     * Get random generated config for strategy
     */
    private getRandomSolution = async (i: number = 0) => {
        const config = { ...this.baseOpts };

        this.schemaKeys.forEach((key) => {
            config[key] = getRandomByRange(this.schema[key]);
        });

        // Prevent recursion infinite loop and check validity
        if (i >= MRI || this.options.validateSchema(config)) {
            return this.createBot(config);
        }

        return this.getRandomSolution();
    };

    /**
     * Estimate strategy, more fitness score mean strategy is good, less mean strategy bad
     */
    private fitness = async (bot: DebutCore) => {
        const stats = this.options.stats(bot) as Record<string, unknown>;
        const score = this.options.score(bot);

        return { state: stats, fitness: score };
    };

    /**
     * Mutate configurations (self reproducing with mutations or not, depends on mutation probability)
     */
    private mutate = async (bot: DebutCore, i: number = 0) => {
        const config = { ...bot.opts };

        this.schemaKeys.forEach((key) => {
            if (key in this.schema) {
                config[key] = getRandomByRange(this.schema[key]);
            }
        });

        // Prevent recursion calls for validation
        if (i >= MRI || this.options.validateSchema(config)) {
            return this.createBot(config);
        }

        return this.mutate(bot, ++i);
    };

    /**
     * Crossover for two selected cofigurations of strategies
     * @param mother - first selected strategy
     * @param father - second selectedd strategy
     * @param i - deep recursion calls counter
     * @returns return two new strategy configuration as childs of current parents
     */
    private crossover = async (mother: DebutCore, father: DebutCore, i: number = 0) => {
        const sonConfig: DebutOptions = { ...father.opts };
        const daughterConfig: DebutOptions = { ...mother.opts };

        this.schemaKeys.forEach((key: string) => {
            const source1 = Math.random() > 0.5 ? mother.opts : father.opts;
            const source2 = Math.random() > 0.5 ? father.opts : mother.opts;

            sonConfig[key] = source1[key];
            daughterConfig[key] = source2[key];
        });

        // Infinite recursion preventing and validation checks
        if (i >= MRI || (this.options.validateSchema(sonConfig) && this.options.validateSchema(daughterConfig))) {
            return [await this.createBot(sonConfig), await this.createBot(daughterConfig)];
        }

        return this.crossover(mother, father, ++i);
    };

    /**
     * Create duplications hashmap for remove same configurations from populations
     * @param bot - strategy
     * @returns true when unique false when duplicate and removed
     */
    private deduplicate = (bot: DebutCore) => {
        const hash = bot.id;

        if (this.deduplicateLookup.has(hash)) {
            bot.dispose();
            return false;
        }

        this.deduplicateLookup.add(hash);

        return true;
    };

    /**
     * Create strategy from options and assign strategy id based on options hash funtion
     * @param config - strategy options
     * @returns strategy
     */
    private async createBot(config: DebutOptions) {
        const hash = JSON.stringify(config, Object.keys(config).sort());
        const bot = await this.options.create(this.transport, config, WorkingEnv.genetic);
        bot.id = hash;

        return bot;
    }

    /**
     * Classig genetical algorithm
     * @param ticks - candles for backtesting
     * @param breedLast - should breed last generation
     */
    private async pureGenetic(ticks: Candle[], breedLast?: boolean) {
        const { generations, gaContinent } = this.options;
        let continentalGenerationsLeft = 0;

        await this.genetic.seed();

        for (let i = 0; i < generations; i++) {
            const lastGeneration = i === generations - 1;
            const now = Date.now();

            this.transport.setTicks(ticks);

            await this.subscribePopulation();
            await this.transport.run();
            await this.disposePopulation();

            // Each 10 generation next 5 generations would be on continent
            if (i !== 0 && i % 15 === 0 && this.genetic instanceof IslandGeneticModel) {
                continentalGenerationsLeft = 5;
                // Move to continent
                this.genetic.moveAllToContinent();
            }

            const postfix = gaContinent ? (continentalGenerationsLeft !== 0 ? '(Continent)' : '(Ilands)') : '';
            console.log(`Generation ${postfix}`, i);

            if (gaContinent && continentalGenerationsLeft !== 0 && this.genetic instanceof IslandGeneticModel) {
                continentalGenerationsLeft--;

                await this.genetic.continentalEstimate();

                if (!lastGeneration || breedLast) {
                    await this.genetic.continentalBreed();
                }

                if (continentalGenerationsLeft === 0) {
                    // Move to ilands
                    this.genetic.migrateToIslands();
                }
            } else {
                await this.genetic.estimate();

                if (!lastGeneration || breedLast) {
                    await this.genetic.breed();
                }
            }

            console.log('Generation time: ', (Date.now() - now) / 1000, 's');
            console.log('Stats: ', this.genetic.stats);
        }
    }

    /**
     * Walk Forward optimisation around classic genetic algorithm
     * @param ticks - total ticks for generate backtesting and forward testing sequences
     * @param type - kind of optimisation, rolling or anchored
     */
    private async wfoGenetic(ticks: Candle[], type: GeneticWFOType) {
        const forwardSegments: Array<Candle[][]> = crateWFOSegmentation(ticks, 10, type);
        await this.genetic.seed();

        for (let k = 0; k < forwardSegments.length; k++) {
            const [backtest, walkTest] = forwardSegments[k];
            const lastSegment = k === forwardSegments.length - 1;

            this.deduplicateLookup.clear();

            console.log(
                `\nCandles count for each test segment is: ${backtest.length} - backtest, ${walkTest.length} - forward test`,
            );

            // Breed last generation as well
            await this.pureGenetic(backtest, true);
            await this.subscribePopulation();

            // At last segment estimate all entities at full time and generate report
            if (lastSegment) {
                console.log('Walk forward final estimation started');
                await this.test(ticks);
            } else {
                console.log('Walk forward test started');
                await this.test(walkTest);
                await this.genetic.breed();
            }
        }
    }

    /**
     * Test population in custom period
     */
    private async test(walkTest: Candle[]) {
        await this.subscribePopulation();

        this.transport.setTicks(walkTest);

        await this.transport.run();
        await this.disposePopulation();
        await this.genetic.estimate();
    }
}

/**
 * Generates a random value by description of it
 * @param range - range description
 * @returns random value
 */
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
 * Slice backtesting history to different segments, for testing and validation
 */
export function crateWFOSegmentation(ticks: Candle[], count: number, type: GeneticWFOType) {
    const segmentSize = Math.round(ticks.length / (count - 1));
    const forwardSize = Math.round(segmentSize / 2);

    let startPos = 0;
    let endPos = segmentSize;
    const pairs = [];

    while (endPos < ticks.length) {
        const backtest = ticks.slice(startPos, endPos);
        const forward = ticks.slice(endPos, endPos + forwardSize);

        endPos += forwardSize;

        if (type === GeneticWFOType.Rolling) {
            startPos += forwardSize;
        }

        if (backtest.length && forward.length) {
            pairs.push([backtest, forward]);
        }
    }

    return pairs;
}
