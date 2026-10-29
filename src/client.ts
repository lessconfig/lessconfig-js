import { LessConfigApi, type WatchResult } from './api.js';
import { CancelledError, LessConfigError, missingAncestor, resetRequired } from './error.js';
import { normalizeEndpoint } from './http.js';
import { affects, covers, identifier, scope, scopePath } from './scope.js';
import {
    WatchStatus,
    type Config,
    type ConfigChange,
    type ConfigId,
    type ConfigListener,
    type Environment,
    type LessConfigClientOptions,
    type Project,
    type StatusListener,
} from './types.js';

/**
 * One subscribed identity and its last successfully loaded configuration list.
 */
interface CachedScope {
    /**
     * Validated key or whole-environment selection.
     */
    readonly id: ConfigId;
    /**
     * Internal configuration snapshot, never exposed directly to callers.
     */
    readonly configs: readonly Config[];
}
/**
 * Cache contents and global watch progress published together as one snapshot.
 */
interface State {
    /**
     * Subscribed scopes indexed by their public watch path.
     */
    readonly scopes: ReadonlyMap<string, CachedScope>;
    /**
     * Last applied watermark, or null when the selection needs initialization.
     */
    readonly revision: number | null;
}
/**
 * One listener registration and its optional initialization task.
 */
interface Registration {
    /**
     * Selected scope, or null to observe all client subscriptions.
     */
    readonly id: ConfigId | null;
    /**
     * Callback invoked after matching cached values have refreshed.
     */
    readonly listener: ConfigListener;
    /**
     * Shared initialization promise for duplicate scoped registrations.
     */
    ready?: Promise<void>;
}
/**
 * A lifecycle notification queued for ordered, reentrant-safe delivery.
 */
interface StatusEvent {
    /**
     * Lifecycle state at the time the transition occurred.
     */
    readonly status: WatchStatus;
    /**
     * Associated background failure, or null for a healthy transition.
     */
    readonly error: LessConfigError | null;
}
/**
 * A watch batch retained until its entire refresh can be committed.
 */
interface Pending {
    /**
     * Snapshot against which this response was requested.
     */
    readonly base: State;
    /**
     * Validated response whose watermark has not yet been acknowledged.
     */
    readonly result: WatchResult;
}

/**
 * Validates a duration before passing it to a JavaScript timer.
 * @param value - Duration in whole milliseconds.
 * @param name - Option name used in validation errors.
 * @returns The validated duration.
 * @throws TypeError - If the duration is outside the supported timer range.
 */
function milliseconds(value: number, name: string): number {
    if (!Number.isInteger(value) || value < 1 || value > 2_147_483_647) {
        throw new TypeError(`${name} must be an integer between 1 and 2147483647 milliseconds`);
    }
    return value;
}

/**
 * Rejects values that cannot be called as listener functions.
 * @param listener - Candidate configuration or status callback.
 * @throws TypeError - If the value is not a function.
 */
function checkListener(listener: unknown): void {
    if (typeof listener !== 'function') {
        throw new TypeError('listener must be a function');
    }
}

/**
 * Finds an exact or covering environment subscription in a snapshot.
 * @param state - Cache snapshot to inspect.
 * @param requested - Key or environment selection to locate.
 * @returns The cached list, including an empty list, or undefined when unsubscribed.
 */
function find(state: State, requested: ConfigId): readonly Config[] | undefined {
    for (const entry of state.scopes.values()) {
        if (covers(entry.id, requested)) {
            return entry.configs;
        }
    }
    return undefined;
}

/**
 * Expands a subscription selection, merging keys covered by a new environment scope.
 * @param scopes - Existing subscribed scopes.
 * @param requested - New scope to add.
 * @returns A new selection with a placeholder for the requested scope.
 */
function select(scopes: ReadonlyMap<string, CachedScope>, requested: ConfigId): ReadonlyMap<string, CachedScope> {
    const selected = new Map(scopes);
    for (const [key, entry] of selected) {
        if (covers(requested, entry.id)) {
            selected.delete(key);
        }
    }
    selected.set(scopePath(requested), { id: requested, configs: [] });
    return selected;
}

