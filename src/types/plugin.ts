import { Debut } from '../modules/debut';
import { PluginDriver } from '../modules/plugin-driver';
import { Candle } from './candle';
import { ExecutedOrder, OrderOptions } from './order';

/**
 * Base plugin type
 */
export type Plugin = (api: PluginDriver) => void;

/**
 * Plugin hook names
 */
export const enum PluginHook {
    onBeforeOpen = 'onBeforeOpen',
    onOpen = 'onOpen',
    onBeforeClose = 'onBeforeClose',
    onClose = 'onClose',
    onTick = 'onTick',
    onCandle = 'onCandle',
    onAfterCandle = 'onAfterCandle',
    onInit = 'onInit',
    onStart = 'onStart',
    onDispose = 'onDispose',
}

/**
 * Hooks with skip operation support
 */
export type SkippingHooks = PluginHook.onTick | PluginHook.onBeforeOpen | PluginHook.onBeforeClose;

/**
 * Synchronious hooks
 */
export type SyncHooks = PluginHook.onInit;

/**
 * Asynchronious hooks
 */
export type AsyncHooks =
    | PluginHook.onCandle
    | PluginHook.onAfterCandle
    | PluginHook.onClose
    | PluginHook.onDispose
    | PluginHook.onOpen
    | PluginHook.onStart;

/**
 * Interface for plugin, should be implemented
 */
export interface PluginInterface {
    name: string;
    api?: unknown;
    [PluginHook.onInit]?: (this: PluginCtx) => void;
    [PluginHook.onStart]?: (this: PluginCtx) => Promise<void>;
    [PluginHook.onDispose]?: (this: PluginCtx) => Promise<void>;
    [PluginHook.onBeforeClose]?: (this: PluginCtx, order: OrderOptions) => Promise<boolean | void>;
    [PluginHook.onBeforeOpen]?: (this: PluginCtx, order: OrderOptions) => Promise<boolean | void>;
    [PluginHook.onOpen]?: (this: PluginCtx, order: ExecutedOrder) => Promise<void>;
    [PluginHook.onClose]?: (this: PluginCtx, order: ExecutedOrder, closing: ExecutedOrder) => Promise<void>;
    [PluginHook.onCandle]?: (this: PluginCtx, candle: Candle) => Promise<void>;
    [PluginHook.onAfterCandle]?: (this: PluginCtx, candle: Candle) => Promise<void>;
    [PluginHook.onTick]?: (this: PluginCtx, tick: Candle) => Promise<boolean | void>;
}

/**
 * Hook arguments util
 */
export type HookArguments = Parameters<PluginInterface[keyof typeof PluginHook]>;

/**
 * Runtime context for working plugin
 */
export interface PluginCtx {
    findPlugin<T extends PluginInterface>(name: string): T;
    debut: Debut;
}
