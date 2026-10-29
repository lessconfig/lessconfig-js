/** An HTTP, protocol, or network failure returned by LessConfig. */
export class LessConfigError extends Error {
    /** Stable error name for diagnostics. */
    override readonly name = 'LessConfigError';

    /** HTTP error status, or zero for network, cancellation, or decoding failures. */
    readonly statusCode: number;

    /** Server business error code, or null when unavailable. */
    readonly code: string | null;

    /**
     * Creates an SDK error while preserving the underlying failure when available.
     * @param message - Human-readable failure explanation.
     * @param statusCode - HTTP error status, or zero when unavailable.
     * @param code - Stable server business code, or null when unavailable.
     * @param options - Standard Error options, including an optional cause.
     */
    constructor(message: string, statusCode = 0, code: string | null = null, options?: ErrorOptions) {
        super(message, options);
        this.statusCode = statusCode;
        this.code = code;
    }
}

/** Internal cancellation is separate from a request timeout or background failure. */
export class CancelledError extends LessConfigError {
    /** Creates the internal signal used when a request is intentionally aborted. */
    constructor() {
        super('HTTP request cancelled');
    }
}

/**
 * Recognizes missing projects or environments without confusing a missing key or route.
 * @param error - Failure to classify.
 * @returns Whether the error is a recognized ancestor HTTP 404.
 */
export function missingAncestor(error: unknown): error is LessConfigError {
    return (
        error instanceof LessConfigError &&
        error.statusCode === 404 &&
        (error.code === 'project_not_found' || error.code === 'environment_not_found')
    );
}

/**
 * Recognizes watch positions that require a fresh initialization.
 * @param error - Failure to classify.
 * @returns Whether the server reports an expired or future revision.
 */
export function resetRequired(error: unknown): error is LessConfigError {
    return (
        error instanceof LessConfigError &&
        ((error.statusCode === 410 && error.code === 'revision_expired') || (error.statusCode === 409 && error.code === 'revision_ahead'))
    );
}
