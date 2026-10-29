import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Config, ConfigChange } from '../src/index.js';

/**
 * An HTTP request observed by the in-process protocol fixture.
 */
export interface RequestRecord {
    /**
     * Absolute request URL, including watch query parameters.
     */
    url: URL;
    /**
     * Received Authorization header, if present.
     */
    authorization: string | undefined;
    /**
     * HTTP request method supplied by the client.
     */
    method: string | undefined;
}
/**
 * A fixture response that may represent valid data or a deliberate protocol failure.
 */
export interface Reply {
    /**
     * HTTP status, defaulting to 200 when omitted.
     */
    status?: number;
    /**
     * JSON-serializable value or raw response text.
     */
    body: unknown;
    /**
     * Extra response headers, overriding the default JSON content type.
     */
    headers?: Record<string, string>;
}
/**
 * Builds an HTTP error response with a stable business code.
 * @param status - HTTP error status.
 * @param code - Business code also used as the fixture error message.
 * @returns The fixture response.
 */
export const failure = (status: number, code: string): Reply => ({ status, body: { code, message: code } });

/** Real HTTP fixture: the SDK under test always uses the runtime's native fetch. */
export class TestServer {
    /** Open sockets tracked for cleanup on every supported Node.js version. */
    private readonly sockets = new Set<Socket>();
    /**
     * Requests received by this fixture in arrival order.
     */
    readonly records: RequestRecord[] = [];
    /**
     * Existing environments and their mutable configuration records.
     */
    readonly environments = new Map<string, Map<string, Config>>([['payment/prod', new Map()]]);
    /**
     * Server invalidation history in increasing revision order.
     */
    readonly changes: ConfigChange[] = [];
    /**
     * Scripted replies consumed by subsequent long polls.
     */
    readonly pollReplies: Reply[] = [];
    /**
     * Pending long-poll notifications that can be awakened by a mutation.
     */
    readonly waiters = new Set<() => void>();
    /**
     * Loopback HTTP server used by native fetch integration tests.
     */
    readonly server = createServer((request, response) => {
        const record = { url: new URL(request.url!, this.endpoint), authorization: request.headers.authorization, method: request.method };
        this.records.push(record);
        void this.handle(record, response).catch((error: unknown) =>
            this.send(response, { status: 500, body: { message: String(error) } }),
        );
    });
    /**
     * Current global server watermark.
     */
    revision = 0;
    /**
     * Unversioned API root, replaced with the allocated port on start.
     */
    endpoint = 'http://127.0.0.1';
    /**
     * Optional hook run after sending watch initialization, to exercise load races.
     */
    afterInitialize: (() => void) | undefined;
    /**
     * Optional request hook returning an overriding reply or undefined for normal routing.
     */
    onRequest: ((request: RequestRecord) => Reply | undefined | Promise<Reply | undefined>) | undefined;
    /**
     * Whether long polls should stay pending despite changes or heartbeat timers.
     */
    holdPolls = false;

    /**
     * Seeds the fixture with a UTF-8 YAML configuration.
     */
    constructor() {
        this.server.on('connection', (socket) => {
            this.sockets.add(socket);
            socket.on('close', () => this.sockets.delete(socket));
        });
        this.put('application.yml', '# 原文\nport: 8080\n', 'yaml');
    }

