import { GeneticSchema } from '../cli/tester/genetic';
import { Debut } from '../modules/debut';
import { Candle } from './candle';
import { TimeFrame, WorkingEnv } from './common';
import { PluginInterface } from './plugin';
import { BaseTransport } from './transport';

export interface debutOptions {
    broker: 'tinkoff' | 'binance'; // Тип брокера
    ticker: string; // Тикер
    currency: string; // Валюта
    interval: TimeFrame; // Временной интервал
    amount: number; // Сумма для работы стратегии
    fee?: number; // Налог за операцию в дробях
    id?: number; // Ид конфигурации
    sandbox?: boolean; // Активен ли режим песочницы или торговля на реальные деньги
    margin?: boolean; // Разрешена ли торговля в шорт
    lotsMultiplier?: number; // Множитель лотности, например если нужно сделать х2 или х3 закупку, по умолчанию 1
    equityLevel?: number; // Склько доступно от общего депозита для текущей стратегии
}

export interface debutMeta {
    parameters: GeneticSchema;
    score: (bot: Debut) => number;
    validate: (cfg: debutOptions) => false | debutOptions;
    stats: (bot: Debut) => unknown;
    create: (transport: BaseTransport, cfg: debutOptions, env: WorkingEnv) => Promise<Debut>;
    ticksFilter?: (solution: debutOptions) => (tick: Candle) => boolean;
    testPlugins?: (cfg: debutOptions) => PluginInterface[];
    geneticPlugins?: (cfg: debutOptions) => PluginInterface[];
}
