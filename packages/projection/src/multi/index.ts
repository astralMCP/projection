/**
 * Multi-server facades (PRD §6.9, R39–R49): `wrapMcpServers` and its
 * configuration. The qualified-name view they serve lives in
 * `catalog/boxes.ts`.
 */

export {
  wrapMcpServers,
  buildMultiInstructions,
  DEFAULT_MULTI_CATALOG_PREAMBLE,
  MAX_FACADE_TOOLS,
  type MultiProjectionFacade,
} from './facade.js';
export {
  ALIAS_PATTERN,
  MAX_BOX_DESCRIPTION_CHARS,
  MAX_SOURCES,
  RESERVED_ALIASES,
  type ServerSourceConfig,
  type WrapServersOptions,
} from './config.js';