    /**
     * Starts the loopback server on an automatically allocated port.
     * @returns This fixture after its endpoint becomes available.
     */
    async start(): Promise<this> {
        await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
        this.endpoint = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/api`;
        return this;
    }

    /**
     * Closes active connections and stops the fixture server.
     * @returns A promise resolved after the listening socket closes.
     */
    async close(): Promise<void> {
        for (const socket of this.sockets) {
            socket.destroy();
        }
        await new Promise<void>((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
    }

    /**
     * Creates or updates a fixture configuration and awakens matching polls.
     * @param key - Configuration key to write.
     * @param value - Raw configuration content.
     * @param type - Server format label, defaulting to text.
     * @param env - Existing project/environment path, defaulting to payment/prod.
     */
    put(key: string, value: string, type = 'text', env = 'payment/prod'): void {
        const configs = this.environments.get(env)!;
        const operation = configs.has(key) ? 'updated' : 'created';
        const revision = ++this.revision;
        configs.set(key, { key, value, type, description: '说明', revision });
        const [project, environment] = env.split('/') as [string, string];
        this.changes.push({ revision, project, environment, key, resource: 'config', type: operation });
        this.flush();
    }

    /**
     * Deletes a configuration from the default environment and emits an invalidation.
     * @param key - Configuration key to remove.
     */
    delete(key: string): void {
        this.environments.get('payment/prod')!.delete(key);
        this.changes.push({ revision: ++this.revision, project: 'payment', environment: 'prod', key, resource: 'config', type: 'deleted' });
        this.flush();
    }

    /**
     * Deletes the default environment and emits a project or environment invalidation.
     * @param project - Whether to describe the deletion as a project deletion.
     */
    deleteAncestor(project: boolean): void {
        this.environments.delete('payment/prod');
        this.changes.push({
            revision: ++this.revision,
            project: 'payment',
            environment: project ? null : 'prod',
            key: null,
            resource: project ? 'project' : 'environment',
            type: 'deleted',
        });
        this.flush();
    }

    /**
     * Wakes pending polls so each can inspect the latest fixture state.
     */
    flush(): void {
        for (const send of [...this.waiters]) {
            send();
        }
    }

    /**
     * Selects watch requests that include a previous watermark.
     * @returns Observed long-poll requests in arrival order.
     */
    get polls(): RequestRecord[] {
        return this.records.filter(({ url }) => url.pathname.endsWith('/watch') && url.searchParams.has('revision'));
    }

    /**
     * Selects watch requests without a previous watermark.
     * @returns Observed initialization requests in arrival order.
     */
    get initializations(): RequestRecord[] {
        return this.records.filter(({ url }) => url.pathname.endsWith('/watch') && !url.searchParams.has('revision'));
    }

    /**
     * Selects configuration GET requests.
     * @returns Observed configuration reads in arrival order.
     */
    get reads(): RequestRecord[] {
        return this.records.filter(({ url }) => url.pathname.includes('/configurations'));
    }

    /**
     * Writes one fixture response unless its connection has already closed.
     * @param response - HTTP response stream to complete.
     * @param reply - Status, body, and optional headers to send.
     */
    private send(response: ServerResponse, reply: Reply): void {
        if (response.destroyed || response.writableEnded) {
            return;
        }
        response.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...reply.headers });
        response.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
    }

    /**
     * Distinguishes absent projects from absent environments.
     * @param env - Requested project/environment path.
     * @returns The appropriate missing-resource reply.
     */
    private absent(env: string): Reply {
        const project = env.split('/')[0];
        return failure(
            404,
            [...this.environments.keys()].some((key) => key.startsWith(project + '/')) ? 'environment_not_found' : 'project_not_found',
        );
    }

    /**
     * Routes one fixture request or dispatches an explicitly scripted response.
     * @param record - Observed request metadata.
     * @param response - HTTP response stream to complete or hold for a long poll.
     * @returns A promise resolved once the response is sent or its long poll is registered.
     */
    private async handle(record: RequestRecord, response: ServerResponse): Promise<void> {
        const override = await this.onRequest?.(record);
        if (override) {
            this.send(response, override);
            return;
        }
        const { url } = record;
        if (url.pathname === '/api/v1/watch') {
            const scopes = url.searchParams.getAll('scopes');
            for (const scope of scopes) {
                const env = scope.split('/').slice(0, 2).join('/');
                if (!this.environments.has(env)) {
                    this.send(response, this.absent(env));
                    return;
                }
            }
            if (!url.searchParams.has('revision')) {
                this.send(response, { body: { revision: this.revision, changes: [] } });
                this.afterInitialize?.();
                return;
            }
            const reply = this.pollReplies.shift();
            if (reply) {
                this.send(response, reply);
                return;
            }
            const previous = Number(url.searchParams.get('revision'));
            /**
             * Completes a pending poll when matching changes or a heartbeat are available.
             * @param heartbeat - Whether an empty change batch may complete the poll.
             */
            const finish = (heartbeat = false) => {
                if (this.holdPolls) {
                    return;
                }
                const changes = this.changes.filter(
                    (change) =>
                        change.revision > previous &&
                        scopes.some((scope) => {
                            const [project, environment, key] = scope.split('/');
                            return (
                                project === change.project &&
                                (change.environment === null || change.environment === environment) &&
                                (change.key === null || key === undefined || change.key === key)
                            );
                        }),
                );
                if (!heartbeat && changes.length === 0) {
                    return;
                }
                clearTimeout(timer);
                this.waiters.delete(notify);
                this.send(response, { body: { revision: this.revision, changes } });
            };
            /** Rechecks pending changes when a fixture mutation wakes this poll. */
            const notify = () => finish();
            const timer = setTimeout(() => finish(true), 50);
            this.waiters.add(notify);
            response.on('close', () => {
                clearTimeout(timer);
                this.waiters.delete(notify);
            });
            finish();
            return;
        }
        const parts = url.pathname.split('/').slice(3);
        const project = parts[1];
        const environment = parts[3];
        const metadata = { id: 'p1', slug: 'payment', name: 'Payment', icon: 'folder-simple', description: '说明' };
        if (url.pathname === '/api/v1/projects') {
            this.send(response, { body: { items: [metadata] } });
            return;
        }
        if (![...this.environments.keys()].some((env) => env.startsWith(project + '/'))) {
            this.send(response, failure(404, 'project_not_found'));
            return;
        }
        if (parts.length === 2) {
            this.send(response, { body: { ...metadata, slug: project } });
            return;
        }
        const envMeta = { id: 'e1', project_id: 'p1', slug: environment, description: '生产', revision: this.revision };
        if (parts.length === 3) {
            this.send(response, { body: { items: [{ ...envMeta, slug: 'prod' }] } });
            return;
        }
        const configs = this.environments.get(`${project}/${environment}`);
        if (!configs) {
            this.send(response, failure(404, 'environment_not_found'));
            return;
        }
        if (parts.length === 4) {
            this.send(response, { body: envMeta });
            return;
        }
        if (parts.length === 5) {
            this.send(response, { body: { items: [...configs.values()] } });
            return;
        }
        const config = configs.get(parts[5]!);
        this.send(response, config ? { body: config } : failure(404, 'config_not_found'));
    }
}
