import type { LessConfigError } from './error.js';

/** Known formats. Config.type preserves unfamiliar server strings as well. */
export const ConfigType = Object.freeze({
    /** Plain text configuration. */
    TEXT: 'text',
    /** Boolean content preserved as its original text. */
    BOOLEAN: 'boolean',
    /** Numeric content preserved as its original text. */
    NUMBER: 'number',
    /** JSON content without automatic parsing. */
    JSON: 'json',
    /** YAML content with whitespace and comments preserved. */
    YAML: 'yaml',
    /** Java properties content without automatic parsing. */
    PROPERTIES: 'properties',
} as const);

/** A detached configuration snapshot. Values retain their original text. */
export interface Config {
    /** Case-sensitive configuration key within its environment. */
    key: string;
    /** Original configuration content, including whitespace and comments. */
    value: string;
    /** Server format label, including unfamiliar future formats. */
    type: string;
    /** Human-readable description supplied by the server. */
    description: string;
    /** Resource revision, separate from the global watch position. */
    revision: number;
}

/** Project identity and display metadata returned by the server. */
export interface Project {
    /** Server-assigned project identity, distinct from its public slug. */
    id: string;
    /** Case-sensitive project identifier used in API paths and subscriptions. */
    slug: string;
    /** Human-readable project display name. */
    name: string;
    /** Server-provided icon name. */
    icon: string;
    /** Human-readable project description. */
    description: string;
}

/** Environment identity and resource metadata within one project. */
export interface Environment {
    /** Server-assigned environment identity, distinct from its public slug. */
    id: string;
    /** Server-assigned identity of the owning project; mapped from project_id. */
    projectId: string;
    /** Case-sensitive environment identifier used in API paths and subscriptions. */
    slug: string;
    /** Human-readable environment description. */
    description: string;
    /** Environment resource revision, separate from global watch progress. */
    revision: number;
}

/** A null key selects every current and future key in an environment. */
export interface ConfigId {
    /** Case-sensitive project slug. */
    readonly project: string;
    /** Case-sensitive environment slug within the project. */
    readonly environment: string;
    /** Configuration key, or null for an entire-environment selection. */
    readonly key: string | null;
}

/** Server invalidation delivered after the affected cache has refreshed. */
export interface ConfigChange {
    /** Global revision of this event, which may precede the response watermark. */
    readonly revision: number;
    /** Case-sensitive slug of the project containing the changed resource. */
    readonly project: string;
    /** Environment slug, or null for a project-level invalidation. */
    readonly environment: string | null;
    /** Configuration key, or null for an environment or project invalidation. */
    readonly key: string | null;
    /** Kind of server resource affected by this invalidation. */
    readonly resource: 'config' | 'environment' | 'project';
    /** Operation applied to the resource by the server. */
    readonly type: 'created' | 'updated' | 'deleted' | 'restored';
}

/** Observable lifecycle and health states of a client's background watcher. */
export const WatchStatus = Object.freeze({
    /** No configuration scope is currently subscribed. */
    IDLE: 'IDLE',
    /** The cache is synchronized and polling proceeds normally. */
    WATCHING: 'WATCHING',
    /** Background recovery is in progress; successful cached values remain readable. */
    RETRYING: 'RETRYING',
    /** A permanent error stopped watching; existing cached values remain readable. */
    STOPPED: 'STOPPED',
    /** The client has been disposed and cannot be reused. */
    CLOSED: 'CLOSED',
} as const);
/** Union of the supported watcher lifecycle and health-state values. */
export type WatchStatus = (typeof WatchStatus)[keyof typeof WatchStatus];

/**
 * Receives server invalidations after all matching cache refreshes succeed.
 * Callbacks run serially and returned promises are awaited; keep callbacks short.
 * @param changes - Nonempty immutable batch matching the listener's registered scope.
 * @returns Nothing, or a promise resolved when callback processing finishes.
 */
export type ConfigListener = (changes: readonly ConfigChange[]) => void | Promise<void>;

/**
 * Observes lifecycle transitions without blocking on asynchronous callback completion.
 * Callback exceptions and rejected promises are isolated from the watcher.
 * @param status - New watcher lifecycle or health state.
 * @param error - Associated failure, or null for a healthy transition.
 * @returns Nothing, or a promise whose rejection will be reported independently.
 */
export type StatusListener = (status: WatchStatus, error: LessConfigError | null) => void | Promise<void>;

/** Connection, timeout, and background-retry settings validated during construction. */
export interface LessConfigClientOptions {
    /** Absolute HTTP(S) API root, e.g. https://example.com/api (without /v1). */
    endpoint: string;
    /** Bearer token used by every request. */
    token: string;
    /** Whole-request timeout, including the response body. Default: 10,000 ms. */
    requestTimeoutMs?: number;
    /** Server long-poll timeout, integer 1–300. Default: 60 seconds. */
    watchTimeoutSeconds?: number;
    /** Must exceed the server long-poll timeout. Default: 90,000 ms. */
    watchRequestTimeoutMs?: number;
    /** Initial background retry delay. Default: 1,000 ms. */
    retryInitialDelayMs?: number;
    /** Maximum exponential retry delay. Default: 30,000 ms. */
    retryMaxDelayMs?: number;
}
