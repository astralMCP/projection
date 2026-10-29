/**
 * Offline fakes for upstream sign-in tests (PRD §13): an in-process
 * authorization server and an OAuth-protected MCP server on 127.0.0.1,
 * plus a fake `@napi-rs/keyring` module. Phase 1B extends these.
 */

export * from './authorization-server.js';
export * from './http.js';
export * from './keyring.js';
export * from './protected-resource.js';
