/**
 * Suspension blob sealer (PRD §7 "Blob sealer"; R19–R23, S2–S4).
 *
 * Packages a {@link BlobPayload} into an opaque, authenticated, encrypted,
 * compressed envelope string that rides in the MRTR `requestState` field,
 * and verifies/opens it on resume. Clients are honest-but-curious couriers
 * (S3): they must neither read machine context (encryption) nor modify
 * anything (authentication). Every failure mode fails closed with a
 * ProjectionError; a payload is never returned partially verified.
 *
 * ## Envelope format (version `proj1`)
 *
 * ```
 * proj1.<salt>.<iv>.<ciphertext>.<tag>
 * ```
 *
 * Five dot-separated fields; all but the literal `proj1` prefix are
 * unpadded base64url:
 *
 * - `salt` — 16 random bytes, HKDF salt for per-blob key derivation
 * - `iv` — 12 random bytes, AES-GCM nonce
 * - `ciphertext` — AES-256-GCM over deflateRaw(JSON(payload))
 * - `tag` — 16-byte GCM authentication tag
 *
 * AAD is the UTF-8 bytes of the envelope header `proj1.<salt>.<iv>` (the
 * exact base64url text as transmitted), so the version prefix and header
 * fields are covered by the authentication tag. Tampering with any field
 * fails closed: the prefix and header break AAD verification, the salt
 * additionally derives a different key, and the iv/ciphertext/tag break GCM
 * authentication directly.
 *
 * ## Crypto choices
 *
 * - **AES-256-GCM** (R19): AEAD, native in node:crypto.
 * - **HKDF-SHA256** per-blob key derivation: the developer-supplied 32-byte
 *   key is treated as input keying material, never used directly as a
 *   cipher key. A fresh random 16-byte salt per blob means every blob is
 *   encrypted under a distinct derived key, so the 96-bit random GCM nonce
 *   can never repeat *under the same key* even across horizontally scaled
 *   instances sealing concurrently (nonce-reuse would be catastrophic for
 *   GCM). Fixed info string `@astral-mcp/projection/blob/v1` domain-separates the
 *   derivation.
 * - **deflateRaw** compression (R23), not brotli: brotli's default quality
 *   is far too slow for the seal+verify+rehydrate p95 < 100 ms budget
 *   (PRD §10), and at speed-comparable quality settings its ratio edge on
 *   small (< 32 KB typical) JSON payloads is marginal. Raw deflate also
 *   omits the zlib header/adler32 checksum — GCM already guarantees
 *   integrity — saving a few bytes.
 * - **Sync APIs throughout**: payloads are small (128 KB ceiling), so the
 *   sync node:crypto/node:zlib forms are faster than promise overhead and
 *   keep the API non-async.
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { ProjectionError } from '../errors.js';
import {
  BLOB_SCHEMA_VERSION,
  isRecord,
  type BlobPayload,
  type AuditEntry,
  type BlobSealerConfig,
  type PendingToolCall,
  type BlobKind,
} from '../types.js';
import { LIB_VERSION, XSTATE_VERSION } from './versions.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Envelope format version prefix. Bump (proj2, …) on any wire-format change. */
export const ENVELOPE_PREFIX = 'proj1';

/** Default blob TTL for `machine` blobs: 15 minutes (R20). */
export const DEFAULT_TTL_MS = 15 * 60 * 1000;

/**
 * Default TTL for `call` blobs: 5 minutes (R38). An approved `call` blob has
 * no forward step, so it is a standing capability until it expires (D4, D9).
 */
export const DEFAULT_CALL_TTL_MS = 5 * 60 * 1000;

/** Default sealed-blob size ceiling: 128 KB (R23). */
export const DEFAULT_MAX_BLOB_BYTES = 128 * 1024;

const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HKDF_INFO = '@astral-mcp/projection/blob/v1';
const BASE64URL = /^[A-Za-z0-9_-]+$/;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function verificationError(message: string, hint: string): ProjectionError {
  return new ProjectionError('blob_verification', message, { hint });
}

const HINT_CORRUPT =
  'The requestState blob is corrupt; retry with the exact requestState echoed from the input_required result, or re-run execute_machine to start a new workflow.';
const HINT_AUTH =
  'The blob failed authentication — it was modified in transit or sealed under a key this deployment does not accept. Re-run execute_machine to start a new workflow.';
