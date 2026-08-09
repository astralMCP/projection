/**
 * Blob sealer — public surface (PRD §7; R19–R23, S2–S4).
 *
 * ## API
 *
 * - `sealBlob(payload: BlobPayload, config: BlobSealerConfig): string`
 *   Seals a payload into an opaque `proj1.` envelope for the MRTR
 *   `requestState` field. Sync. Throws ProjectionError phase `terminal` when
 *   the sealed size exceeds `config.maxBlobBytes` (default 128 KB, R23) or
 *   config keys are not 32 bytes.
 *
 * - `openBlob(blob: string, options: OpenBlobOptions): BlobPayload`
 *   Verifies in the normative R21 order — (1) decrypt/authenticate with the
 *   current key then each `previousKeys` (R22), (2) blob schema version and
 *   exact libv/xstatev match (Q3), (3) expiry, (4) codeHash of the re-sent
 *   code (S4) and serverIdentity — and returns the payload only when every
 *   check passes. Sync. Throws ProjectionError phase `blob_verification`
 *   naming the failed check.
 *
 * - `buildBlobPayload(input: BuildBlobPayloadInput): BlobPayload`
 *   Fills v, libv, xstatev, codeHash, nonce, iat, and exp (ttlMs default 15
 *   minutes) around the caller-supplied snapshot/pending/trip fields.
 *
 * - `hashCode(code: string): string` — SHA-256 hex of a code argument.
 *
 * Envelope format and crypto rationale are documented in `sealer.ts`.
 */

export {
  buildBlobPayload,
  DEFAULT_MAX_BLOB_BYTES,
  DEFAULT_TTL_MS,
  ENVELOPE_PREFIX,
  hashCode,
  openBlob,
  sealBlob,
  type BuildBlobPayloadInput,
  type OpenBlobOptions,
} from './sealer.js';
export { LIB_VERSION, XSTATE_VERSION } from './versions.js';
