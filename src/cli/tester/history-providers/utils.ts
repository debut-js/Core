import { SingleBar, Presets } from 'cli-progress';

export function createProgress(title: string = '') {
    return new SingleBar(
        {
            format: `${title} [{bar}] {percentage}% | {value} of {total} days`,
            stopOnComplete: true,
        },
        Presets.shades_grey,
    );
}
