import { describe, expect, it } from 'vitest';
import {
  buildBlobPayload,
  DEFAULT_TTL_MS,
  ENVELOPE_PREFIX,
  hashCode,
  LIB_VERSION,
  openBlob,
  sealBlob,
  XSTATE_VERSION,
} from '../../src/blob/index.js';
import { McCircuitError } from '../../src/errors.js';
import { BLOB_SCHEMA_VERSION, type BlobPayload, type BlobSealerConfig } from '../../src/types.js';

const KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(9);
const THIRD_KEY = new Uint8Array(32).fill(11);

const CODE = 'export default setup({}).createMachine({ id: "m" });';
const SERVER_IDENTITY = 'srv://wrapped/default';
const NOW = 1_754_000_000_000;

const SECRET_MARKER = 'SECRET_CONTEXT_MARKER_bd91';

function makeConfig(overrides: Partial<BlobSealerConfig> = {}): BlobSealerConfig {
  return { key: KEY, ...overrides };
}

function makePayload(overrides: Partial<BlobPayload> = {}): BlobPayload {
  return {
    ...buildBlobPayload({
      code: CODE,
      serverIdentity: SERVER_IDENTITY,
      snapshot: {
        status: 'active',
        value: 'awaitingApproval',
        context: { secret: SECRET_MARKER, count: 3 },
      },
      pending: {
        'call-1': {
          id: 'call-1',
          name: 'delete_file',
          args: { path: '/tmp/x', marker: SECRET_MARKER },
          stateName: 'awaitingApproval',
        },
      },
      trip: 1,
      now: NOW,
    }),
    ...overrides,
  };
}

function open(blob: string, overrides: Partial<Parameters<typeof openBlob>[1]> = {}): BlobPayload {
  return openBlob(blob, {
    code: CODE,
    serverIdentity: SERVER_IDENTITY,
    config: makeConfig(),
    now: NOW + 1_000,
    ...overrides,
  });
}

function expectVerificationFailure(fn: () => unknown, messagePattern: RegExp): McCircuitError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(McCircuitError);
  const err = caught as McCircuitError;
  expect(err.phase).toBe('blob_verification');
  expect(err.message).toMatch(messagePattern);
  expect(err.hint).not.toBe('');
  return err;
}

describe('sealBlob / openBlob round trip', () => {
  it('round-trips a payload through seal and open', () => {
    const payload = makePayload();
    const blob = sealBlob(payload, makeConfig());
    expect(blob.startsWith(`${ENVELOPE_PREFIX}.`)).toBe(true);
    expect(blob).toMatch(/^mcc1(\.[A-Za-z0-9_-]+){4}$/);
    expect(open(blob)).toEqual(payload);
  });

  it('opens right up to (but not at) the expiry instant', () => {
    const payload = makePayload();
    const blob = sealBlob(payload, makeConfig());
    expect(open(blob, { now: payload.exp - 1 })).toEqual(payload);
    expectVerificationFailure(() => open(blob, { now: payload.exp }), /expired/);
  });
});

describe('confidentiality (S3)', () => {
  it('does not expose payload plaintext in the sealed output', () => {
    const blob = sealBlob(makePayload(), makeConfig());
    for (const fragment of [
      SECRET_MARKER,
      'delete_file',
      'awaitingApproval',
      SERVER_IDENTITY,
      'codeHash',
      'snapshot',
      hashCode(CODE),
    ]) {
      expect(blob).not.toContain(fragment);
      expect(blob).not.toContain(Buffer.from(fragment, 'utf8').toString('base64url'));
    }
  });

  it('never reuses a GCM nonce or salt across seals', () => {
    const payload = makePayload();
    const config = makeConfig();
    const salts = new Set<string>();
    const ivs = new Set<string>();
    const blobs = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const blob = sealBlob(payload, config);
      const parts = blob.split('.');
      salts.add(parts[1] ?? '');
      ivs.add(parts[2] ?? '');
      blobs.add(blob);
    }
    expect(salts.size).toBe(50);
    expect(ivs.size).toBe(50);
    expect(blobs.size).toBe(50);
  });
});

