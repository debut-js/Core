import Benchmark from 'benchmark';

console.log('--- Pow ---');

const powSuite = new Benchmark.Suite();

function powFor(a: number, b: number) {
    let r = 1;
    for (;;) {
        if (b & 1) {
            r = r * a;
        }
        b = b >> 1;
        if (b === 0) break;
        a = a * a;
    }
    return r;
}

function powWhile(num, pow) {
    let result = num;
    while (--pow) {
        result *= num;
    }
    return result;
}

powSuite.add('Math.pow', () => {
    Math.pow(2, 5);
});

powSuite.add('powFor()', () => {
    powFor(2, 5);
});

powSuite.add('powWhile()', () => {
    powWhile(2, 5);
});

powSuite.add('** pow', () => {
    2 ** 5;
});

powSuite.on('cycle', (event) => {
    console.info(String(event.target));
});

powSuite.run();

console.log('--- End of Pow ---\n');
