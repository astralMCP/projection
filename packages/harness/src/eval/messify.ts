/**
 * `messify(world, profile)`: put a badly built MCP server in front of any
 * single-server world the harness has (the GitHub fake, a workplace box,
 * the billing catalog, a recording proxy over a real server). The result
 * is another `ServerWorld` whose `server` is an in-process proxy: it lists
 * a degraded surface (names, descriptions, schemas, annotations,
 * instructions) and forwards every call to the wrapped server over an
 * in-memory MCP connection, degrading the answer on the way back.
 *
 * The defects are the ones real servers ship (see the catalog in the
 * `summit-messy` write-up and in messy-tasks.ts): missing, one-word or
 * multi-KB descriptions, parameters with no descriptions, schemas with no
 * `type` or full of `anyOf`/`$ref`/`oneOf` (Pydantic output), arguments
 * silently dropped instead of refused, absent annotations, generic names
 * that collide across servers, inconsistent camelCase/snake_case, errors
 * sent as ordinary results, JSON as a bare text block, `structuredContent`
 * that drifted from its declared output schema, 100 KB results, the next
 * page mentioned only in prose, no or rambling `instructions`, and slow
 * tools. None is adversarial: the server is honest, merely badly built.
 *
 * What the tasks score is unchanged: the wrapped server still records its
 * own calls, under its own (canonical) names and arguments, after the
 * proxy has mapped the degraded call back. A call the wrapped server
 * refuses is not recorded, as everywhere else in the harness.
 *
 * Every transform is a pure function of the profile and the wrapped
 * surface, so the same profile gives the same surface every episode.
 */

import { Client } from '@modelcontextprotocol/client';
import {
  fromJsonSchema,
  InMemoryTransport,
  McpServer,
  type JsonSchemaType,
  type JsonSchemaValidator,
  type jsonSchemaValidator,
} from '@modelcontextprotocol/server';
import type { ServerWorld, WorldTool } from './world.js';

// ---------------------------------------------------------------------------
// Profiles

/** Wrapped (canonical) tool names a defect applies to; absent = every tool. */
type Only = { tools?: readonly string[] };

/**
 * One defect a profile applies. `tools` (where present) names the wrapped
 * server's tools it affects, by their canonical names; absent means all.
 */
export type Defect =
  /** `none`: an empty description; `one-word`: a noun ("Issues"); `verbose`: several KB of usage docs. */
  | ({ kind: 'descriptions'; style: 'none' | 'one-word' | 'verbose' } & Only)
  /** Every input property loses its `description` (and `title`). */
  | ({ kind: 'property-descriptions' } & Only)
  /**
   * `untyped`: input properties lose `type` (as servers typed `Any` emit);
   * `pydantic`: optional properties become `anyOf: [T, null]` with
   * `default: null` and a `title`, nested objects and enums move to
   * `$defs` behind `$ref`, enums become `oneOf` of `const`s.
   */
  | ({ kind: 'schema'; style: 'untyped' | 'pydantic' } & Only)
  /**
   * The input schema declares no `additionalProperties: false`, and an
   * argument the server does not know is dropped silently before the
   * call, instead of being refused.
   */
  | ({ kind: 'loose-args' } & Only)
  /** `none`: no annotations at all; `no-read-only`: every hint but `readOnlyHint` is kept. */
  | ({ kind: 'annotations'; style: 'none' | 'no-read-only' } & Only)
  /** Tool renames, canonical → served (generic names like `search`, `get`). */
  | { kind: 'rename'; names: Readonly<Record<string, string>> }
  /** Top-level argument names converted to camelCase or snake_case (on some tools only: inconsistency). */
  | ({ kind: 'arg-case'; style: 'camel' | 'snake' } & Only)
  /** An `isError` result is sent as an ordinary one, its text starting `Error:`. */
  | ({ kind: 'errors-as-text' } & Only)
  /**
   * `text-json`: no output schema, no `structuredContent`; the JSON as one
   * compact text block. `repr`: the same, as a Python `repr()` of the dict.
   */
  | ({ kind: 'results'; style: 'text-json' | 'repr' } & Only)
  /**
   * The declared output schema drifted from what the tool returns: its
   * property names are case-flipped (`updatedAt` declared `updated_at`)
   * and nothing is `required`, so validators pass and nothing matches.
   */
  | ({ kind: 'output-drift' } & Only)
  /** Results padded to at least `bytes` with the verbose fields real APIs inline. */
  | ({ kind: 'huge-results'; bytes: number } & Only)
  /** The next-page token leaves the JSON and is mentioned only in a trailing prose line. */
  | ({ kind: 'pagination-trailer' } & Only)
  /** `none`: no instructions; `rambling`: several KB of README prose with one useful line buried in it. */
  | { kind: 'instructions'; style: 'none' | 'rambling'; product?: string; tip?: string }
  /** Every call waits `ms` before it is answered. */
  | ({ kind: 'latency'; ms: number } & Only);

