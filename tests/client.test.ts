import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LessConfigClient, LessConfigError, WatchStatus, type ConfigChange, type LessConfigClientOptions } from '../src/index.js';
import { TestServer, failure } from './server.js';

let server: TestServer;
let client: LessConfigClient;
const clients: LessConfigClient[] = [];
/**
 * Waits for an observable client or fixture condition without fixed sleeps.
 * @param assertion - Assertion retried until it passes or the test deadline expires.
 * @returns A promise resolved with the successful assertion result.
 */
const wait = (assertion: () => unknown) => vi.waitFor(assertion, { timeout: 3_000, interval: 10 });
/**
 * Creates a fixture client with short test timeouts and registers it for cleanup.
 * @param options - Connection or timing settings overriding the fixture defaults.
 * @returns A client closed automatically after the current test.
 */
function create(options: Partial<LessConfigClientOptions> = {}): LessConfigClient {
    const value = new LessConfigClient({
        endpoint: server.endpoint,
        token: 'test-token',
        watchTimeoutSeconds: 1,
        watchRequestTimeoutMs: 2_000,
        retryInitialDelayMs: 30,
        retryMaxDelayMs: 100,
        ...options,
    });
    clients.push(value);
    return value;
}

beforeEach(async () => {
    server = await new TestServer().start();
    client = create();
});
afterEach(async () => {
    for (const client of clients.splice(0)) {
        client.close();
    }
    await server.close();
});

describe('configuration reads', () => {
    it('is lazy, uses versioned authenticated fetch requests, and initializes before reading', async () => {
        client.start();
        client.start();
        expect(server.records).toHaveLength(0);
        const config = await client.getConfig('payment', 'prod', 'application.yml');
        expect(config).toMatchObject({ key: 'application.yml', value: '# 原文\nport: 8080\n', type: 'yaml' });
        expect(server.records[0]!.url.pathname).toBe('/api/v1/watch');
        expect(server.records[1]!.url.pathname).toBe('/api/v1/projects/payment/environments/prod/configurations/application.yml');
        expect(server.records.every((record) => record.method === 'GET' && record.authorization === 'Bearer test-token')).toBe(true);
        expect(client.getStatus()).toBe(WatchStatus.WATCHING);
    });

    it('shares concurrent first reads and detaches every returned snapshot', async () => {
        const configs = await Promise.all(Array.from({ length: 20 }, () => client.getConfig('payment', 'prod', 'application.yml')));
        expect(server.initializations).toHaveLength(1);
        expect(server.reads).toHaveLength(1);
        configs[0]!.value = 'mutated';
        expect(configs[1]!.value).toContain('原文');
        expect((await client.getConfig('payment', 'prod', 'application.yml'))!.value).toContain('原文');
        expect(server.reads).toHaveLength(1);
    });

    it('keeps caches isolated between client instances', async () => {
        await client.getConfig('payment', 'prod', 'application.yml');
        await create().getConfig('payment', 'prod', 'application.yml');
        expect(server.initializations).toHaveLength(2);
        expect(server.reads).toHaveLength(2);
    });

    it('uses environment cache for individual keys and includes future keys', async () => {
        const configs = await client.getConfigs('payment', 'prod');
        expect(Object.isFrozen(configs)).toBe(true);
        configs[0]!.value = 'external mutation';
        expect((await client.getConfig('payment', 'prod', 'application.yml'))!.value).toContain('原文');
        expect(await client.getConfig('payment', 'prod', 'future')).toBeNull();
        expect(server.reads).toHaveLength(1);
        server.put('future', 'new');
        await wait(async () =>
            expect((await client.getConfigs('payment', 'prod')).map((item) => item.key)).toEqual(['application.yml', 'future']),
        );
    });

    it('distinguishes a missing key, missing ancestor, and unrelated HTTP errors', async () => {
        expect(await client.getConfig('payment', 'prod', 'missing')).toBeNull();
        expect(await client.getConfig('absent', 'prod', 'missing')).toBeNull();
        await expect(client.getConfigs('absent', 'prod')).rejects.toMatchObject({ statusCode: 404, code: 'project_not_found' });
        server.onRequest = () => failure(404, 'route_not_found');
        await expect(client.getConfig('payment', 'prod', 'other')).rejects.toMatchObject({ code: 'route_not_found' });
    });

    it.each(['text', 'boolean', 'number', 'json', 'yaml', 'properties', 'CUSTOM-format'])(
        'preserves raw values and type %s',
        async (type) => {
            server.put('key', '\n  unchanged  \n', type);
            expect(await client.getConfig('payment', 'prod', 'key')).toMatchObject({ type, value: '\n  unchanged  \n' });
        },
    );

    it('always fetches metadata and maps project_id to projectId', async () => {
        expect(await client.getProjects()).toHaveLength(1);
        expect(await client.getEnvironments('payment')).toHaveLength(1);
        expect(await client.getEnvironment('payment', 'prod')).toMatchObject({ projectId: 'p1', slug: 'prod' });
        expect(await client.getProject('payment')).toMatchObject({ slug: 'payment' });
        await client.getProject('payment');
        expect(server.records.filter(({ url }) => url.pathname === '/api/v1/projects/payment')).toHaveLength(2);
        expect(await client.getProject('absent')).toBeNull();
        expect(await client.getEnvironment('payment', 'absent')).toBeNull();
        expect(server.initializations).toHaveLength(0);
    });

    it.each([null, []])('returns an immutable empty collection for items=%s', async (items) => {
        server.onRequest = () => ({ body: { items } });
        const list = await client.getProjects();
        expect(list).toEqual([]);
        expect(Object.isFrozen(list)).toBe(true);
    });
});