/**
 * Collects subscription identities in their existing iteration order.
 * @param scopes - Subscribed scope records.
 * @returns The identities to send to the watch endpoint.
 */
function ids(scopes: ReadonlyMap<string, CachedScope>): ConfigId[] {
    return [...scopes.values()].map((entry) => entry.id);
}

/**
 * A lazy, native-fetch client with an instance-local cache and one long-poll loop.
 * Reuse the instance across reads and call close() when its owner is disposed.
 */
export class LessConfigClient {
    /**
     * Adapter used for foreground reads, initialization, and cache refreshes.
     */
    private readonly api: LessConfigApi;
    /**
     * Independent adapter whose long poll can be cancelled after a scope change.
     */
    private readonly watchApi: LessConfigApi;
    /**
     * Whole-request timeout for ordinary reads and initialization, in milliseconds.
     */
    private readonly requestTimeoutMs: number;
    /**
     * Maximum time the server should hold one long poll, in seconds.
     */
    private readonly watchTimeoutSeconds: number;
    /**
     * Whole-request timeout for a long poll, in milliseconds.
     */
    private readonly watchRequestTimeoutMs: number;
    /**
     * Initial retry delay, restored after a successful watch cycle.
     */
    private readonly retryInitialDelayMs: number;
    /**
     * Upper bound for exponential retry delays, in milliseconds.
     */
    private readonly retryMaxDelayMs: number;
    /**
     * Last atomically published cache and global watch watermark.
     */
    private state: State = { scopes: new Map(), revision: null };
    /**
     * Unacknowledged watch response retained across failed refresh attempts.
     */
    private pending: Pending | null = null;
    /**
     * Unique callback-and-scope registrations for configuration changes.
     */
    private readonly listeners = new Set<Registration>();
    /**
     * Unique observers of lifecycle transitions and background failures.
     */
    private readonly statusListeners = new Set<StatusListener>();
    /**
     * Applied change batches waiting for delivery outside the update queue.
     */
    private readonly notifications: (readonly ConfigChange[])[] = [];
    /**
     * Status transitions waiting for ordered observer invocation.
     */
    private readonly statusEvents: StatusEvent[] = [];
    /**
     * Whether a dispatcher is already draining reentrant status transitions.
     */
    private dispatchingStatus = false;
    /**
     * Current observable lifecycle and watch-health state.
     */
    private status: WatchStatus = WatchStatus.IDLE;
    /**
     * Most recent background failure, cleared after successful recovery.
     */
    private watchError: LessConfigError | null = null;
    /**
     * Whether the client has been permanently disposed.
     */
    private closed = false;
    /**
     * Whether a permanent background error forbids further subscriptions.
     */
    private stopped = false;
    /**
     * Whether this instance currently owns an active asynchronous watch loop.
     */
    private running = false;
    /**
     * Queue tail that serializes snapshot mutations and absorbs prior operation failures.
     */
    private updateTail: Promise<void> = Promise.resolve();
    /**
     * Callback that interrupts the current retry delay, or null when not waiting.
     */
    private wake: (() => void) | null = null;

    /**
     * Creates a lazy client and validates its connection and timeout settings.
     * @param options - API root, Bearer credential, and optional request/watch/retry settings.
     * @throws TypeError - If an endpoint, credential, or timing option is invalid.
     */
    constructor(options: LessConfigClientOptions) {
        const endpoint = normalizeEndpoint(options.endpoint);
        if (typeof options.token !== 'string' || !options.token.trim() || /[\r\n]/.test(options.token)) {
            throw new TypeError('token must be nonempty and contain no line breaks');
        }
        this.requestTimeoutMs = milliseconds(options.requestTimeoutMs ?? 10_000, 'requestTimeoutMs');
        this.watchTimeoutSeconds = options.watchTimeoutSeconds ?? 60;
        if (!Number.isInteger(this.watchTimeoutSeconds) || this.watchTimeoutSeconds < 1 || this.watchTimeoutSeconds > 300) {
            throw new TypeError('watchTimeoutSeconds must be an integer between 1 and 300');
        }
        this.watchRequestTimeoutMs = milliseconds(options.watchRequestTimeoutMs ?? 90_000, 'watchRequestTimeoutMs');
        if (this.watchRequestTimeoutMs <= this.watchTimeoutSeconds * 1_000) {
            throw new TypeError('watchRequestTimeoutMs must exceed watchTimeoutSeconds * 1000');
        }
        this.retryInitialDelayMs = milliseconds(options.retryInitialDelayMs ?? 1_000, 'retryInitialDelayMs');
        this.retryMaxDelayMs = milliseconds(options.retryMaxDelayMs ?? 30_000, 'retryMaxDelayMs');
        if (this.retryMaxDelayMs < this.retryInitialDelayMs) {
            throw new TypeError('retryMaxDelayMs must be at least retryInitialDelayMs');
        }
        this.api = new LessConfigApi(endpoint, options.token, this.requestTimeoutMs);
        this.watchApi = new LessConfigApi(endpoint, options.token, this.requestTimeoutMs);
    }

