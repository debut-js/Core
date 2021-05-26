import { Debut } from '../modules/debut';
import { Candle } from './candle';
import { WorkingEnv } from './common';
import { DebutOptions } from './debut';
import { BaseTransport } from './transport';

export type GeneticStats = {
    population: number;
    maximum: number;
    minimum: number;
    mean: number;
    stdev: number;
};

export type ConfigValidator = (cfg: DebutOptions) => DebutOptions | false;

export interface GenticWrapperOptions {
    score: (bot: Debut) => number;
    stats: (bot: Debut) => unknown;
    create: (transport: BaseTransport, solution: DebutOptions, environment: WorkingEnv) => Promise<Debut>;
    generations: number;
    log?: boolean;
    populationSize?: number;
    days: number;
    ohlc?: boolean;
    gapDays?: number;
    validateSchema: ConfigValidator;
    ticksFilter?: (solution: DebutOptions) => (tick: Candle) => boolean;
    best?: number;
}

export interface SchemaDescriptor {
    min: number; // начальное значение
    max: number; // конечное значеие
    int?: boolean; // целочисленное
    bool?: boolean; // булево
    odd?: boolean; // Нечетное
}

export type GeneticSchema<T = any> = {
    [K in keyof Partial<T>]: SchemaDescriptor;
};
