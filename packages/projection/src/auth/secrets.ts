/**
 * Redaction of upstream credentials (PRD R59 "Where credentials never go",
 * S1). A server given by URL sees the access token on every request and can
 * echo it back — in a 5xx body that becomes an SDK error message, in a tool
 * error, in a tool description. Each connection therefore remembers every
 * secret it has presented or been given (access and refresh tokens, the
 * client secret) and scrubs them from every string that originates from
 * that connection before it reaches an error, a result or the model.
 *
 * Redaction is exact matching against accidental echoes: the raw value and
 * its URL-, form-, JSON- and base64-encoded spellings. It is not a defence
 * against a hostile server, which can always re-encode a token it was sent.
 */

import { Buffer } from 'node:buffer';
import { ProjectionError } from '../errors.js';
import { stripInvisible } from '../text-safety.js';

/** What a redacted secret is replaced with. */
export const REDACTED = '[redacted]';

/**
 * Secrets shorter than this are never substring-redacted: replacing every
 * `e` or `1` in server text would corrupt it (and the catalog built from
 * it) without hiding anything. They are still never logged.
 */
export const MIN_REDACTED_SECRET_CHARS = 8;

/** Tokens remembered per connection: plenty for hourly rotation, bounded for a long-lived process. */
const MAX_TOKENS = 32;

/** Longest upstream-originated error text kept (S5): longer is cut. */
export const MAX_UPSTREAM_ERROR_CHARS = 1_000;

/**
 * `value` and its URL-, form-, JSON-, base64- and base64url-encoded
 * spellings (base64 without padding, so a padded echo matches too), each at
 * least {@link MIN_REDACTED_SECRET_CHARS} long — none when `value` itself is
 * shorter.
 */
function spellings(value: string): string[] {
  if (value.length < MIN_REDACTED_SECRET_CHARS) return [];
  const bytes = Buffer.from(value, 'utf8');
  return [
    ...new Set([
      value,
      encodeURIComponent(value),
      new URLSearchParams({ v: value }).toString().slice(2),
      JSON.stringify(value).slice(1, -1),
      bytes.toString('base64').replace(/=+$/, ''),
      bytes.toString('base64url'),
    ]),
  ].filter((spelling) => spelling.length >= MIN_REDACTED_SECRET_CHARS);
}

/** The fail-closed error for a value whose redaction cannot be checked or rebuilt. */
function unscrubbable(): ProjectionError {
  return new ProjectionError(
    'protocol',
    'a value from the upstream server could not be checked for credentials, so it was withheld',
    {
      hint: 'The server returned data Projection cannot inspect (not JSON-serializable, too deeply nested, or a credential in a property name).',
    },
  );
}

export class SecretSet {
  /** Configuration secrets (the client secret), with their spellings: never evicted. */
  readonly #pinned = new Map<string, string[]>();
  /** Tokens, with their spellings, least recently added first; the oldest are evicted past {@link MAX_TOKENS}. */
  readonly #tokens = new Map<string, string[]>();
  /** Every spelling, longest first; rebuilt after a change. */
  #sorted: string[] | undefined;

  /** Remember a configuration secret for the life of the connection. */
  pin(value: string | undefined): void {
    if (value === undefined || value === '' || this.#pinned.has(value)) return;
    this.#pinned.set(value, spellings(value));
    this.#sorted = undefined;
  }

  /** Remember tokens (and their encoded spellings). Empty and undefined values are ignored. */
  add(...values: (string | undefined)[]): void {
    for (const value of values) {
      if (value === undefined || value === '') continue;
      const known = this.#tokens.get(value);
      this.#tokens.delete(value);
      this.#tokens.set(value, known ?? spellings(value));
      if (this.#tokens.size > MAX_TOKENS) {
        const oldest = this.#tokens.keys().next().value;
        if (oldest !== undefined) this.#tokens.delete(oldest);
      }
      this.#sorted = undefined;
    }
  }

  #secrets(): string[] {
    this.#sorted ??= [
      ...new Set([...this.#pinned.values(), ...this.#tokens.values()].flat()),
    ].toSorted((a, b) => b.length - a.length);
    return this.#sorted;
  }

  /**
   * `text` with every remembered secret replaced by {@link REDACTED},
   * longest first. When a secret appears only once invisible characters
   * are stripped (a token interleaved with zero-width characters, which box
   * surfaces strip before showing), the stripped text is returned, redacted.
   */
  scrub(text: string): string {
    const secrets = this.#secrets();
    if (secrets.length === 0) return text;
    const result = replaceAll(text, secrets);
    const visible = stripInvisible(result);
    if (visible === result || !secrets.some((secret) => visible.includes(secret))) return result;
    return replaceAll(visible, secrets);
  }

  /**
   * `value` with every remembered secret scrubbed from its string leaves —
   * never from property names or JSON syntax. The value is returned as is
   * when no secret occurs in it, and rebuilt as plain JSON data otherwise.
   * Fails closed with a {@link ProjectionError} when the value cannot be
   * checked or rebuilt: it does not serialize, it nests too deeply, or a
   * property name carries a secret.
   */
  scrubValue<T>(value: T): T {
    if (value === undefined || this.#secrets().length === 0) return value;
    if (typeof value === 'string') return this.scrub(value) as T;
    let plain: unknown;
    try {
      const text = JSON.stringify(value);
      if (text === undefined) return value;
      plain = JSON.parse(text);
    } catch {
      throw unscrubbable();
    }
    let changed = false;
    const walk = (node: unknown): unknown => {
      if (typeof node === 'string') {
        const scrubbed = this.scrub(node);
        if (scrubbed !== node) changed = true;
        return scrubbed;
      }
      if (Array.isArray(node)) return node.map(walk);
      if (node === null || typeof node !== 'object') return node;
      const rebuilt: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(node)) {
        if (this.scrub(name) !== name) throw unscrubbable();
        // defineProperty: a `__proto__` name stays an own property.
        Object.defineProperty(rebuilt, name, {
          value: walk(child),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return rebuilt;
    };
    let rebuilt: unknown;
    try {
      rebuilt = walk(plain);
    } catch {
      throw unscrubbable();
    }
    return changed ? (rebuilt as T) : value;
  }
}

function replaceAll(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const secret of secrets) {
    if (result.includes(secret)) result = result.replaceAll(secret, REDACTED);
  }
  return result;
}
