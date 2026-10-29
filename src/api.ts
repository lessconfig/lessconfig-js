import { isPlainObject } from 'lodash-es';
import { LessConfigError } from './error.js';
import { HttpTransport } from './http.js';
import { identifier, scopePath } from './scope.js';
import type { Config, ConfigChange, ConfigId, Environment, Project } from './types.js';

/**
 * A validated watch watermark and the server invalidations covered by it.
 */
export interface WatchResult {
    /**
     * Global watermark to acknowledge only after every affected scope has refreshed.
     */
    readonly revision: number;
    /**
     * Immutable invalidations in revision order; empty for initialization and heartbeats.
     */
    readonly changes: readonly ConfigChange[];
}

/**
 * Rejects a malformed response before it can enter the cache.
 * @throws LessConfigError - Always, because the response violates the API contract.
 */
function invalid(): never {
    throw new LessConfigError('Invalid API response');
}

/**
 * Requires a plain JSON object before accessing response fields.
 * @param value - Untrusted response value.
 * @returns The validated object record.
 */
function object(value: unknown): Record<string, unknown> {
    if (!isPlainObject(value)) {
        invalid();
    }
    return value as Record<string, unknown>;
}

/**
 * Requires a primitive string without coercing or normalizing its content.
 * @param value - Untrusted field value.
 * @returns The original string.
 */
function string(value: unknown): string {
    if (typeof value !== 'string') {
        invalid();
    }
    return value;
}

/**
 * Requires a nonnegative revision within the JavaScript safe-integer range.
 * @param value - Untrusted revision field.
 * @returns The validated revision number.
 */
function revision(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        invalid();
    }
    return value;
}

/**
 * Decodes configuration content while preserving its raw value and type name.
 * @param value - Untrusted configuration response.
 * @returns A detached configuration object.
 */
function config(value: unknown): Config {
    const data = object(value);
    return {
        key: string(data.key),
        value: string(data.value),
        type: string(data.type),
        description: string(data.description),
        revision: revision(data.revision),
    };
}

/**
 * Decodes environment metadata and maps project_id to projectId.
 * @param value - Untrusted environment response.
 * @returns A detached environment object.
 */
function environment(value: unknown): Environment {
    const data = object(value);
    return {
        id: string(data.id),
        projectId: string(data.project_id),
        slug: string(data.slug),
        description: string(data.description),
        revision: revision(data.revision),
    };
}

/**
 * Decodes project identity and display metadata.
 * @param value - Untrusted project response.
 * @returns A detached project object.
 */
function project(value: unknown): Project {
    const data = object(value);
    return {
        id: string(data.id),
        slug: string(data.slug),
        name: string(data.name),
        icon: string(data.icon),
        description: string(data.description),
    };
}

/**
 * Decodes a collection envelope without changing server order.
 * @typeParam T - Decoded list item type.
 * @param value - Untrusted collection response.
 * @param parse - Decoder applied to each list entry.
 * @returns A frozen list, empty when items is null.
 */
function items<T>(value: unknown, parse: (item: unknown) => T): readonly T[] {
    const entries = object(value).items;
    if (entries === null) {
        return Object.freeze([]);
    }
    if (!Array.isArray(entries)) {
        invalid();
    }
    return Object.freeze(entries.map(parse));
}

/**
 * Converts recognized HTTP 404 business errors to an absent resource.
 * @typeParam T - Decoded resource type.
 * @param read - Operation that loads and decodes the resource.
 * @param codes - Business error codes that represent absence for this operation.
 * @returns The decoded resource, or null for a recognized missing-resource error.
 */
async function missing<T>(read: () => Promise<T>, codes: string[]): Promise<T | null> {
    try {
        return await read();
    } catch (error) {
        if (error instanceof LessConfigError && error.statusCode === 404 && codes.includes(error.code ?? '')) {
            return null;
        }
        throw error;
    }
}

/**
 * Builds the versioned path for one validated project.
 * @param value - Case-sensitive project slug.
 * @returns Project path relative to the configured API root.
 */
function projectPath(value: string): string {
    return `/v1/projects/${identifier(value, 'project')}`;
}

/**
 * Builds the versioned path for one validated environment.
 * @param project - Case-sensitive project slug.
 * @param environment - Case-sensitive environment slug.
 * @returns Environment path relative to the configured API root.
 */
function environmentPath(project: string, environment: string): string {
    return `${projectPath(project)}/environments/${identifier(environment, 'environment')}`;
}

/**
 * Validates a server-provided identifier as a protocol field.
 * @param value - Untrusted identifier from a change record.
 * @returns The validated identifier.
 * @throws LessConfigError - If the value is not a supported identifier.
 */
function changeIdentifier(value: unknown): string {
    try {
        return identifier(string(value), 'change identifier');
    } catch {
        return invalid();
    }
}

/** Validates every response before it can enter the client's cache. */
export class LessConfigApi {
    /**
     * Transport owned by this adapter; cancellation does not affect other adapters.
     */
    private readonly transport: HttpTransport;
    /**
     * Whole-request timeout for metadata reads, configuration reads, and ordinary initialization.
     */
    private readonly timeoutMs: number;

