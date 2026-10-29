import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
// Optional arguments are Node executable paths; npm and TypeScript keep using the development runtime.
const runtimes = process.argv.length > 2 ? process.argv.slice(2) : [process.execPath];
const temporary = await mkdtemp(join(tmpdir(), 'lessconfig-package-'));
try {
    const [packed] = JSON.parse(
        execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], {
            cwd: root,
            encoding: 'utf8',
        }),
    );
    assert(packed.files.every(({ path }) => /^(dist\/|package\.json$|README\.md$|LICENSE$)/.test(path)));
    const consumer = join(temporary, 'consumer');
    await mkdir(consumer);
    await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'sdk-consumer', private: true, type: 'module' }));
    execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(temporary, packed.filename)], {
        cwd: consumer,
        stdio: 'pipe',
    });
    const manifest = JSON.parse(await readFile(join(consumer, 'node_modules/lessconfig-js/package.json'), 'utf8'));
    assert.equal(typeof manifest.dependencies?.['lodash-es'], 'string');
    for (const file of ['server', 'package-runtime']) {
        const source = await readFile(join(root, 'tests', `${file}.ts`), 'utf8');
        const compiled = ts.transpileModule(source, {
            compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
        });
        await writeFile(join(consumer, `${file}.js`), compiled.outputText);
    }
    for (const runtime of runtimes) {
        for (const mode of ['import', 'require']) {
            execFileSync(runtime, ['package-runtime.js', mode], { cwd: consumer, stdio: 'inherit', timeout: 15_000 });
        }
    }
    const types = `
    import { LessConfigClient, LessConfigError, WatchStatus, type Config, type StatusListener } from 'lessconfig-js';
    const client = new LessConfigClient({ endpoint: 'https://example.com/api', token: 'test' });
    const config: Promise<Config | null> = client.getConfig('payment', 'prod', 'application.yml');
    const observer: StatusListener = (status, error) => {
      const state: WatchStatus = status;
      const failure: LessConfigError | null = error;
    };
    client.addStatusListener(observer);
    client.addConfigListener('payment', 'prod', async (changes) => {
      const revision: number = changes[0]!.revision;
      const latest = await client.getConfigs('payment', 'prod');
    });
  `;
    await writeFile(join(consumer, 'consumer.mts'), types);
    await writeFile(join(consumer, 'consumer.cts'), types);
    execFileSync(
        process.execPath,
        [
            join(root, 'node_modules/typescript/bin/tsc'),
            '--noEmit',
            '--strict',
            '--module',
            'NodeNext',
            '--target',
            'ES2022',
            'consumer.mts',
            'consumer.cts',
        ],
        { cwd: consumer, stdio: 'pipe' },
    );
    console.log('Packed SDK passed ESM, CommonJS, dependency installation, and both TypeScript consumer checks.');
} finally {
    await rm(temporary, { recursive: true, force: true });
}
