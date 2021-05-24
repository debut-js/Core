import { debutOptions } from './debut';

export type GeneticStats = {
    population: number;
    maximum: number;
    minimum: number;
    mean: number;
    stdev: number;
};

export type ConfigValidator = (cfg: debutOptions) => debutOptions | false;