    /**
     * Starts watching if scopes exist; repeated calls are harmless.
     * Configuration reads start watching automatically, so calling this method is optional.
     * @throws Error - If the client is closed or watching stopped after a permanent failure.
     */
    start(): void {
        this.ensureOpen();
        this.ensureWatchingAllowed();
        this.runIfNeeded();
    }

    /**
     * Loads and subscribes on first use; subsequent reads return detached cache snapshots.
     * Missing keys remain subscribed. Cached values remain readable during background failures.
     * @param project - Case-sensitive project slug.
     * @param environment - Case-sensitive environment slug.
     * @param key - Case-sensitive configuration key.
     * @returns A detached configuration, or null if the key or its ancestor does not exist.
     * @throws LessConfigError - If initial loading fails for a reason other than a recognized missing resource.
     * @throws TypeError - If an identifier is invalid.
     */
    async getConfig(project: string, environment: string, key: string): Promise<Config | null> {
        this.ensureOpen();
        identifier(key, 'key');
        const id = scope(project, environment, key);
        try {
            const config = (await this.subscribe(id)).find((entry) => entry.key === key);
            return config ? { ...config } : null;
        } catch (error) {
            if (missingAncestor(error)) {
                return null;
            }
            throw error;
        }
    }

    /**
     * Loads and subscribes to every current and future key in an environment.
     * @param project - Case-sensitive project slug.
     * @param environment - Case-sensitive environment slug.
     * @returns A frozen list of detached configurations in server order.
     * @throws LessConfigError - If initialization fails, including an absent project or environment.
     */
    async getConfigs(project: string, environment: string): Promise<readonly Config[]> {
        this.ensureOpen();
        return Object.freeze((await this.subscribe(scope(project, environment, null))).map((entry) => ({ ...entry })));
    }

    /**
     * Reads fresh environment metadata without caching or subscribing.
     * @param project - Case-sensitive project slug.
     * @param environment - Case-sensitive environment slug.
     * @returns The environment, or null if it or its project is absent.
     */
    async getEnvironment(project: string, environment: string): Promise<Environment | null> {
        this.ensureOpen();
        return this.api.getEnvironment(project, environment);
    }

    /**
     * Lists fresh environment metadata without creating subscriptions.
     * @param project - Case-sensitive project slug.
     * @returns A frozen list in server order; a missing project rejects the promise.
     */
    async getEnvironments(project: string): Promise<readonly Environment[]> {
        this.ensureOpen();
        return this.api.getEnvironments(project);
    }

    /**
     * Reads fresh project metadata without caching or subscribing.
     * @param project - Case-sensitive project slug.
     * @returns The project, or null if it is absent.
     */
    async getProject(project: string): Promise<Project | null> {
        this.ensureOpen();
        return this.api.getProject(project);
    }

    /**
     * Lists fresh project metadata visible to the credential.
     * @returns A frozen list in server order, possibly empty.
     */
    async getProjects(): Promise<readonly Project[]> {
        this.ensureOpen();
        return this.api.getProjects();
    }

