import { TimeFrame } from '../types/common';

/**
 * Compare two dates and check if they are have same day of month.
 * @param d1 first date
 * @param d2 second date
 */
export function isSameDay(d1: Date, d2: Date) {
    return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
}

/**
 * Detect weekends days from any date
 * @param d date
 */
export function isWeekend(d: string | number | Date) {
    d = new Date(d);

    const day = d.getDay();
    return day === 6 || day === 0; // 6 = Saturday, 0 = Sunday
}

/**
 * Create date with custom ISO format (preffered for Tinkoff history API)
 * @param date date
 */
export function toIsoString(date: Date | number | string) {
    date = new Date(date);
    const tzo = -date.getTimezoneOffset(),
        dif = tzo >= 0 ? '+' : '-',
        pad = function (num: number) {
            const norm = Math.floor(Math.abs(num));
            return (norm < 10 ? '0' : '') + norm;
        };
    return (
        date.getFullYear() +
        '-' +
        pad(date.getMonth() + 1) +
        '-' +
        pad(date.getDate()) +
        'T' +
        pad(date.getHours()) +
        ':' +
        pad(date.getMinutes()) +
        ':' +
        pad(date.getSeconds()) +
        '.' +
        '000000' +
        dif +
        pad(tzo / 60) +
        ':' +
        pad(tzo % 60)
    );
}

/**
 * Get number of week day from timestamp
 * @param stamp timestamp
 */
export function getWeekDay(stamp: number) {
    // Convert to number of days since 1 Jan 1970
    const days = stamp / 86400000;
    // 1 Jan 1970 was a Thursday, so add 4 so Sunday is day 0, and mod 7
    const day_of_week = (days + 4) % 7;

    return Math.floor(day_of_week);
}

/**
 * Convert candle size to milliseconds value
 */
export function intervalToMs(interval: TimeFrame) {
    let time = 0;

    switch (interval) {
        case '1min':
            time = 1;
            break;
        case '5min':
            time = 5;
            break;
        case '15min':
            time = 15;
            break;
        case '30min':
            time = 30;
            break;
        case '1h':
            time = 60;
            break;
        case '4h':
            time = 240;
            break;
        case 'day':
            time = 1440;
            break;
    }

    if (!time) {
        throw new Error('Unsupported interval');
    }

    return time * 60 * 1000;
}
