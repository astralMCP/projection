/** Constants shared by the introspector and the connections it opens. */

/** The client identity Projection's own connections to wrapped servers announce. */
export const INTROSPECTOR_CLIENT_INFO = { name: 'projection-introspector', version: '0.1.0' };

/** `WrapOptions.introspectTimeoutMs`'s default (R47). */
export const DEFAULT_INTROSPECT_TIMEOUT_MS = 30_000;