    /**
     * Observes current and future subscriptions without opening a watch scope by itself.
     * @param listener - Callback that receives matching server invalidation batches.
     * @returns A promise resolved after registration.
     */
    addConfigListener(listener: ConfigListener): Promise<void>;
    /**
     * Registers a listener and initializes an entire environment without emitting an initial event.
     * @param project - Case-sensitive project slug.
     * @param environment - Case-sensitive environment slug.
     * @param listener - Callback invoked after matching cache refreshes.
     * @returns A promise resolved after initialization; failure rolls back this registration.
     */
    addConfigListener(project: string, environment: string, listener: ConfigListener): Promise<void>;
    /**
     * Registers a listener and initializes one key without emitting an initial event.
     * @param project - Case-sensitive project slug.
     * @param environment - Case-sensitive environment slug.
     * @param key - Case-sensitive configuration key.
     * @param listener - Callback invoked after matching cache refreshes.
     * @returns A promise resolved after initialization; failure rolls back this registration.
     */
    addConfigListener(project: string, environment: string, key: string, listener: ConfigListener): Promise<void>;
    /**
     * Normalizes the listener overloads and shares duplicate registration initialization.
     * @param first - Global listener or project slug for a scoped listener.
     * @param environment - Environment slug when registering a scoped listener.
     * @param keyOrListener - Key for a key listener, or the callback for an environment listener.
     * @param keyListener - Callback when a configuration key is supplied.
     * @returns A promise resolved once registration and any required initialization complete.
     */
    async addConfigListener(
        first: string | ConfigListener,
        environment?: string,
        keyOrListener?: string | ConfigListener,
        keyListener?: ConfigListener,
    ): Promise<void> {
        this.ensureOpen();
        const listener = typeof first === 'function' ? first : typeof keyOrListener === 'function' ? keyOrListener : keyListener;
        checkListener(listener);
        const id =
            typeof first === 'function' ? null : scope(first, environment!, typeof keyOrListener === 'string' ? keyOrListener : null);
        for (const existing of this.listeners) {
            if (
                existing.listener === listener &&
                (existing.id === null ? id === null : id !== null && scopePath(existing.id) === scopePath(id))
            ) {
                return existing.ready;
            }
        }
        const registration: Registration = { id, listener: listener! };
        this.listeners.add(registration);
        if (id !== null) {
            registration.ready = this.subscribe(id).then(
                () => {},
                (error: unknown) => {
                    this.listeners.delete(registration);
                    throw error;
                },
            );
            await registration.ready;
        }
    }

    /**
     * Removes every registration of a callback while retaining caches and subscriptions.
     * @param listener - Previously registered function; an already-running callback may finish.
     */
    removeListener(listener: ConfigListener): void {
        this.ensureOpen();
        checkListener(listener);
        for (const registration of this.listeners) {
            if (registration.listener === listener) {
                this.listeners.delete(registration);
            }
        }
    }

    /**
     * Registers an observer without replaying the current status.
     * Use getStatus() to inspect the state immediately.
     * @param listener - Callback receiving future status transitions and background failures.
     */
    addStatusListener(listener: StatusListener): void {
        this.ensureOpen();
        checkListener(listener);
        this.statusListeners.add(listener);
    }

    /**
     * Removes a status observer; an already-running callback may finish.
     * @param listener - Previously registered observer function.
     */
    removeStatusListener(listener: StatusListener): void {
        this.ensureOpen();
        checkListener(listener);
        this.statusListeners.delete(listener);
    }

    /**
     * Reads the current lifecycle state, including after closure.
     * @returns The current watcher status.
     */
    getStatus(): WatchStatus {
        return this.status;
    }

    /**
     * Reads the latest outstanding background failure.
     * @returns The last failure, or null when no background error is outstanding.
     * @throws Error - If the client is closed.
     */
    getWatchError(): LessConfigError | null {
        this.ensureOpen();
        return this.watchError;
    }

