import {
    PluginDriverInterface,
    DebutCore,
    PluginCtx,
    PluginInterface,
    SkippingHooks,
    AsyncHooks,
    PluginHook,
    SkipHookArgumentsMap,
    AsyncHookArgumentsMap,
    SyncHooks,
    SyncHookArgumentsMap,
} from '@debut/types';

export class PluginDriver implements PluginDriverInterface {
    private pluginCtx: PluginCtx;
    private plugins: PluginInterface[] = [];
    private hooksList = [
        // onInit called immediatly after registration
        PluginHook.onBeforeOpen,
        PluginHook.onOpen,
        PluginHook.onBeforeClose,
        PluginHook.onClose,
        PluginHook.onBeforeTick,
        PluginHook.onTick,
        PluginHook.onCandle,
        PluginHook.onAfterCandle,
        PluginHook.onStart,
        PluginHook.onDispose,
        PluginHook.onDepth,
        PluginHook.onMajorCandle,
    ];
    private registeredHooks: Partial<Record<PluginHook, Array<Function>>> = {};

    constructor(private debut: DebutCore) {
        this.pluginCtx = Object.freeze({
            findPlugin: this.findPlugin,
            debut: this.debut,
        });

        for (const hookName of this.hooksList) {
            this.registeredHooks[hookName] = [];
        }
    }

    public register(plugins: PluginInterface[]) {
        for (const plugin of plugins) {
            if (!plugin) {
                continue;
            }

            if (this.findPlugin(plugin.name)) {
                console.warn(`Plugin ${plugin.name} initialized many times!`);
            }

            this.plugins.push(plugin);

            if ('onInit' in plugin) {
                plugin.onInit.call(this.pluginCtx);
            }

            for (const hookName of this.hooksList) {
                this.registerHook(hookName, plugin[hookName]);
            }
        }
    }

    public getPublicAPI() {
        const api: Record<string, unknown> = {};

        for (const plugin of this.plugins) {
            if ('api' in plugin) {
                api[plugin.name] = plugin.api;
            }
        }

        return Object.freeze(api);
    }

    public skipReduce(hookName: SkippingHooks, ...args: Parameters<SkipHookArgumentsMap[SkippingHooks]>): boolean {
        for (const hook of this.registeredHooks[hookName]) {
            const skip: boolean | void = hook(...args);

            if (skip) {
                return skip;
            }
        }

        return false;
    }

    public async asyncReduce(hookName: AsyncHooks, ...args: Parameters<AsyncHookArgumentsMap[AsyncHooks]>) {
        for (const hook of this.registeredHooks[hookName]) {
            await hook(...args);
        }
    }

    public reduce(hookName: SyncHooks, ...args: Parameters<SyncHookArgumentsMap[SyncHooks]>) {
        for (const hook of this.registeredHooks[hookName]) {
            hook(...args);
        }
    }

    public getSnapshot(): Record<string, Record<string, unknown>> {
        const snapshot = {};

        for (const plugin of this.plugins) {
            if (PluginHook.onSnapshot in plugin) {
                const hookResult = plugin[PluginHook.onSnapshot].call(this.pluginCtx);

                snapshot[plugin.name] = { ...snapshot[plugin.name], ...hookResult };
            }
        }

        return snapshot;
    }

    public hydrateSnapshot(snapshot: Record<string, Record<string, unknown>>): void {
        for (const plugin of this.plugins) {
            const pluginData = snapshot[plugin.name];

            if (PluginHook.onHydrate in plugin && pluginData) {
                plugin[PluginHook.onHydrate].call(this.pluginCtx, pluginData);
            }
        }
    }

    private registerHook(hookName: PluginHook, hook: Function) {
        if (hook) {
            this.registeredHooks[hookName].push(hook.bind(this.pluginCtx));
        }
    }

    private findPlugin = <T extends PluginInterface>(name: string) => {
        return this.plugins.find((plugin) => plugin.name === name) as T;
    };
}
