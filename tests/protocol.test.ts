import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LessConfigClient, LessConfigError, WatchStatus } from '../src/index.js';
import { TestServer, failure } from './server.js';

let server: TestServer;
let client: LessConfigClient;
/**
 * Waits for an observable protocol condition without fixed sleeps.
 * @param assertion - Assertion retried until it passes or the test deadline expires.
 * @returns A promise resolved with the successful assertion result.
 */
const wait = (assertion: () => unknown) => vi.waitFor(assertion, { timeout: 2_000, interval: 10 });
beforeEach(async () => {
    server = await new TestServer().start();
    client = new LessConfigClient({
        endpoint: server.endpoint + '///',
        token: 'test-token',
        requestTimeoutMs: 100,
        watchTimeoutSeconds: 1,
        watchRequestTimeoutMs: 1_100,
        retryInitialDelayMs: 20,
        retryMaxDelayMs: 100,
    });
});
afterEach(async () => {
    client.close();
    await server.close();
});

describe('input validation', () => {
    it.each([
        '',
        'file:///tmp/test',
        'http://',
        'https://user:pass@example.com',
        'https://example.com?',
        'https://example.com#',
        ' https://example.com',
        'https:\\example.com',
    ])('rejects invalid endpoint %j', (endpoint) => {
        expect(() => new LessConfigClient({ endpoint, token: 'token' })).toThrow(TypeError);
    });

    it.each(['', ' ', 'token\r\nHeader: bad'])('rejects invalid token %j', (token) => {
        expect(() => new LessConfigClient({ endpoint: server.endpoint, token })).toThrow(TypeError);
    });

    it.each([
        { requestTimeoutMs: 0 },
        { requestTimeoutMs: 0.5 },
        { requestTimeoutMs: Infinity },
        { requestTimeoutMs: 2_147_483_648 },
        { watchTimeoutSeconds: 0 },
        { watchTimeoutSeconds: 301 },
        { watchTimeoutSeconds: 1.5 },
        { watchRequestTimeoutMs: 60_000 },
        { retryInitialDelayMs: -1 },
        { retryInitialDelayMs: 20, retryMaxDelayMs: 10 },
        { retryMaxDelayMs: NaN },
    ])('rejects invalid timeout/retry settings %j', (options) => {
        expect(() => new LessConfigClient({ endpoint: server.endpoint, token: 'token', ...options })).toThrow(TypeError);
    });

    it.each(['', '.', '..', '../key', 'a/b', 'a?x', '中文', 'line\n'])(
        'rejects identifier %j before sending any request',
        async (value) => {
            await expect(client.getConfig('payment', 'prod', value)).rejects.toThrow(TypeError);
            await expect(client.getConfigs('payment', value)).rejects.toThrow(TypeError);
            await expect(client.getProject(value)).rejects.toThrow(TypeError);
            expect(server.records).toHaveLength(0);
        },
    );

    it('preserves case and legal punctuation in keys', async () => {
        server.put('_Key.A-1', 'value');
        expect((await client.getConfig('payment', 'prod', '_Key.A-1'))?.value).toBe('value');
    });
});