export interface MessyProfile {
  /** A short name for reports and the write-up. */
  name: string;
  defects: readonly Defect[];
}

function applies(defect: Only, tool: string): boolean {
  return defect.tools === undefined || defect.tools.includes(tool);
}

function defectsOf<K extends Defect['kind']>(
  profile: MessyProfile,
  kind: K,
  tool?: string,
): Extract<Defect, { kind: K }>[] {
  return profile.defects.filter(
    (d): d is Extract<Defect, { kind: K }> =>
      d.kind === kind && (tool === undefined || !('tools' in d) || applies(d as Only, tool)),
  );
}

// ---------------------------------------------------------------------------
// Names

export function toCamel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

export function toSnake(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}

function flipCase(name: string): string {
  return name.includes('_') ? toCamel(name) : /[a-z][A-Z]/.test(name) ? toSnake(name) : name;
}

function titleCase(name: string): string {
  return toSnake(name)
    .split(/[_\-\s]+/)
    .filter((w) => w !== '')
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(' ');
}

/** The one word a lazy description is: the last word of the name, capitalised ("Issues"). */
export function oneWord(name: string): string {
  const words = toSnake(name)
    .split(/[_\-\s]+/)
    .filter((w) => w !== '');
  const last = words.at(-1) ?? name;
  return last[0]?.toUpperCase() + last.slice(1);
}

type Schema = Record<string, unknown>;

function isSchema(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function propertiesOf(schema: Schema): Record<string, Schema> {
  const props = schema['properties'];
  return isSchema(props) ? (props as Record<string, Schema>) : {};
}

function requiredOf(schema: Schema): string[] {
  const req = schema['required'];
  return Array.isArray(req) ? req.filter((r): r is string => typeof r === 'string') : [];
}

// ---------------------------------------------------------------------------
// Schema transforms (pure; exported for the tests)

/** Rename top-level properties (and `required`) by `map` (old → new). */
export function renameProperties(schema: Schema, map: ReadonlyMap<string, string>): Schema {
  if (map.size === 0) return schema;
  const props = Object.fromEntries(
    Object.entries(propertiesOf(schema)).map(([k, v]) => [map.get(k) ?? k, v]),
  );
  return {
    ...schema,
    properties: props,
    ...(schema['required'] !== undefined
      ? { required: requiredOf(schema).map((r) => map.get(r) ?? r) }
      : {}),
  };
}

/** Drop `description` and `title` from every property, recursively. */
export function stripPropertyDescriptions(schema: Schema): Schema {
  const strip = (s: unknown): unknown => {
    if (Array.isArray(s)) return s.map(strip);
    if (!isSchema(s)) return s;
    const out: Schema = {};
    for (const [k, v] of Object.entries(s)) {
      if (k === 'description' || k === 'title') continue;
      if (k === 'properties' && isSchema(v)) {
        out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, strip(pv)]));
      } else if (k === 'items' || k === 'anyOf' || k === 'oneOf' || k === 'allOf') {
        out[k] = strip(v);
      } else out[k] = v;
    }
    return out;
  };
  const props = Object.fromEntries(
    Object.entries(propertiesOf(schema)).map(([k, v]) => [k, strip(v)]),
  );
  return { ...schema, properties: props };
}

/** Remove `type` from every top-level property (the top level keeps `type: object`). */
export function untypeProperties(schema: Schema): Schema {
  const props = Object.fromEntries(
    Object.entries(propertiesOf(schema)).map(([k, v]) => {
      const { type: _type, ...rest } = v;
      return [k, rest];
    }),
  );
  return { ...schema, properties: props };
}