const HINT_VERSION =
  'The server was upgraded since this workflow suspended; suspended workflows do not survive version changes. Re-run execute_machine to start a new workflow.';
const HINT_EXPIRED =
  'The approval window elapsed before the retry arrived. Re-run execute_machine and respond to approval prompts within the TTL.';
const HINT_CODE =
  'Retry the call with the byte-exact original code argument; a blob only resumes the code that produced it.';
const HINT_SERVER =
  'This blob was minted against a different wrapped server and cannot be resumed here. Re-run execute_machine against this server.';
const HINT_KIND =
  'Echo the requestState back to the same tool that returned it: execute_machine blobs resume execute_machine, call_tool blobs resume call_tool.';
const HINT_REQUEST =
  'Retry call_tool with exactly the name and args that produced this requestState; to run a different call, start a new call_tool request.';

// ---------------------------------------------------------------------------
// Key handling
// ---------------------------------------------------------------------------

function assertKey(key: Uint8Array, label: string): void {
  if (!(key instanceof Uint8Array) || key.length !== KEY_BYTES) {
    // Developer misconfiguration, not client tampering — terminal.
    throw new ProjectionError(
      'terminal',
      `blob sealer ${label} must be exactly ${KEY_BYTES} bytes`,
      {
        hint: 'Provide a 32-byte key (e.g. crypto.randomBytes(32)) shared across all instances.',
      },
    );
  }
}

function assertConfigKeys(config: BlobSealerConfig): void {
  assertKey(config.key, 'key');
  for (const prev of config.previousKeys ?? []) {
    assertKey(prev, 'previousKeys entry');
  }
}

/** Derive the actual AES key from developer IKM via HKDF-SHA256 (R19). */
function deriveKey(ikm: Uint8Array, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, HKDF_INFO, KEY_BYTES));
}

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

interface ParsedEnvelope {
  salt: Buffer;
  iv: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
  /** Header bytes exactly as transmitted; must match the AAD used at seal. */
  aad: Buffer;
}

function buildAad(saltPart: string, ivPart: string): Buffer {
  return Buffer.from(`${ENVELOPE_PREFIX}.${saltPart}.${ivPart}`, 'utf8');
}

function decodePart(part: string, field: string, expectedBytes?: number): Buffer {
  if (part.length === 0 || !BASE64URL.test(part)) {
    throw verificationError(`envelope parse failed: ${field} is not valid base64url`, HINT_CORRUPT);
  }
  const bytes = Buffer.from(part, 'base64url');
  if (expectedBytes !== undefined && bytes.length !== expectedBytes) {
    throw verificationError(`envelope parse failed: ${field} has unexpected length`, HINT_CORRUPT);
  }
  return bytes;
}

function parseEnvelope(blob: string): ParsedEnvelope {
  const parts = blob.split('.');
  const [prefix, saltPart, ivPart, ciphertextPart, tagPart] = parts;
  if (
    parts.length !== 5 ||
    prefix === undefined ||
    saltPart === undefined ||
    ivPart === undefined ||
    ciphertextPart === undefined ||
    tagPart === undefined
  ) {
    throw verificationError('envelope parse failed: expected 5 dot-separated fields', HINT_CORRUPT);
  }
  if (prefix !== ENVELOPE_PREFIX) {
    // Downgrade/upgrade of the version prefix fails closed here; even a
    // hypothetical alternate prefix with a re-encrypted body could not be
    // forged without the key, since the prefix is also covered by AAD.
    throw verificationError(
      `envelope parse failed: unsupported envelope version (expected "${ENVELOPE_PREFIX}")`,
      HINT_VERSION,
    );
  }
  return {
    salt: decodePart(saltPart, 'salt', SALT_BYTES),
    iv: decodePart(ivPart, 'iv', IV_BYTES),
    ciphertext: decodePart(ciphertextPart, 'ciphertext'),
    tag: decodePart(tagPart, 'tag', TAG_BYTES),
    aad: buildAad(saltPart, ivPart),
  };
}

function decryptWith(envelope: ParsedEnvelope, ikm: Uint8Array): Buffer {
  const key = deriveKey(ikm, envelope.salt);
  const decipher = createDecipheriv('aes-256-gcm', key, envelope.iv);
  decipher.setAAD(envelope.aad);
  decipher.setAuthTag(envelope.tag);
  return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
}