describe('authentication and tampering', () => {
  it('rejects a blob sealed under a different key', () => {
    const blob = sealBlob(makePayload(), { key: OTHER_KEY });
    expectVerificationFailure(() => open(blob), /authentication failed/);
  });

  it('rejects tampered ciphertext', () => {
    const blob = sealBlob(makePayload(), makeConfig());
    const parts = blob.split('.');
    const ct = parts[3] ?? '';
    parts[3] = (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1);
    expectVerificationFailure(() => open(parts.join('.')), /authentication failed/);
  });

  it('rejects a tampered auth tag', () => {
    const blob = sealBlob(makePayload(), makeConfig());
    const parts = blob.split('.');
    const tag = parts[4] ?? '';
    parts[4] = (tag[0] === 'A' ? 'B' : 'A') + tag.slice(1);
    expectVerificationFailure(() => open(parts.join('.')), /authentication failed/);
  });

  it('rejects a swapped envelope header (salt from another blob) via AAD/key derivation', () => {
    const config = makeConfig();
    const a = sealBlob(makePayload(), config).split('.');
    const b = sealBlob(makePayload(), config).split('.');
    a[1] = b[1] ?? ''; // graft blob B's salt onto blob A
    expectVerificationFailure(() => open(a.join('.')), /authentication failed/);
  });

  it('rejects a swapped iv', () => {
    const config = makeConfig();
    const a = sealBlob(makePayload(), config).split('.');
    const b = sealBlob(makePayload(), config).split('.');
    a[2] = b[2] ?? '';
    expectVerificationFailure(() => open(a.join('.')), /authentication failed/);
  });

  it('rejects a downgraded/foreign envelope version prefix', () => {
    const blob = sealBlob(makePayload(), makeConfig());
    const tampered = blob.replace(/^mcc1\./, 'mcc0.');
    expectVerificationFailure(() => open(tampered), /unsupported envelope version/);
  });

  it('rejects garbage and structurally invalid envelopes', () => {
    expectVerificationFailure(() => open('not-a-blob'), /envelope parse failed/);
    expectVerificationFailure(() => open('mcc1.only.three.parts'), /envelope parse failed/);
    expectVerificationFailure(() => open('mcc1.a!b.c.d.e'), /envelope parse failed/);
    expectVerificationFailure(() => open('mcc1..c.d.e'), /envelope parse failed/);
  });
});

describe('version checks (R21 step 2, Q3 strict rejection)', () => {
  it('rejects an unknown blob schema version', () => {
    const blob = sealBlob(makePayload({ v: BLOB_SCHEMA_VERSION + 1 }), makeConfig());
    expectVerificationFailure(() => open(blob), /unknown blob schema version/);
  });

  it('rejects a libv mismatch', () => {
    const blob = sealBlob(makePayload({ libv: '0.0.0-other' }), makeConfig());
    expectVerificationFailure(() => open(blob), /library version mismatch/);
  });

  it('rejects an xstatev mismatch', () => {
    const blob = sealBlob(makePayload({ xstatev: '5.0.0' }), makeConfig());
    expectVerificationFailure(() => open(blob), /xstate version mismatch/);
  });
});

describe('expiry (R21 step 3)', () => {
  it('rejects an expired blob with an expiry message', () => {
    const payload = makePayload();
    const blob = sealBlob(payload, makeConfig());
    const err = expectVerificationFailure(
      () => open(blob, { now: payload.exp + 60_000 }),
      /blob expired/,
    );
    expect(err.hint).toMatch(/[Rr]e-run execute_machine/);
  });

  it('reports expiry before code hash when both fail (normative order)', () => {
    const payload = makePayload();
    const blob = sealBlob(payload, makeConfig());
    expectVerificationFailure(
      () => open(blob, { now: payload.exp + 1, code: 'different code' }),
      /blob expired/,
    );
  });
});

describe('code and server binding (R21 step 4, S4, R30)', () => {
  it('rejects a retry with different code', () => {
    const blob = sealBlob(makePayload(), makeConfig());
    expectVerificationFailure(
      () => open(blob, { code: `${CODE}\n// tampered` }),
      /code hash mismatch/,
    );
  });

  it('rejects a cross-server replay', () => {
    const blob = sealBlob(makePayload(), makeConfig());
    expectVerificationFailure(
      () => open(blob, { serverIdentity: 'srv://wrapped/other' }),
      /server identity mismatch/,
    );
  });
});

describe('key rotation (R22)', () => {
  it('opens an old-key-sealed blob via previousKeys', () => {
    const payload = makePayload();
    const blob = sealBlob(payload, { key: OTHER_KEY });
    const opened = open(blob, { config: { key: KEY, previousKeys: [THIRD_KEY, OTHER_KEY] } });
    expect(opened).toEqual(payload);
  });

  it('rejects a blob sealed under a key absent from the rotation set', () => {
    const blob = sealBlob(makePayload(), { key: OTHER_KEY });
    expectVerificationFailure(
      () => open(blob, { config: { key: KEY, previousKeys: [THIRD_KEY] } }),
      /authentication failed/,
    );
  });
});

