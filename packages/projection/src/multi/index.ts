/**
 * Multi-server facades (PRD §6.9, R39–R49): `wrapMcpServers` and its
 * configuration. The qualified-name view they serve lives in
 * `catalog/boxes.ts`. Only what the package root re-exports is exported
 * here; tests import internals from their module paths.
 */

export { wrapMcpServers, type MultiProjectionFacade } from './facade.js';
export { type ServerSourceConfig, type WrapServersOptions } from './config.js';
