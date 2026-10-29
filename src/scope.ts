import type { ConfigChange, ConfigId } from './types.js';

/**
 * Validates a case-sensitive LessConfig path identifier.
 * @param value - Identifier to validate.
 * @param name - Field name used in validation errors.
 * @returns The original validated identifier.
 * @throws TypeError - If the value contains unsupported characters or is a reserved path segment.
 */
export function identifier(value: string, name: string): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9._-]+$/.test(value) || value === '.' || value === '..') {
        throw new TypeError(`${name} must be a valid LessConfig identifier`);
    }
    return value;
}

/**
 * Creates a validated, immutable key or environment selection.
 * @param project - Case-sensitive project slug.
 * @param environment - Case-sensitive environment slug.
 * @param key - Configuration key, or null to select the entire environment.
 * @returns The validated subscription identity.
 */
export function scope(project: string, environment: string, key: string | null): ConfigId {
    return Object.freeze({
        project: identifier(project, 'project'),
        environment: identifier(environment, 'environment'),
        key: key === null ? null : identifier(key, 'key'),
    });
}

/**
 * Formats an identity for the public watch scopes parameter.
 * @param id - Validated subscription identity.
 * @returns A project/environment path, optionally followed by its key.
 */
export function scopePath(id: ConfigId): string {
    return `${id.project}/${id.environment}${id.key === null ? '' : `/${id.key}`}`;
}

/**
 * Checks whether one subscription includes another selection.
 * @param id - Existing or proposed covering subscription.
 * @param other - Selection to test for inclusion.
 * @returns Whether both identities match or the first selects the containing environment.
 */
export function covers(id: ConfigId, other: ConfigId): boolean {
    return id.project === other.project && id.environment === other.environment && (id.key === null || id.key === other.key);
}

/**
 * Checks whether a server invalidation intersects a subscribed scope.
 * @param change - Validated configuration or ancestor change.
 * @param id - Subscription to test.
 * @returns Whether the scope needs refreshing for this change.
 */
export function affects(change: ConfigChange, id: ConfigId): boolean {
    return (
        change.project === id.project &&
        (change.environment === null || change.environment === id.environment) &&
        (change.key === null || id.key === null || change.key === id.key)
    );
}
