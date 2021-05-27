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
    public syncReduce(hookName: SyncHooks, ...args: HookArguments) {
        for (const plugin of this.plugins) {
            this.runHook(hookName, plugin, ...args);
        }
    }

    public async asyncSkipReduce(hookName: SkippingHooks, ...args: HookArguments) {
        for (const plugin of this.plugins) {
            const skip = await this.runHook(hookName, plugin, ...args);

            if (skip) {
                return skip;
            }
        }

        return false;
    }

    public async asyncReduce(hookName: AsyncHooks, ...args: HookArguments) {
        for (const plugin of this.plugins) {
            await this.runHook(hookName, plugin, ...args);
        }
    }

    public runHook(hookName: PluginHook, plugin: PluginInterface, ...args: HookArguments): Promise<boolean> | void {
        if (hookName in plugin) {
            return plugin[hookName].call(this.pluginCtx, ...args);
        }
    }

    private findPlugin = <T extends PluginInterface>(name: string) => {
        return this.plugins.find((plugin) => plugin.name === name) as T;
    };
}
