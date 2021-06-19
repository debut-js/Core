import { SingleBar, Presets } from 'cli-progress';

export function createProgress(title: string = '') {
    return new SingleBar(
        {
            format: `${title} [{bar}] {percentage}% | {value}/{total}`,
            stopOnComplete: true,
        },
        Presets.shades_grey,
    );
}
