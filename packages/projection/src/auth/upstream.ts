/**
 * Upstream sources given by URL (PRD §6.10, R51, R60): the `UpstreamSpec`
 * shape, how it is told apart from the other source kinds, and its
 * validation and canonical form.
 *
 * Every mistake here is a `validate` {@link ProjectionError} raised at wrap
 * time, before anything connects (R39's rule). Messages never echo a value
 * that could be a secret: the client secret is never quoted, and a URL is
 * quoted only after it parsed without userinfo.
 */

import { invalidConfig as invalid } from '../errors.js';
import { capLength, quoted } from '../text-safety.js';
import { isPlainObject } from '../types.js';

/**
 * OAuth settings of an {@link UpstreamSpec} (R51, R52, R53, R61). Phase 1
 * needs a client the integrator registered beforehand: `clientId`, and a
 * discouraged `clientSecret`. `clientMetadataUrl` and
 * `authorizationEndpoint` arrive with phase 1b and are `validate` errors
 * until then.
 */
export interface UpstreamOAuthOptions {
  /** The OAuth client id the integrator registered with the server's authorization server (R52). */
  clientId: string;
  /** Client secret for a confidential client. Discouraged: the device flow needs none (R52). */
  clientSecret?: string;
  /** Scopes to request, replacing the SDK's selection from metadata (R53). */
  scopes?: string[];
  /**
   * Extra hosts the user may be sent to for sign-in, beyond the
   * authorization server's own (R61). Bare lowercase ASCII hostnames, not IP addresses.
   */
  signInHosts?: string[];
  /** Token endpoint override for servers with incomplete metadata (R53). `https:` only. */
  tokenEndpoint?: string;
  /** Device authorization endpoint override (R53). `https:` only. */
  deviceAuthorizationEndpoint?: string;
}

/**
 * A remote MCP server given by its URL (R51). Projection builds the
 * Streamable HTTP transport itself, installs its own OAuth client provider
 * on it, owns the resulting connection and closes it in `close()`.
 */
export interface UpstreamSpec {
  /** The server's Streamable HTTP endpoint. `https:`, or `http:` on a loopback host. */
  url: string | URL;
  oauth?: UpstreamOAuthOptions;
}

/** A validated {@link UpstreamOAuthOptions}, frozen at wrap time. */
export interface ResolvedOAuth {
  readonly clientId: string;
  readonly clientSecret?: string;
  readonly scopes?: readonly string[];
  readonly signInHosts?: readonly string[];
  readonly tokenEndpoint?: string;
  readonly deviceAuthorizationEndpoint?: string;
}

/** A validated {@link UpstreamSpec}. */
export interface ResolvedUpstream {
  /** The parsed URL the transport connects to. */
  readonly url: URL;
  /** The canonical URL (R51): the resource's identity, token-store key and blob binding. */
  readonly canonicalUrl: string;
  /** The R60 per-server identity, `url:<canonical url>`. */
  readonly identity: string;
  /** The URL's hostname as the parser gives it (ASCII, punycode for IDNs). */
  readonly host: string;
  readonly oauth?: ResolvedOAuth;
}

const SPEC_KEYS: ReadonlySet<string> = new Set(['url', 'oauth']);
const OAUTH_KEYS: ReadonlySet<string> = new Set([
  'clientId',
  'clientSecret',
  'scopes',
  'signInHosts',
  'tokenEndpoint',
  'deviceAuthorizationEndpoint',
]);
/** Settings R51 defines for phase 1b, which this version does not use: refused rather than ignored. */
const LATER_PHASE_OAUTH_KEYS: ReadonlySet<string> = new Set([
  'clientMetadataUrl',
  'authorizationEndpoint',
]);

/** The loopback hosts on which `http:` is allowed (R51), as the WHATWG parser prints them. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]', 'localhost']);

/** An RFC 6749 §3.3 scope token. */
const SCOPE_TOKEN = /^[\x21\x23-\x5b\x5d-\x7e]+$/;
/** A bare lowercase ASCII hostname: dot-separated LDH labels (R51). */
const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Longest source or endpoint URL accepted (R51): longer is a `validate` error. */
export const MAX_URL_CHARS = 2048;

/** Longest URL text a hint quotes. */
const HINT_URL_CHARS = 200;

/**
 * R51: a value is an {@link UpstreamSpec} when it is a plain object with an
 * own `url` property, no own `source` property, and neither a `callTool`
 * nor a `connect` function. Shape only: {@link resolveUpstreamSpec}
 * validates it.
 */
