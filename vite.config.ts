import { defineConfig } from 'vitest/config';

export default defineConfig({
    build: {
        target: 'es2022',
        lib: {
            entry: 'src/index.ts',
            formats: ['es', 'cjs'],
            fileName: (format) => (format === 'es' ? 'index.js' : 'index.cjs'),
        },
        sourcemap: true,
        minify: false,
    },
    test: {
        environment: 'node',
        restoreMocks: true,
        unstubGlobals: true,
    },
});
