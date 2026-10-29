import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import type * as Sdk from '../src/index.js';
import { TestServer, failure } from './server.js';

/**
 * Waits for an observable client condition on the runtime being verified.
 * @param condition - Condition to check until it succeeds.
 * @returns A promise resolved when the condition succeeds.
 * @throws Error - If the condition does not succeed before the deadline.
 */
async function waitFor(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
        if (Date.now() >= deadline) {
            throw new Error('Runtime compatibility check timed out');
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

// Run the installed package, independently of the development toolchain's Node requirements.
const packageName = 'lessconfig-js';
const mode = process.argv[2];
assert.ok(mode === 'import' || mode === 'require');
const sdk: typeof Sdk = mode === 'require' ? createRequire(import.meta.url)(packageName) : await import(packageName);
const server = await new TestServer().start();
const client = new sdk.LessConfigClient({
    endpoint: server.endpoint,
    token: 'test-token',
    requestTimeoutMs: 250,
    watchTimeoutSeconds: 1,
    watchRequestTimeoutMs: 2_000,
    retryInitialDelayMs: 20,
    retryMaxDelayMs: 100,
});

try {
    assert.equal(client.getStatus(), sdk.WatchStatus.IDLE);
    const statuses: Sdk.WatchStatus[] = [];
    client.addStatusListener((status) => {
        statuses.push(status);
    });
    let observed: string | undefined;
    await client.addConfigListener(async () => {
        observed = (await client.getConfig('payment', 'prod', 'application.yml'))?.value;
    });
    server.pollReplies.push(failure(503, 'unavailable'));

    const configs = await Promise.all(Array.from({ length: 4 }, () => client.getConfig('payment', 'prod', 'application.yml')));
    assert.equal(server.initializations.length, 1);
    assert.equal(server.reads.length, 1);
    assert.equal(configs[0]?.value, '# 原文\nport: 8080\n');
    configs[0]!.value = 'external mutation';
    assert.equal((await client.getConfig('payment', 'prod', 'application.yml'))?.value, '# 原文\nport: 8080\n');

    await waitFor(() => statuses.includes(sdk.WatchStatus.RETRYING) && client.getStatus() === sdk.WatchStatus.WATCHING);
    assert.equal(client.getWatchError(), null);
    server.put('application.yml', 'updated');
    await waitFor(() => observed === 'updated');

    assert.equal((await client.getEnvironment('payment', 'prod'))?.projectId, 'p1');
    server.onRequest = ({ url }) => (url.pathname === '/api/v1/projects' ? new Promise(() => {}) : undefined);
    await assert.rejects(client.getProjects(), (error: unknown) => {
        return error instanceof sdk.LessConfigError && error.message === 'HTTP request timed out' && error.cause !== undefined;
    });

    server.holdPolls = true;
    await waitFor(() => server.waiters.size > 0);
    client.close();
    await waitFor(() => server.waiters.size === 0);
    assert.equal(client.getStatus(), sdk.WatchStatus.CLOSED);
    await assert.rejects(client.getProjects(), /closed/);
    console.log(`${process.version} ${mode}: native fetch, cache, watch, retry, timeout, and cancellation passed.`);
} finally {
    client.close();
    await server.close();
}