describe('watching and recovery', () => {
    it('refreshes before callbacks, emits immutable server records, and sends no initial event', async () => {
        let observed: unknown;
        const listener = vi.fn(async (changes: readonly ConfigChange[]) => {
            observed = {
                frozen: Object.isFrozen(changes) && Object.isFrozen(changes[0]),
                value: (await client.getConfig('payment', 'prod', 'application.yml'))!.value,
            };
        });
        await client.addConfigListener('payment', 'prod', 'application.yml', listener);
        expect(listener).not.toHaveBeenCalled();
        server.put('application.yml', 'updated', 'yaml');
        await wait(() =>
            expect(listener).toHaveBeenCalledWith([expect.objectContaining({ revision: 2, type: 'updated', resource: 'config' })]),
        );
        expect(observed).toEqual({ frozen: true, value: 'updated' });
    });

    it('keeps a missing key subscribed through creation, deletion, and restoration', async () => {
        const listener = vi.fn();
        await client.addConfigListener('payment', 'prod', 'future', listener);
        expect(await client.getConfig('payment', 'prod', 'future')).toBeNull();
        server.put('future', 'created');
        await wait(async () => expect((await client.getConfig('payment', 'prod', 'future'))?.value).toBe('created'));
        server.delete('future');
        await wait(async () => expect(await client.getConfig('payment', 'prod', 'future')).toBeNull());
        server.put('future', 'restored');
        await wait(async () => expect((await client.getConfig('payment', 'prod', 'future'))?.value).toBe('restored'));
        expect(listener).toHaveBeenCalledTimes(3);
    });

    it('does not lose changes between watch initialization and the initial GET', async () => {
        const listener = vi.fn();
        await client.addConfigListener(listener);
        server.afterInitialize = () => {
            server.afterInitialize = undefined;
            server.put('application.yml', 'during initialization');
        };
        expect((await client.getConfig('payment', 'prod', 'application.yml'))!.value).toBe('during initialization');
        await wait(() => expect(listener).toHaveBeenCalled());
        expect(server.polls[0]!.url.searchParams.get('revision')).toBe('1');
    });

    it('retains the whole old snapshot and pending batch when any refresh fails', async () => {
        server.put('second', 'old');
        await client.getConfig('payment', 'prod', 'application.yml');
        await client.getConfig('payment', 'prod', 'second');
        const listener = vi.fn();
        await client.addConfigListener(listener);
        server.holdPolls = true;
        server.put('application.yml', 'new first');
        server.put('second', 'new second');
        server.onRequest = ({ url }) => (url.pathname.endsWith('/configurations/second') ? failure(503, 'unavailable') : undefined);
        server.holdPolls = false;
        server.flush();
        await wait(() => expect(client.getStatus()).toBe(WatchStatus.RETRYING));
        expect((await client.getConfig('payment', 'prod', 'application.yml'))!.value).toContain('原文');
        expect((await client.getConfig('payment', 'prod', 'second'))!.value).toBe('old');
        expect(listener).not.toHaveBeenCalled();
        expect(server.polls.some(({ url }) => Number(url.searchParams.get('revision')) >= 4)).toBe(false);
        server.onRequest = undefined;
        await wait(() => expect(listener).toHaveBeenCalledTimes(1));
        expect((await client.getConfig('payment', 'prod', 'application.yml'))!.value).toBe('new first');
        expect((await client.getConfig('payment', 'prod', 'second'))!.value).toBe('new second');
        expect(client.getWatchError()).toBeNull();
    });

    it.each([
        [410, 'revision_expired'],
        [409, 'revision_ahead'],
    ] as const)('reinitializes for %s %s without synthesizing changes', async (status, code) => {
        server.pollReplies.push(failure(status, code));
        const listener = vi.fn();
        await client.addConfigListener(listener);
        await client.getConfig('payment', 'prod', 'application.yml');
        await wait(() => expect(server.initializations).toHaveLength(2));
        await wait(() => expect(client.getStatus()).toBe(WatchStatus.WATCHING));
        expect(server.reads).toHaveLength(2);
        expect(listener).not.toHaveBeenCalled();
    });

    it('advances heartbeat progress without reloading configuration', async () => {
        server.pollReplies.push({ body: { revision: 20, changes: [] } });
        server.onRequest = ({ url }) => {
            if (url.pathname.endsWith('/watch') && url.searchParams.has('revision')) {
                server.revision = 20;
            }
            return undefined;
        };
        await client.getConfig('payment', 'prod', 'application.yml');
        await wait(() => expect(server.polls.length).toBeGreaterThanOrEqual(2));
        expect(server.reads).toHaveLength(1);
        expect(server.polls[0]!.url.searchParams.get('revision')).toBe('1');
        expect(server.polls[1]!.url.searchParams.get('revision')).toBe('20');
    });

    it('preserves old-scope events when expanding to an environment subscription', async () => {
        const listener = vi.fn();
        await client.addConfigListener('payment', 'prod', 'application.yml', listener);
        server.holdPolls = true;
        server.put('application.yml', 'changed');
        server.put('new', 'added');
        // Hold the old poll but allow the explicit catch-up request to return its batch.
        server.onRequest = ({ url }) => {
            if (url.pathname.endsWith('/watch') && url.searchParams.has('revision') && server.holdPolls) {
                server.holdPolls = false;
                return {
                    body: {
                        revision: server.revision,
                        changes: server.changes.filter(
                            (change) => change.revision > Number(url.searchParams.get('revision')) && change.key === 'application.yml',
                        ),
                    },
                };
            }
            return undefined;
        };
        expect(await client.getConfigs('payment', 'prod')).toHaveLength(2);
        await wait(() => expect(listener).toHaveBeenCalled());
        expect(server.initializations.at(-1)!.url.searchParams.getAll('scopes')).toEqual(['payment/prod']);
        expect(listener.mock.calls.flat(2).some((change) => (change as ConfigChange).key === 'application.yml')).toBe(true);
    });

    it.each([401, 403])('stops on HTTP %s while keeping successful cache readable', async (status) => {
        server.pollReplies.push(failure(status, 'denied'));
        await client.getConfig('payment', 'prod', 'application.yml');
        await wait(() => expect(client.getStatus()).toBe(WatchStatus.STOPPED));
        expect((await client.getConfig('payment', 'prod', 'application.yml'))!.value).toContain('原文');
        expect(client.getWatchError()).toMatchObject({ statusCode: status });
        await expect(client.getConfig('payment', 'prod', 'new')).rejects.toThrow('permanent error');
        expect(() => client.start()).toThrow('permanent error');
        expect(server.polls).toHaveLength(1);
    });

    it.each([408, 429, 503])('retries transient HTTP %s from the same checkpoint', async (status) => {
        server.pollReplies.push(failure(status, 'retry'));
        const statuses: WatchStatus[] = [];
        client.addStatusListener((status) => {
            statuses.push(status);
        });
        await client.getConfig('payment', 'prod', 'application.yml');
        await wait(() => expect(server.polls.length).toBeGreaterThanOrEqual(2));
        expect(server.polls[0]!.url.search).toBe(server.polls[1]!.url.search);
        await wait(() => expect(statuses).toContain(WatchStatus.WATCHING));
        expect(statuses).toContain(WatchStatus.RETRYING);
    });

    it.each([false, true])('removes deleted ancestor scopes and forwards the raw deletion (project=%s)', async (project) => {
        const listener = vi.fn();
        await client.addConfigListener(listener);
        await client.getConfig('payment', 'prod', 'application.yml');
        await wait(() => expect(server.waiters.size).toBe(1));
        server.deleteAncestor(project);
        await wait(() =>
            expect(listener).toHaveBeenCalledWith([expect.objectContaining({ resource: project ? 'project' : 'environment', key: null })]),
        );
        expect(client.getStatus()).toBe(WatchStatus.IDLE);
        expect(await client.getConfig('payment', 'prod', 'application.yml')).toBeNull();
    });

    it('prunes vanished ancestors even when the watch endpoint returns 404', async () => {
        server.pollReplies.push(failure(404, 'environment_not_found'));
        server.afterInitialize = () => {
            server.afterInitialize = undefined;
        };
        await client.getConfig('payment', 'prod', 'application.yml');
        server.environments.delete('payment/prod');
        await wait(() => expect(client.getStatus()).toBe(WatchStatus.IDLE));
        expect(await client.getConfig('payment', 'prod', 'application.yml')).toBeNull();
    });

    it('does not let a deleted old scope hide an unrelated new configuration', async () => {
        server.environments.set('other/prod', new Map());
        server.put('key', 'other value', 'text', 'other/prod');
        await client.getConfig('payment', 'prod', 'application.yml');
        server.environments.delete('payment/prod');
        expect((await client.getConfig('other', 'prod', 'key'))?.value).toBe('other value');
    });
});