/**
 * The schema a Pydantic model would emit for the same arguments: a
 * `title` everywhere, every optional property `anyOf: [T, {type: null}]`
 * with `default: null`, nested object and enum schemas hoisted into
 * `$defs` and referenced with `$ref`, enums as `oneOf` of `const`s.
 */
export function pydanticSchema(schema: Schema, toolName: string): Schema {
  const defs: Record<string, Schema> = {};
  const required = new Set(requiredOf(schema));
  const hoist = (prop: string, s: Schema): Schema => {
    const { description, ...body } = s;
    const desc = typeof description === 'string' ? { description } : {};
    if (Array.isArray(body['enum'])) {
      const name = titleCase(prop).replace(/ /g, '');
      defs[name] = {
        title: name,
        oneOf: (body['enum'] as unknown[]).map((v) => ({ const: v, title: String(v) })),
      };
      return { $ref: `#/$defs/${name}`, ...desc };
    }
    if (body['type'] === 'object' && isSchema(body['properties'])) {
      const name = titleCase(prop).replace(/ /g, '');
      defs[name] = { title: name, ...body };
      return { $ref: `#/$defs/${name}`, ...desc };
    }
    if (body['type'] === 'array' && isSchema(body['items'])) {
      const items = body['items'];
      if (items['type'] === 'object' && isSchema(items['properties'])) {
        const name = `${titleCase(prop).replace(/ /g, '')}Item`;
        defs[name] = { title: name, ...items };
        return { ...body, items: { $ref: `#/$defs/${name}` }, ...desc };
      }
    }
    return s;
  };
  const props: Record<string, Schema> = {};
  for (const [k, v] of Object.entries(propertiesOf(schema))) {
    const title = titleCase(k);
    const hoisted = hoist(k, v);
    if (required.has(k)) {
      props[k] = { ...hoisted, title };
    } else {
      const { description, ...inner } = hoisted;
      props[k] = {
        anyOf: [inner, { type: 'null' }],
        default: null,
        ...(typeof description === 'string' ? { description } : {}),
        title,
      };
    }
  }
  const { additionalProperties: _ap, ...rest } = schema;
  return {
    ...rest,
    properties: props,
    title: `${titleCase(toolName).replace(/ /g, '')}Arguments`,
    ...(Object.keys(defs).length > 0 ? { $defs: defs } : {}),
  };
}

/** The output schema after drift: every property name case-flipped, nothing required. */
export function driftOutputSchema(schema: Schema): Schema {
  const drift = (s: unknown): unknown => {
    if (Array.isArray(s)) return s.map(drift);
    if (!isSchema(s)) return s;
    const out: Schema = {};
    for (const [k, v] of Object.entries(s)) {
      if (k === 'required') continue;
      if (k === 'properties' && isSchema(v)) {
        out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [flipCase(pk), drift(pv)]));
      } else if (k === 'items' || k === 'anyOf' || k === 'oneOf' || k === 'allOf') {
        out[k] = drift(v);
      } else out[k] = v;
    }
    return out;
  };
  return drift(schema) as Schema;
}

// ---------------------------------------------------------------------------
// Prose

