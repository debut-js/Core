/**
 * Keep number between values min and max
 */
export function clamp(num: number, min: number, max: number) {
    return num <= min ? min : num >= max ? max : num;
}

/**
 * Get count number after point
 */
export function getPrecision(number: number | string) {
    const s = `${number}`;
    const d = s.indexOf('.') + 1;

    return !d ? 0 : s.length - d;
}

/**
 * Detect changes in percent between current and prevous
 */
export function percentChange(current: number, prev: number) {
    return ((current - prev) / prev) * 100;
}

/**
 * Quick no type loss number convertation to fixed precision
 */
export function toFixed(num: number, precision = 2) {
    const fixation = 10 ** precision;
    return Math.round((num + Number.EPSILON) * fixation) / fixation;
}

/**
 * Returns a random number between min (inclusive) and max (exclusive)
 */
export function getRandomArbitrary(min: number, max: number, odd?: boolean) {
    const num = toFixed(Math.random() * (max - min) + min);

    return odd ? correctOdd(num, max) : num;
}

/**
 * Returns a random integer between min (inclusive) and max (inclusive).
 * The value is no lower than min (or the next integer greater than min
 * if min isn't an integer) and no greater than max (or the next integer
 * lower than max if max isn't an integer).
 * Using Math.round() will give you a non-uniform distribution!
 */
export function getRandomInt(min: number, max: number, odd?: boolean) {
    min = Math.ceil(min);
    max = Math.floor(max);
    const num = Math.floor(Math.random() * (max - min + 1)) + min;

    return odd ? correctOdd(num, max) : num;
}

function correctOdd(num: number, max: number) {
    if (num % 2 === 0) {
        if (num === max) {
            num--;
        } else {
            num++;
        }
    }

    return num;
}
