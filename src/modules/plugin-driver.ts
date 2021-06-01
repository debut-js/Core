import {
    PluginDriverInterface,
    DebutCore,
    PluginCtx,
    PluginInterface,
    SyncHooks,
    HookArguments,
    SkippingHooks,
    AsyncHooks,
    PluginHook,
    HookToArgumentsMap,
} from '@debut/types';

export class PluginDriver implements PluginDriverInterface {
    private pluginCtx: PluginCtx;
    private plugins: PluginInterface[] = [];

    constructor(private debut: DebutCore) {
        this.pluginCtx = Object.freeze({
            findPlugin: this.findPlugin,
            debut: this.debut,
        });
    }

    public register(plugins: PluginInterface[]) {
        for (const plugin of plugins) {
            if (!plugin || this.findPlugin(plugin.name)) {
                continue;
            }

            this.plugins.push(plugin);
        }
    }

    public getPublicAPI() {
        const api: unknown = {};

        for (const plugin of this.plugins) {
            if ('api' in plugin) {
                api[plugin.name] = plugin.api;
            }
        }

        return Object.freeze(api);
    }

    public syncReduce<T extends SyncHooks>(hookName: T, ...args: Parameters<HookToArgumentsMap[T]>) {
        for (const plugin of this.plugins) {
            this.runHook(hookName, plugin, ...args);
        }
    }

    public async asyncSkipReduce<T extends SkippingHooks>(hookName: T, ...args: Parameters<HookToArgumentsMap[T]>) {
        for (const plugin of this.plugins) {
            const skip = await this.runHook(hookName, plugin, ...args);

            if (skip) {
                return skip;
            }
        }

        return false;
    }

    public async asyncReduce<T extends AsyncHooks>(hookName: AsyncHooks, ...args: Parameters<HookToArgumentsMap[T]>) {
        for (const plugin of this.plugins) {
            await this.runHook(hookName, plugin, ...args);
        }
    }

    public runHook<T extends PluginHook>(
        hookName: PluginHook,
        plugin: PluginInterface,
        ...args: Parameters<HookToArgumentsMap[T]>
    ) {
        if (hookName in plugin) {
            // @ts-ignore ts issue?
            return plugin[hookName](...args);
        }
    }

    private findPlugin = <T extends PluginInterface>(name: string) => {
        return this.plugins.find((plugin) => plugin.name === name) as T;
    };
}
