import { readdir, readFile, writeFile } from 'node:fs/promises';

// TypeScript's NodeNext resolution needs declarations matching each module format.
for (const file of await readdir(new URL('../dist/', import.meta.url))) {
    if (!file.endsWith('.d.ts')) {
        continue;
    }
    const source = new URL(`../dist/${file}`, import.meta.url);
    const target = new URL(`../dist/${file.replace(/\.d\.ts$/, '.d.cts')}`, import.meta.url);
    const declaration = await readFile(source, 'utf8');
    await writeFile(target, declaration.replace(/from '([^']+)\.js'/g, "from '$1.cjs'"));
}