describe('listeners and lifecycle', () => {
    it('global registration alone never starts HTTP traffic', async () => {
        await client.addConfigListener(() => {});
        expect(client.getStatus()).toBe(WatchStatus.IDLE);
        expect(server.records).toHaveLength(0);
    });

    it('deduplicates concurrent scoped registration and rolls back failed registration', async () => {
        const listener = vi.fn();
        await Promise.all(Array.from({ length: 5 }, () => client.addConfigListener('payment', 'prod', 'application.yml', listener)));
        expect(server.reads).toHaveLength(1);
        server.put('application.yml', 'changed');
        await wait(() => expect(listener).toHaveBeenCalledTimes(1));
        const failed = vi.fn();
        await expect(client.addConfigListener('missing', 'prod', failed)).rejects.toBeInstanceOf(LessConfigError);
        server.environments.set('missing/prod', new Map());
        await client.getConfigs('missing', 'prod');
        server.put('new', 'value', 'text', 'missing/prod');
        await wait(async () => expect(await client.getConfigs('missing', 'prod')).toHaveLength(1));
        expect(failed).not.toHaveBeenCalled();
    });

    it('isolates sync/async listener failures and removes all registrations of a function', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const bad = () => {
            throw new Error('sync listener');
        };
        const rejected = async () => {
            throw new Error('async listener');
        };
        const good = vi.fn();
        await client.addConfigListener(bad);
        await client.addConfigListener(rejected);
        await client.addConfigListener(good);
        await client.addConfigListener('payment', 'prod', 'application.yml', good);
        server.put('application.yml', 'first');
        await wait(() => expect(good).toHaveBeenCalledTimes(2));
        expect(warn).toHaveBeenCalledTimes(2);
        client.removeListener(good);
        client.removeListener(bad);
        client.removeListener(rejected);
        server.put('application.yml', 'second');
        await wait(async () => expect((await client.getConfig('payment', 'prod', 'application.yml'))!.value).toBe('second'));
        expect(good).toHaveBeenCalledTimes(2);
    });

    it('allows an async callback to load another key and close the client', async () => {
        server.put('second', '2');
        await client.addConfigListener('payment', 'prod', 'application.yml', async () => {
            expect((await client.getConfig('payment', 'prod', 'second'))?.value).toBe('2');
            client.close();
        });
        server.put('application.yml', 'changed');
        await wait(() => expect(client.getStatus()).toBe(WatchStatus.CLOSED));
    });

    it('serializes reentrant status transitions and permits closing during startup', async () => {
        const events: WatchStatus[] = [];
        client.addStatusListener((status) => {
            if (status === WatchStatus.WATCHING) {
                client.close();
            }
        });
        client.addStatusListener((status) => {
            events.push(status);
        });
        await client.getConfig('payment', 'prod', 'application.yml');
        expect(events).toEqual([WatchStatus.WATCHING, WatchStatus.CLOSED]);
        expect(server.polls).toHaveLength(0);
    });

    it('cancels an active long poll and rejects operations after close', async () => {
        server.holdPolls = true;
        await client.getConfig('payment', 'prod', 'application.yml');
        await wait(() => expect(server.waiters.size).toBe(1));
        client.close();
        client.close();
        await wait(() => expect(server.waiters.size).toBe(0));
        expect(client.getStatus()).toBe(WatchStatus.CLOSED);
        await expect(client.getProjects()).rejects.toThrow('closed');
        await expect(client.getConfig('payment', 'prod', 'application.yml')).rejects.toThrow('closed');
        expect(() => client.addStatusListener(() => {})).toThrow('closed');
        expect(() => client.getWatchError()).toThrow('closed');
    });
});