describe('size ceiling (R23)', () => {
  it('throws a terminal error with a slim-your-context hint when the sealed blob exceeds maxBlobBytes', () => {
    // Incompressible payload: random bytes defeat deflate.
    const big = Buffer.from(
      Array.from({ length: 64 * 1024 }, () => Math.floor(Math.random() * 256)),
    ).toString('base64');
    const payload = makePayload({ snapshot: { blobby: big } });
    let caught: unknown;
    try {
      sealBlob(payload, makeConfig({ maxBlobBytes: 16 * 1024 }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McCircuitError);
    const err = caught as McCircuitError;
    expect(err.phase).toBe('terminal');
    expect(err.message).toMatch(/exceeding the 16384-byte ceiling/);
    expect(err.hint).toMatch(/context/i);
  });

  it('applies the 128 KB default ceiling', () => {
    const big = Buffer.from(
      Array.from({ length: 256 * 1024 }, () => Math.floor(Math.random() * 256)),
    ).toString('base64');
    const payload = makePayload({ snapshot: { blobby: big } });
    expect(() => sealBlob(payload, makeConfig())).toThrowError(/ceiling/);
  });
});

describe('config validation', () => {
  it('rejects a key that is not 32 bytes as terminal', () => {
    let caught: unknown;
    try {
      sealBlob(makePayload(), { key: new Uint8Array(16) });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McCircuitError);
    expect((caught as McCircuitError).phase).toBe('terminal');
  });

  it('rejects malformed previousKeys on open as terminal', () => {
    const blob = sealBlob(makePayload(), makeConfig());
    let caught: unknown;
    try {
      open(blob, { config: { key: KEY, previousKeys: [new Uint8Array(8)] } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(McCircuitError);
    expect((caught as McCircuitError).phase).toBe('terminal');
  });
});

describe('buildBlobPayload', () => {
  it('stamps schema and library versions and fills timing fields', () => {
    const payload = makePayload();
    expect(payload.v).toBe(BLOB_SCHEMA_VERSION);
    expect(payload.libv).toBe(LIB_VERSION);
    expect(payload.xstatev).toBe(XSTATE_VERSION);
    expect(payload.codeHash).toBe(hashCode(CODE));
    expect(payload.iat).toBe(NOW);
    expect(payload.exp).toBe(NOW + DEFAULT_TTL_MS);
    expect(payload.nonce).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('honors a custom ttlMs', () => {
    const payload = buildBlobPayload({
      code: CODE,
      serverIdentity: SERVER_IDENTITY,
      snapshot: null,
      pending: {},
      trip: 0,
      ttlMs: 1_000,
      now: NOW,
    });
    expect(payload.exp).toBe(NOW + 1_000);
  });

  it('generates a unique nonce per payload', () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 50; i++) {
      nonces.add(makePayload().nonce);
    }
    expect(nonces.size).toBe(50);
  });
});

describe('inbound hardening', () => {
  it('rejects an oversized inbound blob before any crypto work', () => {
    const giant = `${ENVELOPE_PREFIX}.${'A'.repeat(20 * 1024 * 1024)}.AAAA.AAAA.AAAA`;
    const started = performance.now();
    expect(() => open(giant)).toThrowError(McCircuitError);
    expect(performance.now() - started).toBeLessThan(50);
    try {
      open(giant);
    } catch (err) {
      expect((err as McCircuitError).phase).toBe('blob_verification');
      expect((err as McCircuitError).message).toContain('acceptance limit');
    }
  });

  it('still opens a legitimate blob near the size ceiling', () => {
    // Incompressible payload close to (but under) the sealed ceiling.
    const bytes = Buffer.from(
      Array.from({ length: 60_000 }, (_, i) => (i * 2_654_435_761) % 256),
    ).toString('base64');
    const payload = makePayload({ snapshot: { status: 'active', value: 'x', context: { bytes } } });
    const blob = sealBlob(payload, makeConfig());
    expect(open(blob)).toEqual(payload);
  });

  it('caps decompression output for authenticated but bomb-like payloads', () => {
    // Sealed with the real key (post-auth path), 20 MB of zeros compresses tiny.
    const payload = makePayload({
      snapshot: { status: 'active', value: 'x', context: { z: '0'.repeat(20 * 1024 * 1024) } },
    });
    const blob = sealBlob(payload, makeConfig({ maxBlobBytes: 128 * 1024 }));
    expect(() => open(blob, { config: makeConfig({ maxBlobBytes: 128 * 1024 }) })).toThrowError(
      /corrupt/,
    );
  });
});
