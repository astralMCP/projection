/**
 * Redaction of upstream credentials (PRD R59 "Where credentials never go",
 * S1). A server given by URL sees the access token on every request and can
 * echo it back — in a 5xx body that becomes an SDK error message, in a tool
 * error, in a tool description. Each connection therefore remembers every
 * secret it has presented or been given (access and refresh tokens, the
 * client secret) and scrubs them from every string that originates from
 * that connection before it reaches an error, a result or the model.
 */

/** What a redacted secret is replaced with. */
export const REDACTED = '[redacted]';

/** Secrets remembered per connection: plenty for hourly rotation, bounded for a long-lived process. */
const MAX_SECRETS = 64;

/** Longest upstream-originated error text kept (S5): longer is cut. */
export const MAX_UPSTREAM_ERROR_CHARS = 1_000;

/** `value` and its URL-, form- and JSON-encoded spellings. */
function spellings(value: string): string[] {
  return [
    ...new Set([
      value,
      encodeURIComponent(value),
      new URLSearchParams({ v: value }).toString().slice(2),
      JSON.stringify(value).slice(1, -1),
    ]),
  ];
}

export class SecretSet {
  /** Configuration secrets (the client secret): never evicted. */
  readonly #pinned: string[] = [];
  /** Tokens, most recent last; the oldest are evicted past {@link MAX_SECRETS}. */
  readonly #secrets: string[] = [];

  /** Remember a configuration secret for the life of the connection. */
  pin(value: string | undefined): void {
    if (value === undefined || value === '') return;
    for (const spelling of spellings(value)) {
      if (!this.#pinned.includes(spelling)) this.#pinned.push(spelling);
    }
  }

  /** Remember tokens (and their encoded spellings). Empty and undefined values are ignored. */
  add(...values: (string | undefined)[]): void {
    for (const value of values) {
      if (value === undefined || value === '') continue;
      for (const spelling of spellings(value)) {
        const at = this.#secrets.indexOf(spelling);
        if (at !== -1) this.#secrets.splice(at, 1);
        this.#secrets.push(spelling);
        if (this.#secrets.length > MAX_SECRETS) this.#secrets.shift();
      }
    }
  }

  /** `text` with every remembered secret replaced by {@link REDACTED}, longest first. */
  scrub(text: string): string {
    let result = text;
    const all = [...this.#pinned, ...this.#secrets];
    for (const secret of all.toSorted((a, b) => b.length - a.length)) {
      if (result.includes(secret)) result = result.replaceAll(secret, REDACTED);
    }
    return result;
  }

  /**
   * `value` with every remembered secret scrubbed from its JSON form. The
   * value is returned as is when no secret occurs in it; a value that does
   * not serialize is returned as `undefined` (it cannot be checked).
   */
  scrubValue<T>(value: T): T | undefined {
    if (value === undefined || this.#pinned.length + this.#secrets.length === 0) return value;
    let text: string | undefined;
    try {
      text = JSON.stringify(value);
    } catch {
      return undefined;
    }
    if (text === undefined) return value;
    const scrubbed = this.scrub(text);
    if (scrubbed === text) return value;
    try {
      return JSON.parse(scrubbed) as T;
    } catch {
      return undefined;
    }
  }
}