/** Several KB of usage docs for one tool, the way some servers inline their README. */
export function verboseDescription(tool: WorldTool, served: string, schema: Schema): string {
  const props = propertiesOf(schema);
  const required = new Set(requiredOf(schema));
  const base = tool.description.trim() === '' ? titleCase(served) : tool.description.trim();
  const param = (name: string, s: Schema): string => {
    const type = typeof s['type'] === 'string' ? s['type'] : 'value';
    const desc = typeof s['description'] === 'string' ? s['description'] : 'See below.';
    return [
      `### \`${name}\` (${type}${required.has(name) ? ', required' : ', optional'})`,
      '',
      desc,
      '',
      `Passing \`${name}\` with the wrong type returns a validation error before any work is done. ` +
        `Leading and trailing whitespace is preserved exactly as sent, so trim values on the client side. ` +
        `Older clients sometimes sent \`${name}\` under a different casing; that is no longer accepted in v2 and ` +
        `the field may be ignored. When in doubt, consult the examples section further below, which shows ` +
        `typical values of \`${name}\` together with the other fields a realistic request carries.`,
      '',
    ].join('\n');
  };
  const example = (i: number): string => {
    const args = Object.fromEntries(
      Object.entries(props).map(([k, s]) => [
        k,
        s['type'] === 'number' || s['type'] === 'integer'
          ? 10 * (i + 1)
          : s['type'] === 'array'
            ? [`example-${i}`]
            : s['type'] === 'boolean'
              ? i % 2 === 0
              : `example-${k}-${i}`,
      ]),
    );
    return ['```json', JSON.stringify(args, null, 2), '```'].join('\n');
  };
  return [
    base,
    '',
    '## Overview',
    '',
    `\`${served}\` is part of the v2 tool set. ${base} This tool is designed for interactive use by assistants ` +
      'and for scripted automation alike. It honours the workspace permissions of the authenticated account, so ' +
      'results can differ between users. Responses are eventually consistent: a change made a moment ago may ' +
      'take a few seconds to appear. All timestamps are UTC unless a field says otherwise.',
    '',
    '## When to use it',
    '',
    `Use \`${served}\` when the user asks for exactly what it does. Do not use it to poll for changes; ` +
      'subscribe to webhooks instead (not available over MCP yet). Avoid calling it in tight loops: the ' +
      'workspace rate limit is shared across every integration, and exceeding it causes temporary throttling ' +
      'for everyone on the team, not just this assistant.',
    '',
    '## Parameters',
    '',
    ...Object.entries(props).map(([k, s]) => param(k, s)),
    '## Returns',
    '',
    'A JSON document. Fields that are empty may be omitted entirely rather than returned as null; clients ' +
      'should treat a missing field and a null field the same way. Additional fields may be added at any time ' +
      'without notice and must be ignored by clients that do not understand them.',
    '',
    '## Examples',
    '',
    example(0),
    '',
    example(1),
    '',
    example(2),
    '',
    '## Errors',
    '',
    '- `invalid_auth`, `not_authed`: the token is missing or expired; reconnect the integration.',
    '- `ratelimited`: wait for the number of seconds in the `Retry-After` header and retry.',
    '- `internal_error`: transient; retry with exponential backoff, at most three times.',
    '- Any other error is returned as a short message describing what went wrong.',
    '',
    '## Changelog',
    '',
    '- v2.3: response fields are no longer sorted alphabetically.',
    '- v2.1: added optional parameters; behaviour without them is unchanged.',
    '- v2.0: renamed several parameters for consistency. Old names are deprecated.',
    '- v1.4: initial MCP release.',
  ].join('\n');
}

