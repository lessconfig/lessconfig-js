import { isPlainObject } from 'lodash-es';
import { CancelledError, LessConfigError } from './error.js';

/**
 * Validates an API root and removes trailing slashes.
 * @param endpoint - Absolute HTTP(S) URL without credentials, a query, or a fragment.
 * @returns The normalized API root URL.
 * @throws TypeError - If the endpoint is malformed or contains unsupported URL components.
 */
export function normalizeEndpoint(endpoint: string): string {
    let url: URL;
    try {
        url = new URL(endpoint);
    } catch {
        throw new TypeError('endpoint must be an absolute HTTP(S) API root URL');
    }
    if (
        typeof endpoint !== 'string' ||
        endpoint.trim() !== endpoint ||
        /[\s\\]/.test(endpoint) ||
        !/^https?:\/\//i.test(endpoint) ||
        !['http:', 'https:'].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password ||
        endpoint.includes('?') ||
        endpoint.includes('#')
    ) {
        throw new TypeError('endpoint must be an HTTP(S) API root without credentials, query, or fragment');
    }
    return url.href.replace(/\/+$/, '');
}

/** Cancellable native-fetch transport. The timeout includes reading the response body. */
export class HttpTransport {
    /**
     * Normalized API root to which versioned request paths are appended.
     */
    private readonly endpoint: string;
    /**
     * Bearer credential sent in the Authorization header.
     */
    private readonly token: string;
    /**
     * Controllers for requests whose headers or response bodies are still being read.
     */
    private readonly active = new Set<AbortController>();
    /**
     * Whether further requests are permanently disallowed.
     */
    private closed = false;

    /**
     * Creates an independent transport without network activity.
     * @param endpoint - Validated, normalized API root URL.
     * @param token - Validated Bearer credential.
     */
    constructor(endpoint: string, token: string) {
        this.endpoint = endpoint;
        this.token = token;
    }

    /**
     * Performs an authenticated GET with a timeout covering headers and body consumption.
     * @param path - Validated path and optional encoded query relative to the API root.
     * @param timeoutMs - Positive whole-request timeout in milliseconds.
     * @returns The parsed JSON value, still requiring endpoint-specific validation.
     * @throws LessConfigError - If HTTP, JSON decoding, networking, or timeout handling fails.
     * @throws CancelledError - If the request is intentionally cancelled.
     */
    async get(path: string, timeoutMs: number): Promise<unknown> {
        if (this.closed) {
            throw new CancelledError();
        }
        const controller = new AbortController();
        this.active.add(controller);
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, timeoutMs);
        try {
            const response = await fetch(this.endpoint + path, {
                method: 'GET',
                headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
                signal: controller.signal,
                cache: 'no-store',
                credentials: 'omit',
                redirect: 'manual',
            });
            const body = await response.text();
            if (controller.signal.aborted) {
                throw new CancelledError();
            }
            if (response.type === 'opaqueredirect') {
                throw new LessConfigError('HTTP redirects are not supported', 302);
            }
            let json: unknown;
            try {
                json = JSON.parse(body);
            } catch (cause) {
                if (response.status === 200) {
                    throw new LessConfigError('Invalid JSON response', 0, null, { cause });
                }
            }
            if (response.status !== 200) {
                const error = isPlainObject(json) ? (json as Record<string, unknown>) : {};
                throw new LessConfigError(
                    typeof error.message === 'string' ? error.message : `HTTP request failed: ${response.status}`,
                    response.status,
                    typeof error.code === 'string' ? error.code : null,
                );
            }
            return json;
        } catch (cause) {
            if (timedOut) {
                throw new LessConfigError('HTTP request timed out', 0, null, { cause });
            }
            if (controller.signal.aborted) {
                throw new CancelledError();
            }
            if (cause instanceof LessConfigError) {
                throw cause;
            }
            throw new LessConfigError('HTTP request failed', 0, null, { cause });
        } finally {
            clearTimeout(timer);
            this.active.delete(controller);
        }
    }

    /**
     * Aborts all active requests while allowing later requests.
     */
    cancel(): void {
        for (const controller of this.active) {
            controller.abort();
        }
    }

    /**
     * Prevents further requests and aborts outstanding work.
     */
    close(): void {
        this.closed = true;
        this.cancel();
    }
}