describe('HTTP and decoding', () => {
    it.each([
        { body: '<html>broken</html>', status: 502, code: null },
        { body: '', status: 503, code: null },
        { body: { code: 12, message: [] }, status: 401, code: null },
        { body: { code: 'forbidden', message: 'Denied' }, status: 403, code: 'forbidden' },
    ])('preserves HTTP status for malformed/non-JSON errors: $status', async ({ body, status, code }) => {
        server.onRequest = () => ({ body, status });
        await expect(client.getProjects()).rejects.toMatchObject({ statusCode: status, code });
    });

    it('refuses redirects without sending credentials to their destination', async () => {
        const destination = await new TestServer().start();
        try {
            server.onRequest = () => ({ status: 302, body: '', headers: { Location: destination.endpoint + '/v1/projects' } });
            await expect(client.getProjects()).rejects.toMatchObject({ statusCode: 302 });
            expect(destination.records).toHaveLength(0);
        } finally {
            await destination.close();
        }
    });

    it.each(['not json', 'null', '[]', '{}', '{"items":{}}', '{"items":[{}]}'])('rejects malformed successful JSON %s', async (body) => {
        server.onRequest = () => ({ body });
        await expect(client.getProjects()).rejects.toBeInstanceOf(LessConfigError);
    });

    it.each([-1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1, null])('rejects invalid resource revision %s', async (revision) => {
        server.onRequest = ({ url }) =>
            url.pathname.includes('/configurations/')
                ? { body: { key: 'key', value: 'text', type: 'text', description: '', revision } }
                : undefined;
        await expect(client.getConfig('payment', 'prod', 'key')).rejects.toMatchObject({ message: 'Invalid API response' });
    });

    it('times out requests and can make a successful request afterwards', async () => {
        server.onRequest = () => new Promise(() => {});
        await expect(client.getProjects()).rejects.toMatchObject({ message: 'HTTP request timed out', statusCode: 0 });
        server.onRequest = undefined;
        expect(await client.getProjects()).toHaveLength(1);
    });

    it('bounds reading the response body as well as receiving its headers', async () => {
        server.server.removeAllListeners('request');
        server.server.on('request', (_request, response) => {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.flushHeaders();
            response.write('{"items":');
        });
        await expect(client.getProjects()).rejects.toMatchObject({ message: 'HTTP request timed out' });
    });

    it('cancels concurrent foreground loads on close', async () => {
        server.onRequest = () => new Promise(() => {});
        const reads = [client.getProjects(), client.getProject('payment'), client.getConfig('payment', 'prod', 'key')];
        const results = Promise.allSettled(reads);
        await wait(() => expect(server.records).toHaveLength(3));
        client.close();
        expect((await results).every((result) => result.status === 'rejected')).toBe(true);
        expect(client.getStatus()).toBe(WatchStatus.CLOSED);
    });

    it('wraps native fetch network failures', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network failure')));
        await expect(client.getProjects()).rejects.toMatchObject({ name: 'LessConfigError', statusCode: 0, cause: expect.any(TypeError) });
    });
});

describe('watch protocol validation', () => {
    const change = { revision: 2, project: 'payment', environment: 'prod', key: 'application.yml', resource: 'config', type: 'updated' };
    it.each([
        { revision: 0, changes: [] },
        { revision: '2', changes: [] },
        { revision: 2, changes: null },
        { revision: 2, changes: [{ ...change, revision: 3 }] },
        { revision: 2, changes: [{ ...change, revision: 1 }] },
        { revision: 2, changes: [{ ...change, key: null }] },
        { revision: 2, changes: [{ ...change, project: '../escape' }] },
        { revision: 2, changes: [{ ...change, resource: 'unknown' }] },
        { revision: 2, changes: [{ ...change, type: 'unknown' }] },
        { revision: 2, changes: [{ ...change, resource: 'project' }] },
        { revision: 3, changes: [{ ...change, revision: 3 }, change] },
    ])('keeps the prior cache and checkpoint for malformed watch response %j', async (body) => {
        server.pollReplies.push({ body });
        const statuses: WatchStatus[] = [];
        const listener = vi.fn();
        client.addStatusListener((status) => {
            statuses.push(status);
        });
        await client.addConfigListener(listener);
        await client.getConfig('payment', 'prod', 'application.yml');
        await wait(() => expect(server.polls.length).toBeGreaterThanOrEqual(2));
        expect(statuses).toContain(WatchStatus.RETRYING);
        expect(server.polls[1]!.url.searchParams.get('revision')).toBe('1');
        expect(server.reads).toHaveLength(1);
        expect(listener).not.toHaveBeenCalled();
    });

    it('rejects initialization responses that contain change records', async () => {
        server.onRequest = () => ({ body: { revision: 2, changes: [change] } });
        await expect(client.getConfig('payment', 'prod', 'application.yml')).rejects.toThrow('Invalid API response');
        expect(server.reads).toHaveLength(0);
    });

    it('deduplicates and removes status observers, isolating async failures', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const observer = vi.fn();
        client.addStatusListener(observer);
        client.addStatusListener(observer);
        client.addStatusListener(async () => {
            throw new Error('listener');
        });
        server.pollReplies.push(failure(403, 'forbidden'));
        await client.getConfig('payment', 'prod', 'application.yml');
        await wait(() => expect(client.getStatus()).toBe(WatchStatus.STOPPED));
        expect(observer.mock.calls.map(([status]) => status)).toEqual([WatchStatus.WATCHING, WatchStatus.STOPPED]);
        expect(warn).toHaveBeenCalledTimes(2);
        client.removeStatusListener(observer);
        client.close();
        expect(observer).toHaveBeenCalledTimes(2);
    });
});