    /**
     * Cancels requests and retry timers, clears cached state, and permanently closes the client.
     * Repeated calls are harmless. Already-running user callbacks are not awaited.
     */
    close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.api.close();
        this.watchApi.close();
        this.wake?.();
        this.listeners.clear();
        this.state = { scopes: new Map(), revision: null };
        this.pending = null;
        this.notifications.length = 0;
        this.transition(WatchStatus.CLOSED, null);
    }

    /**
     * Rejects operational use after the client has been disposed.
     * @throws Error - If the client is closed.
     */
    private ensureOpen(): void {
        if (this.closed) {
            throw new Error('Client is closed');
        }
    }

    /**
     * Rejects new subscriptions after a permanent background failure.
     * @throws Error - If watching has stopped permanently.
     */
    private ensureWatchingAllowed(): void {
        if (this.stopped) {
            throw new Error('Watching stopped after a permanent error; create a new client', { cause: this.watchError });
        }
    }

    /**
     * Serializes snapshot mutations without holding the queue during long polls or user callbacks.
     * @typeParam T - Value produced by the queued operation.
     * @param work - Operation that reads and updates the current internal snapshot.
     * @returns The result of the queued operation; its failure does not block later operations.
     */
    private update<T>(work: () => Promise<T>): Promise<T> {
        const next = this.updateTail.then(work);
        this.updateTail = next.then(
            () => {},
            () => {},
        );
        return next;
    }

    /**
     * Returns a covering cache snapshot or atomically initializes the expanded selection.
     * @param requested - Validated key or environment identity.
     * @returns The internal cached list; callers must detach objects before returning them publicly.
     */
    private async subscribe(requested: ConfigId): Promise<readonly Config[]> {
        this.ensureOpen();
        const cached = find(this.state, requested);
        if (cached !== undefined) {
            return cached;
        }
        this.ensureWatchingAllowed();
        const result = await this.update(async () => {
            this.ensureOpen();
            const cached = find(this.state, requested);
            if (cached !== undefined) {
                return cached;
            }
            this.ensureWatchingAllowed();
            const before = this.state;
            try {
                try {
                    await this.initialize(select(this.state.scopes, requested), true);
                } catch (error) {
                    if (!missingAncestor(error) || this.state.scopes.size === 0) {
                        throw error;
                    }
                    const live = await this.survivingScopes(this.state);
                    if (live.size === this.state.scopes.size) {
                        throw error;
                    }
                    this.state = { scopes: live, revision: null };
                    this.pending = null;
                    await this.initialize(select(live, requested), false);
                }
                return find(this.state, requested) ?? [];
            } finally {
                if (this.state !== before && !this.closed) {
                    this.watchApi.cancel();
                    this.wake?.();
                    this.runIfNeeded();
                }
            }
        });
        this.transition(WatchStatus.WATCHING, null);
        this.runIfNeeded();
        return result;
    }

    /**
     * Loads a complete scope selection before publishing its cache and watch watermark together.
     * @param selected - Complete selection to initialize or recover.
     * @param catchUp - Whether to preserve outstanding events for the previous selection.
     * @returns A promise resolved after the new snapshot is committed.
     */
    private async initialize(selected: ReadonlyMap<string, CachedScope>, catchUp: boolean): Promise<void> {
        const initial = await this.api.watch(ids(selected), null, this.watchTimeoutSeconds, this.requestTimeoutMs);
        let priorChanges: readonly ConfigChange[] = [];
        if (catchUp && this.state.revision !== null && this.state.scopes.size > 0 && initial.revision > this.state.revision) {
            try {
                priorChanges = (
                    await this.api.watch(ids(this.state.scopes), this.state.revision, 1, Math.max(2_000, this.requestTimeoutMs))
                ).changes;
            } catch (error) {
                if (!resetRequired(error) && !missingAncestor(error)) {
                    throw error;
                }
            }
        }
        const loaded = new Map<string, CachedScope>();
        for (const [key, entry] of selected) {
            loaded.set(key, { id: entry.id, configs: await this.load(entry.id) });
        }
        this.ensureOpen();
        this.state = { scopes: loaded, revision: initial.revision };
        this.pending = null;
        if (priorChanges.length > 0) {
            this.notifications.push(priorChanges);
        }
    }

    /**
     * Reads all configuration content for one subscribed identity.
     * @param id - Key or environment scope to load.
     * @returns A list that is empty for a missing key; missing ancestors reject.
     */
    private async load(id: ConfigId): Promise<readonly Config[]> {
        if (id.key === null) {
            return this.api.getConfigs(id.project, id.environment);
        }
        const config = await this.api.getConfig(id);
        return config === null ? [] : [config];
    }

    /**
     * Reloads live scopes and excludes missing ancestors without publishing partial state.
     * @param current - Snapshot whose subscriptions should be reconciled.
     * @returns Reloaded scope records whose projects and environments still exist.
     */
    private async survivingScopes(current: State): Promise<ReadonlyMap<string, CachedScope>> {
        const live = new Map<string, CachedScope>();
        for (const [key, entry] of current.scopes) {
            try {
                live.set(key, { id: entry.id, configs: await this.load(entry.id) });
            } catch (error) {
                if (!missingAncestor(error)) {
                    throw error;
                }
            }
        }
        this.ensureOpen();
        return live;
    }

    /**
     * Starts the single background loop when subscribed work exists and watching is allowed.
     */
    private runIfNeeded(): void {
        if (this.running || this.closed || this.stopped || this.state.scopes.size === 0) {
            return;
        }
        this.running = true;
        // loop handles network and callback failures. Finally releases ownership before any restart.
        void this.loop().finally(() => {
            this.running = false;
            this.runIfNeeded();
        });
    }

    /**
     * Runs watch cycles with bounded exponential backoff until idle, closed, or permanently stopped.
     * @returns A promise resolved when the loop relinquishes ownership.
     */
    private async loop(): Promise<void> {
        let delay = this.retryInitialDelayMs;
        while (!this.closed && !this.stopped) {
            try {
                await this.deliverNotifications();
                if (this.closed || this.stopped) {
                    return;
                }
                if (this.state.scopes.size === 0) {
                    this.transition(WatchStatus.IDLE, null);
                    return;
                }
                await this.watchOnce();
                delay = this.retryInitialDelayMs;
            } catch (cause) {
                if (this.closed) {
                    return;
                }
                if (cause instanceof CancelledError) {
                    continue;
                }
                const error = cause instanceof LessConfigError ? cause : new LessConfigError('Watcher failed', 0, null, { cause });
                if (!this.reportError(error)) {
                    return;
                }
                await this.pause(delay);
                delay = Math.min(delay * 2, this.retryMaxDelayMs);
            }
        }
    }

    /**
     * Applies one watch or recovery cycle and acknowledges only a fully refreshed batch.
     * @returns A promise resolved after the cycle completes or its stale response is discarded.
     */
    private async watchOnce(): Promise<void> {
        const current = this.state;
        if (current.revision === null) {
            await this.update(async () => {
                if (this.closed || this.state !== current) {
                    return;
                }
                try {
                    await this.initialize(current.scopes, false);
                } catch (error) {
                    if (missingAncestor(error)) {
                        this.state = { scopes: await this.survivingScopes(current), revision: null };
                        this.pending = null;
                    }
                    throw error;
                }
            });
            this.transition(WatchStatus.WATCHING, null);
            return;
        }
        let result: WatchResult;
        try {
            result =
                this.pending?.base === current
                    ? this.pending.result
                    : await this.watchApi.watch(
                          ids(current.scopes),
                          current.revision,
                          this.watchTimeoutSeconds,
                          this.watchRequestTimeoutMs,
                      );
        } catch (error) {
            await this.update(async () => {
                if (this.closed || this.state !== current || error instanceof CancelledError) {
                    return;
                }
                if (resetRequired(error)) {
                    this.state = { scopes: current.scopes, revision: null };
                    this.pending = null;
                } else if (missingAncestor(error)) {
                    this.state = { scopes: await this.survivingScopes(current), revision: null };
                    this.pending = null;
                }
                throw error;
            });
            return;
        }
        const applied = await this.update(async () => {
            if (this.closed || this.state !== current) {
                return false;
            }
            this.pending = { base: current, result };
            const refreshed = new Map(current.scopes);
            for (const [key, entry] of current.scopes) {
                if (!result.changes.some((change) => affects(change, entry.id))) {
                    continue;
                }
                try {
                    refreshed.set(key, { id: entry.id, configs: await this.load(entry.id) });
                } catch (error) {
                    if (!missingAncestor(error)) {
                        throw error;
                    }
                    refreshed.delete(key);
                }
            }
            this.ensureOpen();
            this.state = { scopes: refreshed, revision: refreshed.size === current.scopes.size ? result.revision : null };
            this.pending = null;
            if (result.changes.length > 0) {
                this.notifications.push(result.changes);
            }
            return true;
        });
        if (applied) {
            this.transition(this.state.scopes.size === 0 ? WatchStatus.IDLE : WatchStatus.WATCHING, null);
        }
    }

    /**
     * Classifies a background failure and reports whether recovery should continue.
     * @param error - Failure from a watch, initialization, or refresh request.
     * @returns Whether the watcher should retry and the client remains open.
     */
    private reportError(error: LessConfigError): boolean {
        if (this.closed) {
            return false;
        }
        const status = error.statusCode;
        const retry = status === 0 || status >= 500 || status === 408 || status === 429 || missingAncestor(error) || resetRequired(error);
        if (!retry) {
            this.stopped = true;
        }
        this.transition(retry ? WatchStatus.RETRYING : WatchStatus.STOPPED, error);
        return retry && !this.closed;
    }

    /**
     * Waits for a retry delay that can be interrupted by closure or a subscription change.
     * @param delay - Retry interval in milliseconds.
     * @returns A promise resolved when the timer expires or a wakeup interrupts it.
     */
    private pause(delay: number): Promise<void> {
        if (this.closed) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            /** Ends the retry wait and releases the current wakeup callback. */
            const finish = () => {
                clearTimeout(timer);
                if (this.wake === finish) {
                    this.wake = null;
                }
                resolve();
            };
            const timer = setTimeout(finish, delay);
            this.wake = finish;
        });
    }

    /**
     * Publishes lifecycle state and serializes reentrant observer notifications.
     * @param status - New lifecycle or watcher-health state.
     * @param error - Associated failure, or null for a healthy transition.
     */
    private transition(status: WatchStatus, error: LessConfigError | null): void {
        if (
            this.status === WatchStatus.CLOSED ||
            (this.status === status && error === null) ||
            (this.stopped && status !== WatchStatus.STOPPED && status !== WatchStatus.CLOSED)
        ) {
            return;
        }
        this.status = status;
        this.watchError = error;
        this.statusEvents.push({ status, error });
        if (this.dispatchingStatus) {
            return;
        }
        this.dispatchingStatus = true;
        try {
            let event: StatusEvent | undefined;
            while ((event = this.statusEvents.shift())) {
                for (const listener of [...this.statusListeners]) {
                    try {
                        const result = listener(event.status, event.error);
                        if (result) {
                            void Promise.resolve(result).catch((cause: unknown) => this.listenerFailed(cause));
                        }
                    } catch (cause) {
                        this.listenerFailed(cause);
                    }
                }
                if (event.status === WatchStatus.CLOSED) {
                    this.statusListeners.clear();
                }
            }
        } finally {
            this.dispatchingStatus = false;
        }
    }

    /**
     * Delivers committed change batches serially outside the snapshot mutation queue.
     * @returns A promise resolved after queued notifications are drained or the client closes.
     */
    private async deliverNotifications(): Promise<void> {
        while (!this.closed) {
            const batch = this.notifications.shift();
            if (!batch) {
                return;
            }
            for (const registration of [...this.listeners]) {
                if (this.closed) {
                    return;
                }
                if (!this.listeners.has(registration)) {
                    continue;
                }
                const matching = batch.filter((change) => registration.id === null || affects(change, registration.id));
                if (matching.length === 0) {
                    continue;
                }
                try {
                    await registration.listener(Object.freeze(matching));
                } catch (cause) {
                    this.listenerFailed(cause);
                }
            }
        }
    }

    /**
     * Reports a callback failure without failing other listeners or the watch loop.
     * @param cause - Exception or rejected promise reason from user callback code.
     */
    private listenerFailed(cause: unknown): void {
        console.warn('LessConfig listener failed', cause);
    }
}
