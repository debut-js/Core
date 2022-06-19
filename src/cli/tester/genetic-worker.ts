import { cli } from '@debut/plugin-utils';
import { DebutOptions, DebutCore, WorkingEnv, Candle } from '@debut/types';
import { TesterTransport } from './tester-transport';

export interface ThreadMessage {
    addTask?: {
        id: string;
        config: DebutOptions;
    };

    setTicks?: Candle[];

    estimate?: boolean;

    results?: {
        id: string;
        score: number;
        stats: unknown;
    };
}

export class GeneticWorker {
    private transport: TesterTransport;
    private schema: cli.BotData;
    private bots: DebutCore[] = [];

    constructor(ohlc: boolean, ticker: string, bot: string) {
        process.on('message', async (msg: ThreadMessage) => {
            if (!this.schema) {
                this.schema = await cli.getBotData(bot);
                const cfg = this.schema.configs[ticker];
                this.transport = new TesterTransport({ ohlc, broker: cfg.broker, ticker });
            }

            try {
                if (msg.addTask) {
                    const { config, id } = msg.addTask;
                    const bot = await this.createBot(config, id);

                    this.bots.push(bot);
                    bot.start();
                }

                if (msg.estimate) {
                    await this.transport.run();

                    for (const bot of this.bots) {
                        const stats = this.schema.meta.stats(bot);
                        const score = this.schema.meta.score(bot);
                        const resultMsg: ThreadMessage = { results: { id: bot.id, stats, score } };

                        await bot.dispose();
                        process.send(resultMsg);
                    }

                    this.bots.length = 0;
                    this.transport.reset();
                }

                if (msg.setTicks) {
                    this.transport.setTicks(msg.setTicks);
                }
            } catch (e) {
                console.log(e);
            }
        });
    }

    /**
     * Create strategy from options and assign strategy id based on options hash funtion
     * @param config - strategy options
     * @returns strategy
     */
    private async createBot(config: DebutOptions, id: string) {
        const bot = await this.schema.meta.create(this.transport, config, WorkingEnv.genetic);
        bot.id = id;

        return bot;
    }
}
