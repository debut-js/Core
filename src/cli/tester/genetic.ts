import { Genetic, GeneticOptions, Select } from 'async-genetic';
import { getHistory } from './history';
import { TesterTransport } from './tester-transport';
import { DebutOptions } from '../../types/debut';
import { WorkingEnv } from '../../types/common';
import { getRandomArbitrary, getRandomInt } from '../../utils/math';
export class GeneticWrapper {
    private genetic: Genetic<DebutOptions>;
    private transport: TesterTransport;
    private internalOptions: GeneticOptions<DebutOptions>;
    private schema: GeneticSchema;
    private schemaKeys: string[];
    private configLookup: Map<DebutOptions, unknown> = new Map();
    private deduplicateLookup = new Set<string>();
    private scoreLookup: Map<string, number> = new Map();
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

        this.genetic = new Genetic({ ...this.internalOptions, ...this.options });
    }

    async start(schema: GeneticSchema, opts: DebutOptions) {
        try {
            this.schema = schema;
            this.schemaKeys = Object.keys(schema);
            this.configLookup = new Map();
            this.baseOpts = opts;
            this.transport = new TesterTransport({ ohlc: this.options.ohlc, comission: opts.fee, broker: opts.broker });

            const { broker = 'tinkoff', ticker, interval } = opts;
            const { days, gapDays } = this.options;
            let ticks = await getHistory({
                broker,
                ticker,
                interval,
                days,
                gapDays,
            });

            if (this.options.ticksFilter) {
                ticks = ticks.filter(this.options.ticksFilter(opts));
            }

            if (this.options.log) {
                console.log(`\n----- Genetic Start with ${ticks.length} candles ----- \n`);
            }

            this.transport.setTicks(ticks);
            this.genetic.seed();

            for (let i = 0; i < this.options.generations; i++) {
                this.lastIteration = i === this.options.generations - 1;

                const now = Date.now();
                if (this.options.log) {
                    console.log('Generation: ', i);
                }

                // Запускаем транспорт в режиме ожидания пока не подпишется вся популяция
                this.transport.run(true);
                await this.genetic.estimate();

                if (this.options.log) {
                    console.log('Generation time: ', (Date.now() - now) / 1000, 's');
                    console.log('Stats: ', this.genetic.stats);
                }

                // Если это последняя итерация дальше скрещивать не нужно
                if (!this.lastIteration) {
                    this.genetic.breed();
                }

                this.transport.reset();
                this.deduplicateLookup.clear();
            }

            return this.genetic
                .best(30)
                .reverse()
                .map((config) => ({ config, stats: this.configLookup.get(config) }));

            // const [config] = this.genetic.best(1);
            // this.lastIteration = false;
            // this.results.push({ config, stats: this.configLookup.get(config) });

            // if (this.results.length === this.options.best) {
            //     return this.results;
            // }

            // // СБросим популяцию
            // this.genetic['population'] = [];
            // return this.start(schema, opts);
        } catch (e) {
            console.log(e);

            return [];
        }
    }

    private getRandomSolution = () => {
        const solution = { ...this.baseOpts };

        this.schemaKeys.forEach((key) => {
            const range = this.schema[key];
            let randomValue: number | boolean;

            switch (true) {
                case range.bool:
                    randomValue = Math.random() > 0.5;
                case range.int:
                    randomValue = getRandomInt(range.min, range.max, range.odd);
                    break;
                default:
                    randomValue = getRandomArbitrary(range.min, range.max, range.odd);
                    break;
            }
            solution[key] = randomValue;
        });

        if (this.options.validateSchema(solution)) {
            return solution;
        }

        return this.getRandomSolution();
    };

    private fitness = async (solution: DebutOptions) => {
        const hash = JSON.stringify(solution, Object.keys(solution).sort());
        const prev = this.scoreLookup.get(hash);

        // If duplicates are allowed
        if (prev && !this.lastIteration) {
            await this.transport.complete;

            return prev;
        }

        const bot = await this.options.create(this.transport, solution, WorkingEnv.genetic);
        const dispose = await bot.start();

        await this.transport.complete;
        await bot.closeAll();
        const stats = this.options.stats(bot);

        if (this.lastIteration) {
            this.configLookup.set(solution, stats);
        }

        const result = this.options.score(bot);
        this.scoreLookup.set(hash, result);

        dispose();

        return result;
    };

    private mutate = (solution: DebutOptions) => {
        solution = { ...solution };

        this.schemaKeys.forEach((key) => {
            if (key in this.schema && Math.random() < 0.3) {
                const range = this.schema[key];
                const randomFn = range.int ? getRandomInt : getRandomArbitrary;

                solution[key] = randomFn(range.min, range.max);
            }
        });

        if (this.options.validateSchema(solution)) {
            return solution;
        }

        return this.mutate(solution);
    };

    private crossover = (mother: DebutOptions, father: DebutOptions, i = 0) => {
        // two-point crossover
        const son: DebutOptions = { ...father };
        const daughter: DebutOptions = { ...mother };

        this.schemaKeys.forEach((key: string) => {
            const source1 = Math.random() > 0.5 ? mother : father;
            const source2 = Math.random() > 0.5 ? father : mother;

            son[key] = source1[key];
            daughter[key] = source2[key];
        });

        if (i >= 10 || (this.options.validateSchema(son) && this.options.validateSchema(daughter))) {
            return [son, daughter];
        }

        return this.crossover(mother, father, ++i);
    };

    private deduplicate = (solution: DebutOptions) => {
        const hash = JSON.stringify(solution, Object.keys(solution).sort());

        if (this.deduplicateLookup.has(hash)) {
            return false;
        }

        this.deduplicateLookup.add(hash);

        return true;
    };
}