export function isUpstreamSpecShape(value: unknown): value is Record<string, unknown> {
  return (
    isPlainObject(value) &&
    Object.hasOwn(value, 'url') &&
    !Object.hasOwn(value, 'source') &&
    typeof value['callTool'] !== 'function' &&
    typeof value['connect'] !== 'function'
  );
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * The canonical URL (R51): the WHATWG serialization (scheme and host
 * lowercased, default port dropped, an empty path written as `/`), without
 * a fragment, with every `@` in the path and query percent-encoded as `%40`,
 * so a canonical URL never contains `@` and a URL identity can never equal a
 * `name@version` one (R60).
 */
export function canonicalizeUrl(url: URL): string {
  const path = url.pathname.replaceAll('@', '%40');
  const query = url.search.replaceAll('@', '%40');
  return `${url.protocol}//${url.host}${path}${query}`;
}

/**
 * Parse and check a source URL (R51): `https:`, or `http:` on a loopback
 * host; no userinfo; no fragment. `label` names the setting in messages.
 */
function parseSourceUrl(raw: unknown, label: string): URL {
  if (typeof raw !== 'string' && !(raw instanceof URL)) {
    throw invalid(
      `${label}: "url" must be a string or a URL`,
      'Pass the server URL, e.g. "https://api.example.com/mcp".',
    );
  }
  const text = raw instanceof URL ? raw.href : raw;
  if (text.length > MAX_URL_CHARS) {
    throw invalid(
      `${label}: "url" is longer than ${MAX_URL_CHARS} characters`,
      'Pass the server endpoint URL itself; Projection treats the URL as configuration, not as a place for data.',
    );
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw invalid(
      `${label}: "url" is not a valid absolute URL`,
      'Pass an absolute URL, e.g. "https://api.example.com/mcp".',
    );
  }
  // Checked before anything quotes the URL: credentials in it must never
  // reach an error message.
  if (url.username !== '' || url.password !== '') {
    throw invalid(
      `${label}: "url" carries credentials (user information before the host)`,
      'Remove the user:password@ part. Projection never takes upstream credentials in configuration; sign-in tokens live in the token store (R50, R59). Rotate any credential that was in the URL.',
    );
  }
  if (url.href.includes('#')) {
    throw invalid(
      `${label}: "url" has a fragment`,
      'Remove the #fragment: it is never sent to the server.',
    );
  }
  if (url.protocol === 'http:') {
    if (!isLoopbackHost(url.hostname)) {
      throw invalid(
        `${label}: "url" must use https: (http: is allowed only on 127.0.0.1, [::1] and localhost)`,
        `Use ${capLength(`https://${url.host}${url.pathname}`, HINT_URL_CHARS)}.`,
      );
    }
  } else if (url.protocol !== 'https:') {
    throw invalid(
      `${label}: "url" must use https:`,
      'Projection connects to remote servers over Streamable HTTP only.',
    );
  }
  return url;
}

/** An authorization-server endpoint override (R51): `https:`, loopback only for a loopback source. */
function parseEndpoint(
  raw: unknown,
  setting: string,
  label: string,
  sourceIsLoopback: boolean,
): string {
  if (typeof raw !== 'string') {
    throw invalid(
      `${label}: oauth.${setting} must be a string URL`,
      `Pass an https: URL for oauth.${setting}, or omit it.`,
    );
  }
  if (raw.length > MAX_URL_CHARS) {
    throw invalid(
      `${label}: oauth.${setting} is longer than ${MAX_URL_CHARS} characters`,
      `Pass the endpoint URL itself for oauth.${setting}.`,
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid(
      `${label}: oauth.${setting} is not a valid absolute URL`,
      `Pass an https: URL for oauth.${setting}.`,
    );
  }
  if (url.username !== '' || url.password !== '' || url.href.includes('#')) {
    throw invalid(
      `${label}: oauth.${setting} must not carry credentials or a fragment`,
      `Pass a plain https: URL for oauth.${setting}.`,
    );
  }
  const loopbackHttp = url.protocol === 'http:' && sourceIsLoopback && isLoopbackHost(url.hostname);
  if (url.protocol !== 'https:' && !loopbackHttp) {
    throw invalid(
      `${label}: oauth.${setting} must use https:`,
      'Every authorization-server endpoint must be https: (http: on loopback only when the source URL is itself loopback).',
    );
  }
  return url.href;
}

function parseStringList(
  raw: unknown,
  setting: string,
  label: string,
  check: (item: string) => boolean,
  hint: string,
): string[] {
  if (!Array.isArray(raw))
    throw invalid(`${label}: oauth.${setting} must be an array of strings`, hint);
  const items: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !check(item)) {
      throw invalid(
        `${label}: oauth.${setting} has an invalid entry${typeof item === 'string' ? ` ${quoted(item)}` : ''}`,
        hint,
      );
    }
    if (!items.includes(item)) items.push(item);
  }
  return items;
}

