import typescript from 'rollup-plugin-typescript2';
import pkg from './package.json';
import { terser } from 'rollup-plugin-terser';

const tsConfig = {
    tsconfigOverride: {
        compilerOptions: { module: 'esnext' },
    },
};

const debut = {
    input: 'src/modules/debut.ts',
    output: {
        file: pkg.main,
        format: 'cjs', // the preferred format
    },
    external: [...Object.keys(pkg.dependencies || {}), 'path', 'fs'],
    plugins: [
        typescript({ ...tsConfig }),
        terser(), // minifies generated bundles
    ],
};

const cli = {
    input: {
        finder: 'src/cli/finder-cli.ts',
        genetic: 'src/cli/genetic-cli.ts',
        tester: 'src/cli/tester-cli.ts',
    },
    output: {
        dir: 'lib/cli',
        format: 'cjs',
        banner: '#!/usr/bin/env node',
    },
    external: [...Object.keys(pkg.dependencies || {}), 'path', 'fs'],
    plugins: [
        typescript(tsConfig),
        terser(), // minifies generated bundles
    ],
};

export default [cli, debut];
