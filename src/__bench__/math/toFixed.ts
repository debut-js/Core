import Benchmark from 'benchmark';
import { toFixed } from '../../utils/math';

console.log('--- toFixed ---');

const powSuite = new Benchmark.Suite();
const PI = Math.PI;

powSuite.add('toFixed()', () => {
    toFixed(PI);
});

powSuite.add('Math.toFixed', () => {
    PI.toFixed(2);
});

powSuite.on('cycle', (event) => {
    console.info(String(event.target));
});

powSuite.run();

console.log('--- End of toFixed ---\n');