/** Try the current key, then each previous key (R22 rotation grace). */
function decryptWithAnyKey(envelope: ParsedEnvelope, config: BlobSealerConfig): Buffer {
  const candidates = [config.key, ...(config.previousKeys ?? [])];
  for (const ikm of candidates) {
    try {
      return decryptWith(envelope, ikm);
    } catch {
      // Auth failure under this key; try the next. Never leak which key or
      // why — the message below is uniform for all authentication failures.
    }
  }
  throw verificationError(
    'authentication failed: blob could not be decrypted and verified with any configured key',
    HINT_AUTH,
  );
}

// ---------------------------------------------------------------------------
// Payload shape validation
// ---------------------------------------------------------------------------

function malformed(field: string): ProjectionError {
  return verificationError(
    `blob payload malformed: field "${field}" is missing or mistyped`,
    HINT_CORRUPT,
  );
}

/**
 * Structural check of everything except v/libv/xstatev (already exact-matched
 * by the caller before this runs). The payload is authenticated, so failures
 * here indicate a sealer bug or cross-version confusion — still fail closed.
 */
function assertPayloadShape(payload: Record<string, unknown>): void {
  // R36: `kind` is required; a payload without it predates the field and is
  // fenced by the exact `libv` match once the release that introduced `kind`
  // ships, so here it is simply malformed.
  if (payload['kind'] !== 'machine' && payload['kind'] !== 'call') {
    throw malformed('kind');
  }
  if (typeof payload['codeHash'] !== 'string' || payload['codeHash'].length === 0) {
    throw malformed('codeHash');
  }
  if (typeof payload['serverIdentity'] !== 'string' || payload['serverIdentity'].length === 0) {
    throw malformed('serverIdentity');
  }
  if (typeof payload['nonce'] !== 'string' || payload['nonce'].length === 0) {
    throw malformed('nonce');
  }
  if (typeof payload['iat'] !== 'number' || !Number.isFinite(payload['iat'])) {
    throw malformed('iat');
  }
  if (typeof payload['exp'] !== 'number' || !Number.isFinite(payload['exp'])) {
    throw malformed('exp');
  }
  if (typeof payload['trip'] !== 'number' || !Number.isInteger(payload['trip'])) {
    throw malformed('trip');
  }
  if (!('snapshot' in payload)) {
    throw malformed('snapshot');
  }
  const pending = payload['pending'];
  if (!isRecord(pending)) {
    throw malformed('pending');
  }
  for (const [key, call] of Object.entries(pending)) {
    if (
      !isRecord(call) ||
      typeof call['id'] !== 'string' ||
      typeof call['name'] !== 'string' ||
      typeof call['stateName'] !== 'string' ||
      !isRecord(call['args'])
    ) {
      throw malformed(`pending["${key}"]`);
    }
  }
  if (!Array.isArray(payload['audit'])) {
    throw malformed('audit');
  }
  // R36: a `call` blob is the degenerate one-call machine, so its shape is
  // fixed — exactly one pending entry keyed `call` whose id is `call`, no
  // snapshot, no prior audit, and trip 1 (there is no second round trip).
  if (payload['kind'] === 'call') {
    const keys = Object.keys(pending);
    if (keys.length !== 1 || keys[0] !== 'call') {
      throw malformed('pending (call blob)');
    }
    if ((pending['call'] as Record<string, unknown>)['id'] !== 'call') {
      throw malformed('pending["call"].id (call blob)');
    }
    if (payload['snapshot'] !== null) {
      throw malformed('snapshot (call blob)');
    }
    if ((payload['audit'] as unknown[]).length !== 0) {
      throw malformed('audit (call blob)');
    }
    if (payload['trip'] !== 1) {
      throw malformed('trip (call blob)');
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function toolFor(kind: BlobKind): string {
  return kind === 'call' ? 'call_tool' : 'execute_machine';
}

/** SHA-256 hex digest of a code argument (S4 binding — R20 `codeHash`). */
export function hashCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

export interface BuildBlobPayloadInput {
  /** Minting tool (R36). Default `machine`. */
  kind?: BlobKind | undefined;
  /**
   * The text the blob is bound to (S4): the original `code` argument for a
   * `machine` blob, the canonical request for a `call` blob (R36).
   */
  code: string;
  /** Identity of the wrapped server this blob is minted against (R30). */
  serverIdentity: string;
  /** `getPersistedSnapshot()` output of the machine actor. */
  snapshot: unknown;
  /** inputRequest key -> gated tool call awaiting a verdict (S2). */
  pending: Record<string, PendingToolCall>;
  /** Approval audit accumulated so far in this workflow (PRD §8). */
  audit?: AuditEntry[] | undefined;
  /** Round-trip counter (R18). */
  trip: number;
  /** Blob TTL in ms. Default {@link DEFAULT_TTL_MS} (15 minutes). */
  ttlMs?: number | undefined;
  /** Clock override for testability, Unix ms. Default `Date.now()`. */
  now?: number | undefined;
}

/**
 * Construct a fully populated {@link BlobPayload}: stamps the schema and
 * library/XState versions, hashes the code, and fills nonce/iat/exp.
 */
export function buildBlobPayload(input: BuildBlobPayloadInput): BlobPayload {
  const iat = input.now ?? Date.now();
  const ttlMs = input.ttlMs ?? DEFAULT_TTL_MS;
  return {
    v: BLOB_SCHEMA_VERSION,
    kind: input.kind ?? 'machine',
    libv: LIB_VERSION,
    xstatev: XSTATE_VERSION,
    codeHash: hashCode(input.code),
    serverIdentity: input.serverIdentity,
    snapshot: input.snapshot,
    pending: input.pending,
    audit: input.audit ?? [],
    trip: input.trip,
    nonce: randomBytes(16).toString('base64url'),
    iat,
    exp: iat + ttlMs,
  };
}

/**
 * Seal a payload into an opaque `proj1.` envelope string (R19, R23).
 *
 * JSON → deflateRaw → AES-256-GCM under an HKDF-SHA256 per-blob derived key,
 * with the envelope header as AAD. Throws ProjectionError phase `terminal` if
 * the sealed envelope exceeds `maxBlobBytes` (default 128 KB) or the config
 * keys are malformed.
 */
export function sealBlob(payload: BlobPayload, config: BlobSealerConfig): string {
  assertKey(config.key, 'key');
  const compressed = deflateRawSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 });
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const saltPart = salt.toString('base64url');
  const ivPart = iv.toString('base64url');
  const cipher = createCipheriv('aes-256-gcm', deriveKey(config.key, salt), iv);
  cipher.setAAD(buildAad(saltPart, ivPart));
  const ciphertext = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = `${ENVELOPE_PREFIX}.${saltPart}.${ivPart}.${ciphertext.toString('base64url')}.${tag.toString('base64url')}`;

  const maxBlobBytes = config.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
  const size = Buffer.byteLength(blob, 'utf8');
  if (size > maxBlobBytes) {
    throw new ProjectionError(
      'terminal',
      `sealed suspension blob is ${size} bytes, exceeding the ${maxBlobBytes}-byte ceiling`,
      {
        // A `call` blob holds nothing but the request, so only the args can
        // be what is too big; a `machine` blob is dominated by its snapshot.
        hint:
          payload.kind === 'call'
            ? 'The arguments are too large to seal for approval; shrink them and call call_tool again.'
            : 'Machine context is too large to suspend. Keep large tool results out of context — store only the fields later states need — then re-run execute_machine.',
      },
    );
  }
  return blob;
}

export interface OpenBlobOptions {
  /** The tool opening the blob (R36). Default `machine`. */
  expectedKind?: BlobKind | undefined;
  /**
   * The text re-sent with the retry (S4): the `code` argument for
   * `execute_machine`, the canonical request for `call_tool`.
   */
  code: string;
  /** Identity of the wrapped server handling the retry (R30). */
  serverIdentity: string;
  config: BlobSealerConfig;
  /** Clock override for testability, Unix ms. Default `Date.now()`. */
  now?: number | undefined;
}

/**
 * Verify and open a sealed blob (R21 — check order is normative):
 *
 * 1. parse envelope + decrypt/authenticate (current key, then each
 *    `previousKeys` — R22 rotation grace)
 * 2. schema version, then exact `libv`/`xstatev` match (Q3: strict, no
 *    migration)
 * 3. expiry (`exp` strictly in the future relative to `now`)
 * 4. `codeHash` equality against the re-sent code, and `serverIdentity`
 *    match
 *
 * Any failure throws ProjectionError phase `blob_verification` naming the
 * failed check (never key material or plaintext). A payload is only
 * returned once every check has passed.
 */
export function openBlob(blob: string, options: OpenBlobOptions): BlobPayload {
  assertConfigKeys(options.config);

  // (0) Inbound size guard: the sealer never emits a blob above
  // `maxBlobBytes` (R23), so anything larger is garbage — reject it before
  // spending any base64/AES work on it (pre-auth DoS resistance). A small
  // slack multiple keeps this insensitive to byte-vs-char accounting.
  const maxBlobBytes = options.config.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
  if (blob.length > maxBlobBytes * 2) {
    throw verificationError(
      `blob rejected: ${blob.length} characters exceeds the acceptance limit for a ${maxBlobBytes}-byte ceiling`,
      HINT_CORRUPT,
    );
  }

  // (1) Parse + decrypt/authenticate.
  const envelope = parseEnvelope(blob);
  const compressed = decryptWithAnyKey(envelope, options.config);
  let payload: unknown;
  try {
    // Decompression cap (defense-in-depth): bound the inflate output
    // rather than trusting it. Generous multiple — the ceiling applies to
    // the sealed size, and a legitimate payload may compress well — but a
    // decompression bomb is cut off long before it exhausts memory.
    payload = JSON.parse(
      inflateRawSync(compressed, { maxOutputLength: maxBlobBytes * 64 }).toString('utf8'),
    ) as unknown;
  } catch {
    throw verificationError(
      'blob payload is corrupt: decompression or JSON parse failed after authentication',
      HINT_CORRUPT,
    );
  }
  if (!isRecord(payload)) {
    throw verificationError('blob payload malformed: not a JSON object', HINT_CORRUPT);
  }

  // (2) Schema version, then exact library/XState version match (Q3).
  if (payload['v'] !== BLOB_SCHEMA_VERSION) {
    throw verificationError(
      `unknown blob schema version ${JSON.stringify(payload['v'])} (this library expects ${BLOB_SCHEMA_VERSION})`,
      HINT_VERSION,
    );
  }
  if (payload['libv'] !== LIB_VERSION) {
    throw verificationError(
      `library version mismatch: blob was sealed by @astral-mcp/projection ${JSON.stringify(payload['libv'])}, this instance runs ${LIB_VERSION}`,
      HINT_VERSION,
    );
  }
  if (payload['xstatev'] !== XSTATE_VERSION) {
    throw verificationError(
      `xstate version mismatch: blob snapshot was produced under xstate ${JSON.stringify(payload['xstatev'])}, this instance runs ${XSTATE_VERSION}`,
      HINT_VERSION,
    );
  }
  assertPayloadShape(payload);
  const verified = payload as unknown as BlobPayload;

  // (3) Expiry.
  const now = options.now ?? Date.now();
  if (now >= verified.exp) {
    throw verificationError(
      `blob expired: exp was ${verified.exp} and it is now ${now}`,
      HINT_EXPIRED,
    );
  }

  // (3b) Kind (R36): a blob minted by one tool cannot be opened by the other.
  const expectedKind = options.expectedKind ?? 'machine';
  if (verified.kind !== expectedKind) {
    throw verificationError(
      `blob kind mismatch: this requestState was issued by ${toolFor(verified.kind)} and cannot be used with ${toolFor(expectedKind)}`,
      HINT_KIND,
    );
  }

  // (4) Binding hash (S4) and server identity (R30, cross-server replay).
  if (hashCode(options.code) !== verified.codeHash) {
    throw verified.kind === 'call'
      ? verificationError(
          "request mismatch: the retried call's name or args differ from the request that produced this requestState",
          HINT_REQUEST,
        )
      : verificationError(
          "code hash mismatch: the retried call's code differs from the code that produced this blob",
          HINT_CODE,
        );
  }
  if (options.serverIdentity !== verified.serverIdentity) {
    throw verificationError(
      'server identity mismatch: blob was minted against a different wrapped server',
      HINT_SERVER,
    );
  }

  return verified;
}