/**
 * A `signInHosts` entry (R51, R61): a bare lowercase ASCII hostname, never
 * an IP address. An IP literal names no identity provider, and a last label
 * of digits is what makes the WHATWG parser read a host as IPv4, so such an
 * entry (`127.0.0.1`, `10.0.0.1`) is refused; IPv6 literals fail the
 * hostname grammar already.
 */
function isBareHostname(host: string): boolean {
  if (!HOSTNAME.test(host)) return false;
  if (/^[0-9]+$/.test(host.slice(host.lastIndexOf('.') + 1))) return false;
  try {
    return new URL(`https://${host}/`).hostname === host;
  } catch {
    return false;
  }
}

function resolveOAuth(raw: unknown, label: string, sourceIsLoopback: boolean): ResolvedOAuth {
  if (!isPlainObject(raw)) {
    throw invalid(
      `${label}: "oauth" must be an object`,
      'Pass e.g. oauth: { clientId: "…", scopes: ["repo"] }.',
    );
  }
  for (const key of Object.keys(raw)) {
    if (LATER_PHASE_OAUTH_KEYS.has(key)) {
      throw invalid(
        `${label}: oauth.${key} is not supported yet`,
        "Register an OAuth client with the server's authorization server (with the device flow enabled) and set oauth.clientId.",
      );
    }
    if (!OAUTH_KEYS.has(key)) {
      throw invalid(
        `${label}: "oauth" has an unknown setting ${quoted(key)}`,
        `oauth takes only ${[...OAUTH_KEYS].join(', ')}.`,
      );
    }
  }
  const clientId = raw['clientId'];
  if (typeof clientId !== 'string' || clientId.trim() === '') {
    throw invalid(
      `${label}: oauth.clientId must be a non-empty string`,
      "Set oauth.clientId to the client id of an OAuth app you registered with the server's authorization server (R52).",
    );
  }
  const resolved: {
    clientId: string;
    clientSecret?: string;
    scopes?: readonly string[];
    signInHosts?: readonly string[];
    tokenEndpoint?: string;
    deviceAuthorizationEndpoint?: string;
  } = { clientId };
  const secret = raw['clientSecret'];
  if (secret !== undefined) {
    // Never quoted: it is a secret.
    if (typeof secret !== 'string' || secret === '') {
      throw invalid(
        `${label}: oauth.clientSecret must be a non-empty string`,
        'Omit oauth.clientSecret unless the registration requires one; the device flow needs none.',
      );
    }
    resolved.clientSecret = secret;
  }
  if (raw['scopes'] !== undefined) {
    resolved.scopes = Object.freeze(
      parseStringList(
        raw['scopes'],
        'scopes',
        label,
        (scope) => SCOPE_TOKEN.test(scope),
        'Each scope is one OAuth scope token, without spaces, e.g. ["repo", "read:org"].',
      ),
    );
  }
  if (raw['signInHosts'] !== undefined) {
    resolved.signInHosts = Object.freeze(
      parseStringList(
        raw['signInHosts'],
        'signInHosts',
        label,
        isBareHostname,
        'Each entry is a bare lowercase hostname (punycode for internationalized names), with no scheme, port, path, wildcard or IP address, e.g. "accounts.example.com".',
      ),
    );
  }
  for (const setting of ['tokenEndpoint', 'deviceAuthorizationEndpoint'] as const) {
    if (raw[setting] !== undefined) {
      resolved[setting] = parseEndpoint(raw[setting], setting, label, sourceIsLoopback);
    }
  }
  return Object.freeze(resolved);
}

/**
 * Validate an {@link UpstreamSpec} (R51) and compute its canonical URL and
 * R60 identity. `label` names the source in messages (`source "github"`, or
 * `the source` on a single-server facade).
 */
export function resolveUpstreamSpec(value: unknown, label: string): ResolvedUpstream {
  if (!isUpstreamSpecShape(value)) {
    throw invalid(`${label} is not an UpstreamSpec`, 'Pass { url, oauth? }.');
  }
  for (const key of Object.keys(value)) {
    if (!SPEC_KEYS.has(key)) {
      throw invalid(
        `${label} has an unknown setting ${quoted(key)}`,
        'A source given by URL takes only url and oauth.',
      );
    }
  }
  const url = parseSourceUrl(value['url'], label);
  const canonicalUrl = canonicalizeUrl(url);
  const oauth =
    value['oauth'] !== undefined
      ? resolveOAuth(value['oauth'], label, isLoopbackHost(url.hostname))
      : undefined;
  return Object.freeze({
    url,
    canonicalUrl,
    identity: `url:${canonicalUrl}`,
    host: url.hostname,
    ...(oauth !== undefined ? { oauth } : {}),
  });
}