    /**
     * Creates an API adapter without opening a connection.
     * @param endpoint - Validated API root URL without a version.
     * @param token - Validated Bearer credential.
     * @param timeoutMs - Positive whole-request timeout in milliseconds.
     */
    constructor(endpoint: string, token: string, timeoutMs: number) {
        this.transport = new HttpTransport(endpoint, token);
        this.timeoutMs = timeoutMs;
    }

    /**
     * Reads one configuration directly from the server.
     * @param id - Validated identity with a non-null configuration key.
     * @returns A configuration, or null only for config_not_found.
     */
    getConfig(id: ConfigId): Promise<Config | null> {
        return missing(
            async () =>
                config(
                    await this.transport.get(
                        `${environmentPath(id.project, id.environment)}/configurations/${identifier(id.key!, 'key')}`,
                        this.timeoutMs,
                    ),
                ),
            ['config_not_found'],
        );
    }

    /**
     * Reads every current configuration in server order.
     * @param project - Case-sensitive project slug.
     * @param environment - Case-sensitive environment slug.
     * @returns A frozen list; a missing project or environment rejects the promise.
     */
    async getConfigs(project: string, environment: string): Promise<readonly Config[]> {
        return items(await this.transport.get(`${environmentPath(project, environment)}/configurations`, this.timeoutMs), config);
    }

    /**
     * Reads fresh environment metadata.
     * @param project - Case-sensitive project slug.
     * @param env - Case-sensitive environment slug.
     * @returns The environment, or null when it or its project is absent.
     */
    getEnvironment(project: string, env: string): Promise<Environment | null> {
        return missing(
            async () => environment(await this.transport.get(environmentPath(project, env), this.timeoutMs)),
            ['project_not_found', 'environment_not_found'],
        );
    }

    /**
     * Lists environments visible under the selected project.
     * @param project - Case-sensitive project slug.
     * @returns A frozen list in server order.
     */
    async getEnvironments(project: string): Promise<readonly Environment[]> {
        return items(await this.transport.get(`${projectPath(project)}/environments`, this.timeoutMs), environment);
    }

    /**
     * Reads fresh project metadata.
     * @param slug - Case-sensitive project slug.
     * @returns The project, or null when it is absent.
     */
    getProject(slug: string): Promise<Project | null> {
        return missing(async () => project(await this.transport.get(projectPath(slug), this.timeoutMs)), ['project_not_found']);
    }

    /**
     * Lists projects visible to the configured credential.
     * @returns A frozen list in server order.
     */
    async getProjects(): Promise<readonly Project[]> {
        return items(await this.transport.get('/v1/projects', this.timeoutMs), project);
    }

    /**
     * Initializes or polls selected scopes and validates the response before returning it.
     * @param scopes - Nonempty selection of validated key or environment identities.
     * @param previous - Last applied watermark, or null to initialize a watch.
     * @param timeoutSeconds - Server long-poll duration in whole seconds.
     * @param requestTimeoutMs - Whole-request timeout in milliseconds.
     * @returns The validated watermark and immutable change batch.
     * @throws LessConfigError - If the request fails or the response violates the watch protocol.
     */
    async watch(
        scopes: readonly ConfigId[],
        previous: number | null,
        timeoutSeconds: number,
        requestTimeoutMs: number,
    ): Promise<WatchResult> {
        const query = new URLSearchParams();
        for (const id of scopes) {
            query.append('scopes', scopePath(id));
        }
        if (previous !== null) {
            query.set('revision', String(previous));
            query.set('timeout', String(timeoutSeconds));
        }
        const data = object(await this.transport.get(`/v1/watch?${query}`, requestTimeoutMs));
        const next = revision(data.revision);
        if ((previous !== null && next < previous) || !Array.isArray(data.changes)) {
            invalid();
        }
        let lastRevision = previous ?? -1;
        const changes = data.changes.map((entry: unknown): ConfigChange => {
            const item = object(entry);
            const eventRevision = revision(item.revision);
            const resource = string(item.resource);
            const type = string(item.type);
            /**
             * Decodes project identity and display metadata.
             * @param value - Untrusted project response.
             * @returns A detached project object.
             */
            const project = changeIdentifier(item.project);
            /**
             * Decodes environment metadata and maps project_id to projectId.
             * @param value - Untrusted environment response.
             * @returns A detached environment object.
             */
            const environment = item.environment == null ? null : changeIdentifier(item.environment);
            const key = item.key == null ? null : changeIdentifier(item.key);
            if (
                eventRevision > next ||
                eventRevision < lastRevision ||
                (previous !== null && eventRevision <= previous) ||
                (resource !== 'config' && resource !== 'environment' && resource !== 'project') ||
                (type !== 'created' && type !== 'updated' && type !== 'deleted' && type !== 'restored') ||
                (resource === 'config' && (environment === null || key === null)) ||
                (resource === 'environment' && (environment === null || key !== null)) ||
                (resource === 'project' && (environment !== null || key !== null))
            ) {
                invalid();
            }
            lastRevision = eventRevision;
            return Object.freeze({ revision: eventRevision, project, environment, key, resource, type });
        });
        if (previous === null && changes.length !== 0) {
            invalid();
        }
        return Object.freeze({ revision: next, changes: Object.freeze(changes) });
    }

    /**
     * Cancels in-flight requests while leaving the adapter reusable.
     */
    cancel(): void {
        this.transport.cancel();
    }
    /**
     * Cancels outstanding requests and permanently closes this adapter.
     */
    close(): void {
        this.transport.close();
    }
}
