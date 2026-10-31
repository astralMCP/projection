/** Constants shared by the introspector and the connections it opens. */

import type { ClientOptions, VersionNegotiationMode } from '@modelcontextprotocol/client';

/** The client identity Projection's own connections to wrapped servers announce. */
export const INTROSPECTOR_CLIENT_INFO = { name: 'projection-introspector', version: '0.1.0' };

/** `WrapOptions.introspectTimeoutMs`'s default (R47). */
export const DEFAULT_INTROSPECT_TIMEOUT_MS = 30_000;

/**
 * The options of every client Projection opens to a wrapped server (G2,
 * DECISIONS D24): `mode` selects the protocol era (`{ pin }` for an
 * in-process server, which speaks 2026-07-28 for certain; `'auto'` for one
 * given by URL, falling back to the 2025 handshake; `'legacy'` to skip the
 * probe), and the elicitation capability is declared only for a box that
 * forwards its server's questions. Auto-fulfilment is always off: an
 * `input_required` from the server comes back to Projection as data, never
 * as a prompt the SDK answers on its own.
 */
export function upstreamClientOptions(
  forwardElicitation: boolean,
  mode: VersionNegotiationMode,
): ClientOptions {
  return {
    capabilities: forwardElicitation ? { elicitation: { form: {}, url: {} } } : {},
    versionNegotiation: { mode },
    inputRequired: { autoFulfill: false },
  };
}