/** Several KB of README prose, with the one useful `tip` buried in the middle. */
export function ramblingInstructions(
  product: string,
  tools: readonly string[],
  tip: string | undefined,
): string {
  return [
    `# Welcome to the ${product} MCP server!`,
    '',
    `Thank you for installing the ${product} MCP server. This server connects your AI assistant to ${product} ` +
      'so that it can help you get more done, faster. We built it because our customers kept asking for a way ' +
      'to bring their workspace into the tools they already use every day, and we are excited to see what you ' +
      'will build with it. If you have feedback, we would love to hear it: open an issue on our tracker or join ' +
      'the community forum, where the team answers questions every weekday.',
    '',
    '## Features',
    '',
    `- ${tools.length} tools covering the most common workflows`,
    '- Works with every MCP-compatible client',
    '- Respects the permissions of the connected account',
    '- Enterprise-ready: SSO, audit logging and data residency on the Enterprise plan',
    '- Lightning fast: responses are cached where it is safe to do so',
    '',
    '## Getting started',
    '',
    'Install the server, connect your account with the OAuth flow, and restart your client. The first request ' +
      'may take a few seconds while the workspace metadata is warmed up. If the assistant reports that a tool is ' +
      'missing, make sure the integration has the required scopes; the admin console lists them under ' +
      'Settings › Integrations › Scopes. Scopes added later require reconnecting the integration.',
    '',
    '## Tips for assistants',
    '',
    'Be concise when summarising results for the user, and prefer showing names over raw IDs where possible. ' +
      'Respect the user’s time zone when presenting dates. Avoid repeating the same request many times; if a ' +
      `request fails, explain what happened. ${tip ?? ''} When a user asks for something the tools cannot do, ` +
      'say so plainly rather than guessing. Remember that some data may be confidential.',
    '',
    '## Rate limits',
    '',
    'Each workspace may make up to 50 requests per minute across all integrations. Bursts above the limit are ' +
      'throttled for 60 seconds. Enterprise workspaces may request higher limits from their account manager.',
    '',
    '## Privacy',
    '',
    'We never use your data to train models. Requests are logged for 30 days for abuse prevention and then ' +
      'deleted. See our privacy policy for details, including the list of sub-processors and their locations.',
    '',
    '## Changelog',
    '',
    '- 1.4: performance improvements and bug fixes.',
    '- 1.3: new tools; several parameters renamed for consistency.',
    '- 1.2: improved error messages.',
    '- 1.1: support for more clients.',
    '- 1.0: initial release.',
    '',
    '## Troubleshooting',
    '',
    'If something is not working, first try disconnecting and reconnecting the integration. Then check the ' +
      'status page. If the problem persists, contact support with the request ID from the error message, the ' +
      'name of your client, and the approximate time the problem occurred.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Result transforms (pure; exported for the tests)

/** A Python `repr()` of a JSON value, as servers that `return str(result)` send it. */
export function pythonRepr(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    return value.includes("'") && !value.includes('"')
      ? `"${value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}"`
      : `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
  }
  if (Array.isArray(value)) return `[${value.map(pythonRepr).join(', ')}]`;
  return `{${Object.entries(value as Schema)
    .map(([k, v]) => `${pythonRepr(k)}: ${pythonRepr(v)}`)
    .join(', ')}}`;
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/**
 * The verbose fields a real API inlines on every item (avatars at six
 * sizes, rich-text blocks repeating the text, links, raw headers):
 * deterministic for `seed`, about `bytes` long once serialised.
 */
export function verboseFields(seed: string, bytes: number): Schema {
  const h = hash(seed).toString(16).padStart(8, '0');
  const avatar = (size: number): string =>
    `https://avatars.example-cdn.net/${h}/${size}x${size}.png?v=${h.slice(0, 4)}&fit=crop`;
  const out: Schema = {
    client_msg_id: `${h}-${h.slice(0, 4)}-4${h.slice(1, 4)}-a${h.slice(2, 5)}-${h}${h.slice(0, 4)}`,
    user_profile: Object.fromEntries(
      [24, 32, 48, 72, 192, 512, 1024].map((s) => [`image_${s}`, avatar(s)]),
    ),
    _links: {
      self: { href: `https://api.example.net/v2/items/${h}` },
      permalink: { href: `https://app.example.net/archives/${h}` },
    },
  };
  const blocks: Schema[] = [];
  let i = 0;
  while (JSON.stringify(out).length + JSON.stringify(blocks).length < bytes) {
    blocks.push({
      type: 'rich_text',
      block_id: `${h.slice(i % 6, (i % 6) + 3)}${i}`,
      elements: [
        {
          type: 'rich_text_section',
          elements: [
            { type: 'text', text: `${seed} `, style: { bold: false, italic: false, code: false } },
            { type: 'link', url: `https://app.example.net/r/${h}/${i}`, text: 'details' },
          ],
        },
      ],
    });
    i += 1;
  }
  out['blocks'] = blocks;
  return out;
}

/**
 * Pad a JSON result to at least `bytes`: every object in the first array
 * found (breadth-first) gains verbose fields; a result with no array gains
 * them at the top level.
 */
export function inflate(value: unknown, bytes: number): unknown {
  const size = JSON.stringify(value).length;
  if (size >= bytes) return value;
  const queue: unknown[] = [value];
  while (queue.length > 0) {
    const v = queue.shift();
    if (Array.isArray(v)) {
      const objects = v.filter(isSchema);
      if (objects.length > 0) {
        const per = Math.ceil((bytes - size) / objects.length) + 64;
        objects.forEach((o, i) => {
          Object.assign(o, verboseFields(`${JSON.stringify(o).slice(0, 80)}#${i}`, per));
        });
        return value;
      }
    } else if (isSchema(v)) queue.push(...Object.values(v));
  }
  if (isSchema(value)) {
    return { ...value, _debug: verboseFields(JSON.stringify(value).slice(0, 80), bytes - size) };
  }
  return value;
}

/**
 * Take the next-page token out of a JSON result: `pageInfo` (`endCursor`,
 * `hasNextPage`), `response_metadata.next_cursor`, `has_more`,
 * `next_cursor`, `nextPageToken`. Returns the slimmed value and the token
 * (empty when there is no next page).
 */
export function extractNextPage(value: unknown): { value: unknown; token: string | undefined } {
  if (!isSchema(value)) return { value, token: undefined };
  const out: Schema = { ...value };
  let token: string | undefined;
  let found = false;
  const pageInfo = out['pageInfo'];
  if (isSchema(pageInfo)) {
    found = true;
    if (pageInfo['hasNextPage'] === true && typeof pageInfo['endCursor'] === 'string') {
      token = pageInfo['endCursor'];
    }
    delete out['pageInfo'];
  }
  const meta = out['response_metadata'];
  if (isSchema(meta) && 'next_cursor' in meta) {
    found = true;
    if (typeof meta['next_cursor'] === 'string' && meta['next_cursor'] !== '') {
      token = meta['next_cursor'];
    }
    delete out['response_metadata'];
  }
  for (const key of ['next_cursor', 'nextPageToken', 'nextCursor']) {
    if (key in out) {
      found = true;
      if (typeof out[key] === 'string' && out[key] !== '') token = out[key] as string;
      delete out[key];
    }
  }
  if ('has_more' in out) {
    found = true;
    delete out['has_more'];
  }
  return { value: out, token: found ? (token ?? '') : undefined };
}

/** Replace whole-word occurrences of each `from` name with its `to`. */
export function renameInText(text: string, map: ReadonlyMap<string, string>): string {
  let out = text;
  for (const [from, to] of map) {
    if (from === to) continue;
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'g'), to);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Surface

/** One tool as the messy server serves it, and how to map a call back. */
export interface MessyTool {
  /** The wrapped server's name for it. */
  canonical: string;
  /** What the messy server lists. */
  served: WorldTool;
  /** Served argument name → canonical argument name (only the renamed ones). */
  argsBack: ReadonlyMap<string, string>;
  /** The canonical input properties (for `loose-args`). */
  canonicalProps: ReadonlySet<string>;
}

/** The degraded surface of `tools` under `profile`. */
export function messySurface(tools: readonly WorldTool[], profile: MessyProfile): MessyTool[] {
  const renames = new Map<string, string>();
  for (const d of defectsOf(profile, 'rename')) {
    for (const [from, to] of Object.entries(d.names)) renames.set(from, to);
  }
  // Prose that names other tools follows their renames.
  const toolNames = new Map(renames);
  return tools.map((tool) => {
    const canonical = tool.name;
    const served = renames.get(canonical) ?? canonical;
    let schema: Schema = tool.inputSchema;
    const argMap = new Map<string, string>();
    for (const d of defectsOf(profile, 'arg-case', canonical)) {
      for (const k of Object.keys(propertiesOf(schema))) {
        const next = d.style === 'camel' ? toCamel(k) : toSnake(k);
        if (next !== k) argMap.set(k, next);
      }
    }
    schema = renameProperties(schema, argMap);
    if (defectsOf(profile, 'property-descriptions', canonical).length > 0) {
      schema = stripPropertyDescriptions(schema);
    }
    for (const d of defectsOf(profile, 'schema', canonical)) {
      schema = d.style === 'untyped' ? untypeProperties(schema) : pydanticSchema(schema, served);
    }
    if (defectsOf(profile, 'loose-args', canonical).length > 0) {
      const { additionalProperties: _ap, ...rest } = schema;
      schema = rest;
    }
    const prose = new Map([...toolNames, ...argMap]);
    let description = renameInText(tool.description, prose);
    for (const d of defectsOf(profile, 'descriptions', canonical)) {
      description =
        d.style === 'none'
          ? ''
          : d.style === 'one-word'
            ? oneWord(canonical)
            : verboseDescription({ ...tool, description }, served, schema);
    }
    let annotations = tool.annotations;
    for (const d of defectsOf(profile, 'annotations', canonical)) {
      if (d.style === 'none') annotations = undefined;
      else if (annotations !== undefined) {
        const { readOnlyHint: _ro, ...rest } = annotations;
        annotations = rest;
      }
    }
    let outputSchema = tool.outputSchema;
    if (defectsOf(profile, 'results', canonical).length > 0) outputSchema = undefined;
    if (outputSchema !== undefined && defectsOf(profile, 'output-drift', canonical).length > 0) {
      outputSchema = driftOutputSchema(outputSchema);
    }
    const servedTool: WorldTool = {
      name: served,
      ...(tool.title !== undefined && annotations !== undefined ? { title: tool.title } : {}),
      description,
      inputSchema: schema,
      ...(outputSchema !== undefined ? { outputSchema } : {}),
      ...(annotations !== undefined && Object.keys(annotations).length > 0 ? { annotations } : {}),
    };
    return {
      canonical,
      served: servedTool,
      argsBack: new Map([...argMap].map(([k, v]) => [v, k])),
      canonicalProps: new Set(Object.keys(propertiesOf(tool.inputSchema))),
    };
  });
}

/**
 * The served arguments mapped back to the wrapped tool's, or the error a
 * strict server answers an unknown argument with. A `loose-args` server
 * drops what it does not know instead, silently — including an argument
 * sent under the other casing — and a Pydantic one reads an explicit
 * `null` as "not given".
 */
export function argsToCanonical(
  tool: MessyTool,
  args: Record<string, unknown>,
  profile: MessyProfile,
): { args: Record<string, unknown> } | { error: string } {
  const pydantic = defectsOf(profile, 'schema', tool.canonical).some((d) => d.style === 'pydantic');
  const loose = defectsOf(profile, 'loose-args', tool.canonical).length > 0;
  const served = new Set(Object.keys(propertiesOf(tool.served.inputSchema)));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (pydantic && v === null) continue;
    if (!served.has(k)) {
      if (loose) continue;
      return {
        error: `Input validation error: Invalid arguments for tool ${tool.served.name}: Unrecognized key: "${k}"`,
      };
    }
    out[tool.argsBack.get(k) ?? k] = v;
  }
  return { args: out };
}

interface CallResult {
  content: { type: string; text?: string; [k: string]: unknown }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The wrapped server's answer as the messy server sends it. */
export function messyResult(
  tool: MessyTool,
  result: CallResult,
  profile: MessyProfile,
  prose: ReadonlyMap<string, string>,
): CallResult {
  const name = tool.canonical;
  const texts = result.content.map((b) =>
    b.type === 'text' && typeof b.text === 'string' ? b.text : undefined,
  );
  const joined = texts.filter((t): t is string => t !== undefined).join('\n');
  if (result.isError === true) {
    const message = renameInText(joined, prose);
    if (defectsOf(profile, 'errors-as-text', name).length > 0) {
      const text = /^error\b/i.test(message) ? message : `Error: ${message}`;
      // A tool that declares an output schema still sends a structured
      // body (its error object), or the SDK would refuse the result.
      const parsed = parseJson(message);
      return {
        content: [{ type: 'text', text }],
        ...(tool.served.outputSchema !== undefined
          ? { structuredContent: isSchema(parsed) ? parsed : { error: message } }
          : {}),
      };
    }
    return { content: [{ type: 'text', text: message }], isError: true };
  }
  let value: unknown = result.structuredContent ?? parseJson(joined);
  const huge = defectsOf(profile, 'huge-results', name);
  for (const d of huge) {
    if (value !== undefined) value = inflate(structuredClone(value), d.bytes);
  }
  const results = defectsOf(profile, 'results', name)[0];
  // structuredContent mirrors the (padded) payload; only the text changes below.
  const structured =
    results === undefined && result.structuredContent !== undefined && isSchema(value)
      ? value
      : undefined;
  let trailer = '';
  if (value !== undefined && defectsOf(profile, 'pagination-trailer', name).length > 0) {
    const { value: slim, token } = extractNextPage(value);
    if (token !== undefined) {
      value = slim;
      trailer = token === '' ? '' : `\n\nThere are more results. Next page token: ${token}`;
    }
  }
  if (value === undefined) {
    // Plain text: only padding can apply.
    const pad = huge[0];
    const text =
      pad !== undefined && joined.length < pad.bytes
        ? `${joined}\n\n--- raw ---\n${JSON.stringify(verboseFields(joined.slice(0, 80), pad.bytes - joined.length))}`
        : joined;
    return { content: [{ type: 'text', text }] };
  }
  const body =
    results?.style === 'repr'
      ? pythonRepr(value)
      : results?.style === 'text-json' || huge.length > 0
        ? // A server that passes a raw API payload through dumps it compact.
          JSON.stringify(value)
        : JSON.stringify(value, null, 2);
  return {
    content: [{ type: 'text', text: `${body}${trailer}` }],
    ...(structured !== undefined ? { structuredContent: structured } : {}),
  };
}

/** Accepts anything: the messy server validates nothing itself; the wrapped one does. */
const PERMISSIVE: jsonSchemaValidator = {
  getValidator<T>(): JsonSchemaValidator<T> {
    return (input: unknown) => ({ valid: true, data: input as T, errorMessage: undefined });
  },
};

/** The instructions the messy server advertises. */
export function messyInstructions(
  original: string | undefined,
  surface: readonly MessyTool[],
  profile: MessyProfile,
): string | undefined {
  const d = defectsOf(profile, 'instructions')[0];
  if (d === undefined) return original;
  if (d.style === 'none') return undefined;
  return ramblingInstructions(
    d.product ?? 'Workspace',
    surface.map((t) => t.served.name),
    d.tip,
  );
}

/**
 * The messy server in front of `world`: a new `ServerWorld` whose server
 * lists the degraded surface and forwards to `world.server`. `calls` stays
 * the wrapped world's (canonical names and arguments); closing it closes
 * the connection and the wrapped world.
 */
export async function messify(world: ServerWorld, profile: MessyProfile): Promise<ServerWorld> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'messify', version: '0.0.0' }, { capabilities: {} });
  await world.server.connect(serverTransport);
  await client.connect(clientTransport);

  const surface = messySurface(world.tools, profile);
  const instructions = messyInstructions(world.instructions, surface, profile);
  const server = new McpServer(
    { name: `${String(world.name)}-mcp`, version: '0.9.1' },
    ...(instructions !== undefined ? [{ instructions }] : []),
  );
  const prose = new Map<string, string>();
  for (const t of surface) {
    if (t.served.name !== t.canonical) prose.set(t.canonical, t.served.name);
  }
  for (const tool of surface) {
    const toolProse = new Map([...prose, ...[...tool.argsBack].map(([s, c]) => [c, s] as const)]);
    const latency = defectsOf(profile, 'latency', tool.canonical).reduce((n, d) => n + d.ms, 0);
    server.registerTool(
      tool.served.name,
      {
        ...(tool.served.title !== undefined ? { title: tool.served.title } : {}),
        description: tool.served.description,
        inputSchema: fromJsonSchema<Record<string, unknown>>(
          tool.served.inputSchema as JsonSchemaType,
          PERMISSIVE,
        ),
        ...(tool.served.outputSchema !== undefined
          ? {
              outputSchema: fromJsonSchema<Record<string, unknown>>(
                tool.served.outputSchema as JsonSchemaType,
                PERMISSIVE,
              ),
            }
          : {}),
        ...(tool.served.annotations !== undefined ? { annotations: tool.served.annotations } : {}),
      },
      async (args) => {
        if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));
        const forwarded = argsToCanonical(tool, args ?? {}, profile);
        if ('error' in forwarded) {
          return { content: [{ type: 'text' as const, text: forwarded.error }], isError: true };
        }
        const result = (await client.callTool({
          name: tool.canonical,
          arguments: forwarded.args,
        })) as CallResult;
        const out = messyResult(
          tool,
          {
            content: Array.isArray(result.content) ? result.content : [],
            ...(result.structuredContent !== undefined
              ? { structuredContent: result.structuredContent }
              : {}),
            ...(result.isError === true ? { isError: true } : {}),
          },
          profile,
          toolProse,
        );
        return out as never;
      },
    );
  }
  return {
    name: world.name,
    server,
    tools: surface.map((t) => t.served),
    instructions,
    calls: world.calls,
    facts: world.facts,
    hostSystemPrompt: world.hostSystemPrompt,
    close: async () => {
      await client.close().catch(() => {});
      await world.close();
    },
  };
}
