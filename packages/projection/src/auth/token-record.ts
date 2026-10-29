/**
 * Projection's serialization of a stored token set (PRD R59): the value a
 * {@link TokenStore} holds under a `tokens:` key. Internal: a store sees an
 * opaque string, and compare-and-delete compares those strings (R58).
 */

/**
 * A stored token set (R59). Serialized as ASCII JSON; an `id_token` is never
 * stored. `expires_at` is in seconds since the epoch. `issuer` is the
 * authorization server the tokens were issued by, so they are never
 * presented to another one (SEP-2352 / R61).
 */
export interface TokenRecord {
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  scope?: string;
  issuer: string;
}

/** A copy holding only the {@link TokenRecord} fields, in a fixed order. */
function normalize(record: TokenRecord): TokenRecord {
  return {
    access_token: record.access_token,
    ...(record.refresh_token !== undefined ? { refresh_token: record.refresh_token } : {}),
    ...(record.expires_at !== undefined ? { expires_at: record.expires_at } : {}),
    ...(record.scope !== undefined ? { scope: record.scope } : {}),
    issuer: record.issuer,
  };
}

/** ASCII JSON of a record (R59): the known fields in a fixed order, every non-ASCII character escaped. */
export function encodeTokenRecord(record: TokenRecord): string {
  return JSON.stringify(normalize(record)).replace(
    /[\u0080-￿]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

/**
 * Parse a stored value. Anything that is not a well-formed record — not a
 * string, not JSON, a missing or empty `access_token` — reads as absent:
 * the user signs in again.
 */
export function decodeTokenRecord(text: unknown): TokenRecord | undefined {
  if (typeof text !== 'string') return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const accessToken = record['access_token'];
  const issuer = record['issuer'];
  const expiresAt = record['expires_at'];
  if (typeof accessToken !== 'string' || accessToken === '' || typeof issuer !== 'string')
    return undefined;
  if (!optionalString(record['refresh_token']) || !optionalString(record['scope']))
    return undefined;
  if (expiresAt !== undefined && (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt))) {
    return undefined;
  }
  return normalize(record as unknown as TokenRecord);
}
