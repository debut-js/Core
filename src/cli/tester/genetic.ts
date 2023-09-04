import { math } from '@debut/plugin-utils';
import { createHash } from 'node:crypto';
import {
    DebutOptions,
    GeneticSchema,
    GenticWrapperOptions,
    SchemaDescriptor,
    GeneticWFOType,
    GeneticType,
} from '@debut/types';
import { Genetic, GeneticOptions, Select, IslandGeneticModel, IslandGeneticModelOptions, Migrate } from 'async-genetic';
import { getHistory } from './history';
import { Candle } from '@debut/types';
import cluster, { Worker } from 'node:cluster';
import { cpus } from 'node:os';
import type { ThreadMessage } from './genetic-worker';

const numCPUs = cpus().length;
// MRI - Max Recursion Iterations
const MRI = 100;

/**
 * Genetic allorithms class, it's wrapper for Debut strategies optimize
 */
export class GeneticWrapper {
    private genetic: IslandGeneticModel<DebutOptions> | Genetic<DebutOptions>;
    private internalOptions: GeneticOptions<DebutOptions>;
    private schema: GeneticSchema;
    private schemaKeys: string[];
    private baseOpts: DebutOptions;
    private workers: Worker[] = [];
    private activeWorker = 0;
    private tasksRegistered = 0;

    constructor(private options: GenticWrapperOptions) {
        this.internalOptions = {
            randomFunction: this.getRandomSolution,
            fitnessFunction: this.fitness, // previously described to measure how good your solution is
            mutationFunction: this.mutate, // previously described to implement mutation
            crossoverFunction: this.crossover, // previously described to produce child solution by combining two parents
            populationSize: 100,
            select1: Select.FittestLinear,
            select2: Select.Fittest,
            mutateProbablity: 0.08,
            crossoverProbablity: 0.3,
        };

        const ilandOptions: IslandGeneticModelOptions<DebutOptions> = {
            islandCount: options.populationSize * 0.01,
            islandMutationProbability: 0.8,
            islandCrossoverProbability: 0.8,
            migrationProbability: 0.1,
            migrationFunction: Migrate.FittestLinear,
        };

        if (this.options.gaType === GeneticType.Island) {
            this.genetic = new IslandGeneticModel(ilandOptions, { ...this.internalOptions, ...this.options });
        } else {
            this.genetic = new Genetic({ ...this.internalOptions, ...this.options });
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
        const { days, gapDays, wfo, best, ticksFilter, gaContinent, gaType, maxThreads } = this.options;
        const { broker = 'tinkoff', ticker, interval, instrumentType } = opts;

        this.schema = schema;
        this.schemaKeys = Object.keys(schema);
        this.baseOpts = opts;

        await this.createWorkerThreads();

        let ticks = await getHistory({
            broker,
            ticker,
            interval,
            days,
            gapDays,
            instrumentType,
            noProgress: true,
        });

        if (ticksFilter) {
            ticks = ticks.filter(ticksFilter(opts));
        }

        const optimisation = wfo ? 'Walk-Forward' : 'None';
        const optimisationType = wfo ? (wfo === GeneticWFOType.Rolling ? '(Rolling)' : '(Classic)') : '';
        const gaMode = gaType === GeneticType.Island ? 'Islands' : 'Classic';
        const gaExtra = gaType === GeneticType.Island && gaContinent ? '+ Continent' : '';

        console.log(`\nUsed ${Math.min(maxThreads || 0, numCPUs)} of ${numCPUs} CPU's`);
        console.log(`\nOptimisation: ${optimisation} ${optimisationType}`);
        console.log(`\nGenetic Mode: ${gaMode} ${gaExtra}`);
        console.log(`\nTicks count: ${ticks.length}`);

        if (wfo) {
            await this.wfoGenetic(ticks, wfo);
        } else {
            await this.pureGenetic(ticks);
        }

        this.disposeeWorkerThreads();

        return this.genetic
            .best(best || 30)
            .reverse()
            .map((ph) => ({ config: ph.entity, stats: ph.state }));
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
            return config;
        }

        return this.getRandomSolution();
    };

    /**
     * Estimate strategy, more fitness score mean strategy is good, less mean strategy bad
     */
    private fitness = async (cfg: DebutOptions) => {
        const result = await this.createThreadTask(cfg);

        return { fitness: result.score, state: result.stats as Record<string, unknown> };
    };

    /**
     * Mutate configurations (self reproducing with mutations or not, depends on mutation probability)
     */
    private mutate = async (cfg: DebutOptions, i: number = 0) => {
        const length = this.schemaKeys.length - 1;
        const mutateKeys = new Set<string>();

        for (let i = 0; i <= length; i++) {
            mutateKeys.add(this.schemaKeys[getRandom(1, length)]);
        }

        for (const key of mutateKeys.values()) {
            if (key in this.schema) {
                cfg[key] = getRandomByRange(this.schema[key]);
            }
        }

        // Prevent recursion calls for validation
        if (i >= MRI || this.options.validateSchema(cfg)) {
            return cfg;
        }

        return this.mutate(cfg, ++i);
    };

    /**
     * Crossover for two selected cofigurations of strategies
     * @param mother - first selected strategy
     * @param father - second selectedd strategy
     * @param i - deep recursion calls counter
     * @returns return two new strategy configuration as childs of current parents
     */
    private crossover = async (mother: DebutOptions, father: DebutOptions, i: number = 0) => {
        const sonConfig: DebutOptions = { ...father };
        const daughterConfig: DebutOptions = { ...mother };

        this.schemaKeys.forEach((key: string) => {
            const source1 = Math.random() > 0.5 ? mother : father;
            const source2 = Math.random() > 0.5 ? father : mother;

            sonConfig[key] = source1[key];
            daughterConfig[key] = source2[key];
        });

        // Infinite recursion preventing and validation checks
        if (i >= MRI || (this.options.validateSchema(sonConfig) && this.options.validateSchema(daughterConfig))) {
            return [sonConfig, daughterConfig];
        }

        return this.crossover(mother, father, ++i);
    };

    /**
     * Multi processing threads
     */
    private async createWorkerThreads() {
        const promises: Promise<unknown>[] = [];
        const threads = this.options.maxThreads ? Math.min(Number(this.options.maxThreads), numCPUs) : numCPUs;

        // Fork workers.
        for (let i = 0; i < threads; i++) {
            const worker = cluster.fork();
            worker.setMaxListeners(Number(this.options.populationSize));
            this.workers.push(worker);

            promises.push(new Promise((resolve) => worker.once('online', resolve)));
        }

        cluster.on('exit', (worker, code, signal) => {
            console.log(`worker ${worker.process.pid} died`);

            const idx = this.workers.findIndex((item) => item === worker);

            if (idx !== -1) {
                this.workers.splice(idx, 1);
            }
        });

        return Promise.all(promises);
    }

    /**
     * Stop all multi processing threads
     */
    private disposeeWorkerThreads() {
        for (const worker of this.workers) {
            if (worker.isConnected() && worker.process.channel?.hasRef) {
                worker.disconnect();
            }

            if (!worker.isDead()) {
                worker.kill();
            }
        }
    }

    /**
     * Send ticks data to threads
     */
    private async setThreadTicks(setTicks: Candle[]) {
        for (const worker of this.workers) {
            const msg: ThreadMessage = { setTicks };

            await this.sendMessage(worker, msg);
        }
    }

    /**
     * Run tasks in threads
     */
    private async runThreadTasks() {
        this.tasksRegistered = 0;

        for (const worker of this.workers) {
            const msg: ThreadMessage = { estimate: true };

            await this.sendMessage(worker, msg);
        }
    }

    /**
     * Send task to thread
     */
    private async createThreadTask(config: DebutOptions) {
        const str = JSON.stringify(config, Object.keys(config).sort());
        const id = createHash('md5').update(str).digest('hex');
        const worker = this.workers[this.activeWorker];

        this.activeWorker++;
        this.tasksRegistered++;

        if (this.activeWorker === this.workers.length) {
            this.activeWorker = 0;
        }

        await this.sendMessage(worker, { addTask: { id, config } });

        const promise: Promise<{ stats: unknown; score: number }> = new Promise((resolve) => {
            const handler = (msg: ThreadMessage) => {
                if (msg.results && msg.results.id === id) {
                    resolve(msg.results);
                    worker.off('message', handler);
                }
            };

            worker.on('message', handler);
        });

        // TODO: Performance issue when islands on
        if (this.genetic.population.length === this.tasksRegistered) {
            // When all tasks created start worekrs
            this.runThreadTasks();
        }

        return promise;
    }

    /**
     * Send async message to worker
     */
    private async sendMessage(wokrer: Worker, message: ThreadMessage) {
        return new Promise((resolve, reject) => {
            wokrer.send(message, (err) => {
                if (err) {
                    return reject(err);
                }

                return resolve(void 0);
            });
        });
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

            await this.setThreadTicks(ticks);

            // Each 10 generation next 5 generations would be on continent
            if (i !== 0 && i % 15 === 0 && this.genetic instanceof IslandGeneticModel) {
                continentalGenerationsLeft = 5;
                // Move to continent
                this.genetic.moveAllToContinent();
            }

            const postfix = gaContinent ? (continentalGenerationsLeft !== 0 ? '(Continent)' : '(Ilands)') : '';
            console.log(`Generation ${postfix}`, i);

            await this.genetic.estimate();

            if (!lastGeneration || breedLast) {
                await this.genetic.breed();
            }

            if (continentalGenerationsLeft !== 0) {
                continentalGenerationsLeft--;

                // Move to ilands
                if (continentalGenerationsLeft === 0 && this.genetic instanceof IslandGeneticModel) {
                    this.genetic.migrateToIslands();
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

            console.log(
                `\nCandles count for each test segment is: ${backtest.length} - backtest, ${walkTest.length} - forward test`,
            );

            // Breed last generation as well
            await this.pureGenetic(backtest, true);

            // At last segment estimate all entities at full time and generate report
            // if (lastSegment) {
            //     console.log('Walk forward final estimation started');
            //     await this.test(ticks);
            // } else {
            console.log('Walk forward test started');
            await this.test(walkTest);

            if (!lastSegment) {
                await this.genetic.breed();
            }
            // }
        }
    }

    /**
     * Test population in custom period
     */
    private async test(walkTest: Candle[]) {
        await this.setThreadTicks(walkTest);

        await this.genetic.estimate();
    }
}

/**
 * Generate random numbers in a range
 */
function getRandom(max: number, min: number) {
    return Math.floor(Math.random() * (max - min + 1) + min);
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
