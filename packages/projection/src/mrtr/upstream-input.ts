/**
 * Forwarding a wrapped server's own questions to the human (G1, DECISIONS
 * D23; S5, S6).
 *
 * A wrapped tool that runs (read-only, or already approved) may answer
 * `input_required` with its own elicitation: a form, or a link to open
 * (URL mode). On a box that forwards upstream elicitation, Projection asks
 * the human in its own `input_required` and, on the retry, re-issues the
 * SAME recorded call with the human's answers and the server's own
 * `requestState`, both carried inside Projection's sealed blob.
 *
 * Everything the server sent is third-party text (S5). The prompt is built
 * so it can never pass for one of Projection's approvals (S6):
 *
 * - its first line names the box and says it is not an approval
 *   (`Question from fs (not an approval)`), never `Approve`;
 * - the server's message is neutralized, capped, and quoted line by line
 *   under an attribution line, so a forged `Approve:` heading reads as the
 *   server's quoted words, never as a heading;
 * - the requested schema passes an allowlist of the MCP elicitation
 *   primitives (no nested objects, no vendor keys, no comments, examples or
 *   patterns), with every string neutralized and capped;
 * - a link is shown with its origin on its own line and must be `https:`
 *   (`http:` only on a loopback host) without credentials.
 *
 * Sampling and roots are never forwarded (Q2): a request that asks for them
 * fails the call, as does one with more questions than a prompt should hold.
 *
 * The questions keyed on the wire are Projection's own keys
 * (`upstream-1`, …): a server's keys never reach the client, and the answers
 * are mapped back through the sealed hold.
 */

import { ProjectionError } from '../errors.js';
import { capLength, neutralizeControlChars, stripInvisible } from '../text-safety.js';
import {
  isRecord,
  type ElicitationSchema,
  type ForwardedQuestion,
  type PendingToolCall,
  type UpstreamHold,
  type UpstreamInputRequest,
} from '../types.js';
import {
  inputRequired,
  inputResponse,
  type InputRequest,
  type InputRequests,
  type RetryEnvelope,
} from './protocol.js';

/** Prefix of the facade's own keys for forwarded questions. */
export const UPSTREAM_KEY_PREFIX = 'upstream-';
/** Most questions one forwarded round may carry. */
export const MAX_FORWARDED_QUESTIONS = 4;
/** Longest server `requestState` Projection will carry (it rides inside the sealed blob, R23). */
export const MAX_UPSTREAM_STATE_CHARS = 16 * 1024;

const MAX_MESSAGE_CHARS = 1_000;
const MAX_MESSAGE_LINES = 16;
/** Longest quoted line; longer lines are hard-wrapped. */
const MAX_LINE_CHARS = 100;
const MAX_FIELDS = 12;
const MAX_TITLE_CHARS = 100;
const MAX_DESCRIPTION_CHARS = 300;
const MAX_ENUM_VALUES = 50;
const MAX_ENUM_CHARS = 200;
const MAX_DEFAULT_CHARS = 500;
const MAX_ANSWER_CHARS = 10_000;
const MAX_URL_CHARS = 2_048;
const MAX_TOOL_CHARS = 200;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const STRING_FORMATS: ReadonlySet<string> = new Set(['email', 'uri', 'date', 'date-time']);
const LOOPBACK: ReadonlySet<string> = new Set(['127.0.0.1', '[::1]', 'localhost']);
/** The line prefix that marks a quoted line of the server's own words. */
const QUOTE = '│ ';

/** Who is asking, for the copy: the box alias on a multi-server facade. */
export interface QuestionContext {
  /** The host alias of the box (multi-server); absent on a single-server facade. */
  box?: string;
  /** The tool id the copy names: qualified on a multi-server facade. */
  tool: string;
  /** Whether the connected client declared URL-mode elicitation. */
  clientUrl: boolean;
}

/** The forwarded round: the hold to seal and the requests to send. */
export interface ForwardedRound {
  hold: UpstreamHold;
  inputRequests: InputRequests;
}

/**
 * Turn a server's `input_required` into Projection's own requests and the
 * hold to seal. `keys.first` numbers the facade keys (a machine suspension
 * may forward several held calls in one round), skipping `keys.taken`. Throws a `ProjectionError`
 * (phase `upstream`) when the request cannot be forwarded.
 */
export function forwardQuestions(
  call: PendingToolCall,
  decision: 'auto' | 'approved',
  input: UpstreamInputRequest,
  context: QuestionContext,
  keys: { first?: number; taken?: ReadonlySet<string> } = {},
): ForwardedRound {
  assertForwardable(input, context);
  const questions: Record<string, ForwardedQuestion> = {};
  const inputRequests: InputRequests = {};
  let index = keys.first ?? 1;
  for (const [key, request] of Object.entries(input.requests)) {
    // A machine's call ids are model-chosen and key its approvals: never
    // reuse one of them.
    while (keys.taken?.has(`${UPSTREAM_KEY_PREFIX}${index}`) === true) index += 1;
    const facadeKey = `${UPSTREAM_KEY_PREFIX}${index}`;
    index += 1;
    const built = forwardOne(request as Record<string, unknown>, context);
    questions[facadeKey] = { key, ...built.question };
    inputRequests[facadeKey] = built.request;
  }
  const hold: UpstreamHold = { ...call, decision, questions };
  if (input.requestState !== undefined) hold.requestState = input.requestState;
  return { hold, inputRequests };
}

/**
 * Throw the `upstream`-phase refusal when `input` cannot be forwarded: no
 * question, more than {@link MAX_FORWARDED_QUESTIONS}, an oversized server
 * state, sampling or roots, a request that is not an elicitation, or a
 * link that is not a plain `https:` address. Checked when a call is held,
 * so a machine gets its `TOOL_ERROR` at once (R64.1, R64.8).
 */
export function assertForwardable(input: UpstreamInputRequest, context: QuestionContext): void {
  const entries = Object.values(input.requests);
  if (entries.length === 0) throw notForwardable(context, 'it sent no question');
  if (entries.length > MAX_FORWARDED_QUESTIONS) {
    throw notForwardable(
      context,
      `it asked ${entries.length} questions at once, over the limit of ${MAX_FORWARDED_QUESTIONS}`,
    );
  }
  if (input.requestState !== undefined && input.requestState.length > MAX_UPSTREAM_STATE_CHARS) {
    throw notForwardable(context, 'its request state is too large to carry');
  }
  for (const request of entries) {
    if (!isRecord(request) || request['method'] !== 'elicitation/create') {
      const method =
        isRecord(request) && typeof request['method'] === 'string' ? request['method'] : '';
      if (method === 'sampling/createMessage') {
        throw notForwardable(context, 'it asked for a model completion (sampling)', true);
      }
      if (method === 'roots/list') {
        throw notForwardable(context, "it asked for the client's roots", true);
      }
      throw notForwardable(context, 'it sent a request that is not a question');
    }
    const params = isRecord(request['params']) ? request['params'] : {};
    if (params['mode'] === 'url' && safeLink(params['url']) === undefined) {
      throw notForwardable(
        context,
        'it asked the user to open a link that is not a plain https: address',
      );
    }
  }
}

/** The server's answers for a held call, from the retry's `inputResponses`. */
export function answersFor(
  hold: UpstreamHold,
  inputResponses: RetryEnvelope['inputResponses'],
): Record<string, unknown> {
  const responses: Record<string, unknown> = {};
  // The server's keys are its own strings (`__proto__` included): always
  // own data properties, never a prototype assignment.
  const answer = (key: string, value: unknown): void => {
    Object.defineProperty(responses, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  };
  for (const [facadeKey, question] of Object.entries(hold.questions)) {
    const view = inputResponse(inputResponses, facadeKey);
    // A missing answer, or an answer of another kind, means the human did
    // not answer: the server is told the question was cancelled.
    if (view.kind !== 'elicit') {
      answer(question.key, { action: 'cancel' });
      continue;
    }
    if (view.action !== 'accept') {
      answer(question.key, { action: view.action === 'decline' ? 'decline' : 'cancel' });
      continue;
    }
    answer(
      question.key,
      question.mode === 'form' && question.schema !== undefined
        ? { action: 'accept', content: checkedAnswer(question.schema, view.content) }
        : { action: 'accept' },
    );
  }
  return responses;
}

// ---------------------------------------------------------------------------
// One request
// ---------------------------------------------------------------------------

/** One request that {@link assertForwardable} accepted. */
function forwardOne(
  request: Record<string, unknown>,
  context: QuestionContext,
): { question: Omit<ForwardedQuestion, 'key'>; request: InputRequest } {
  const params = isRecord(request['params']) ? request['params'] : {};
  const message = typeof params['message'] === 'string' ? params['message'] : '';
  const link = params['mode'] === 'url' ? safeLink(params['url']) : undefined;
  if (link !== undefined) {
    const copy = linkCopy(context, message, link);
    if (context.clientUrl) {
      return {
        question: { mode: 'url' },
        request: inputRequired.elicitUrl({ message: copy, url: link.href }),
      };
    }
    // A client without URL mode gets the link as inert text in a form.
    return {
      question: { mode: 'url' },
      request: inputRequired.elicit({
        message: `${copy}\n\nLink: ${link.href}`,
        requestedSchema: LINK_FORM_SCHEMA as never,
      }),
    };
  }
  const schema = sanitizeElicitationSchema(params['requestedSchema']);
  return {
    question: { mode: 'form', schema },
    request: inputRequired.elicit({
      message: formCopy(context, message),
      requestedSchema: schema as never,
    }),
  };
}

const LINK_FORM_SCHEMA: ElicitationSchema = {
  type: 'object',
  properties: {
    done: { type: 'boolean', title: "I've opened the link and finished there" },
  },
};

/** A `https:` link without credentials (`http:` only on a loopback host). */
function safeLink(raw: unknown): URL | undefined {
  if (typeof raw !== 'string' || raw.length > MAX_URL_CHARS) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.username !== '' || url.password !== '') return undefined;
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && LOOPBACK.has(url.hostname)) return url;
  return undefined;
}

// ---------------------------------------------------------------------------
// Copy (S6)
// ---------------------------------------------------------------------------

function who(context: QuestionContext): string {
  return context.box ?? 'the server';
}

function toolLabel(context: QuestionContext): string {
  return JSON.stringify(neutralizeControlChars(capLength(context.tool, MAX_TOOL_CHARS)));
}

/**
 * The server's message as quoted data: invisible characters stripped,
 * control and bidi characters neutralized, capped, every line prefixed so
 * no line of it can stand as a heading of the prompt.
 */
export function quoteServerText(message: string): string {
  const cleaned = neutralizeControlChars(stripInvisible(message).replace(/\r\n?/g, '\n'), {
    allowNewline: true,
  });
  const capped = capLength(cleaned.trim(), MAX_MESSAGE_CHARS);
  // Hard-wrap long lines, each piece prefixed: a client that soft-wraps a
  // long line would otherwise show its tail as an unprefixed line.
  let lines = capped
    .split('\n')
    .flatMap((line) =>
      line.length <= MAX_LINE_CHARS
        ? [line]
        : Array.from({ length: Math.ceil(line.length / MAX_LINE_CHARS) }, (_, i) =>
            line.slice(i * MAX_LINE_CHARS, (i + 1) * MAX_LINE_CHARS),
          ),
    );
  if (lines.length > MAX_MESSAGE_LINES) lines = [...lines.slice(0, MAX_MESSAGE_LINES), '…'];
  const body = lines.length === 1 && lines[0] === '' ? ['(no message)'] : lines;
  return body.map((line) => `${QUOTE}${line}`).join('\n');
}

function formCopy(context: QuestionContext, message: string): string {
  const name = who(context);
  return [
    `Question from ${name} (not an approval)`,
    '',
    `${capitalize(name)} asks you this while running the tool ${toolLabel(context)}. Your answer goes back to ${name}; it does not approve anything.`,
    '',
    `${capitalize(name)} wrote:`,
    quoteServerText(message),
    '',
    'Decline if you did not expect this question.',
  ].join('\n');
}

function linkCopy(context: QuestionContext, message: string, link: URL): string {
  const name = who(context);
  return [
    `Link from ${name} (not an approval)`,
    '',
    `${capitalize(name)} asks you to open a page while running the tool ${toolLabel(context)}.`,
    `Opens: ${link.origin}`,
    '',
    `${capitalize(name)} wrote:`,
    quoteServerText(message),
    '',
    `Continue only if you expected this and trust ${link.host}.`,
  ].join('\n');
}

function capitalize(text: string): string {
  return text.startsWith('the ') ? `The ${text.slice(4)}` : text;
}

function notForwardable(context: QuestionContext, why: string, never = false): ProjectionError {
  const tool = toolLabel(context);
  return new ProjectionError(
    'upstream',
    `${tool} asked for input that cannot be passed on to the user: ${why}. The call did not complete.`,
    {
      hint: `Nothing is wrong with the arguments, and retrying asks again. Tell the user that ${tool} needs ${never ? 'something this server never provides' : 'input this server cannot pass on'}, so it has to be run another way.`,
    },
  );
}

// ---------------------------------------------------------------------------
// Schema (S5)
// ---------------------------------------------------------------------------

function prose(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = capLength(neutralizeControlChars(stripInvisible(value)).trim(), max);
  return text.length > 0 ? text : undefined;
}

/**
 * Form labels that read like Projection's approval copy (S6): the `⚠`
 * glyph, an `Approve` heading, the `Tool:` footer, the purpose line, or the
 * approval form's own field text.
 */
const APPROVAL_LIKE = /^(?:⚠|approve\b|tool\s*:|what .{0,40} says it does)/iu;
const APPROVAL_FIELD_TEXT = 'Optional note shown to the model when declining.';

/** A title or description: inert, capped, and marked as the server's when it mimics approval copy. */
function label(value: unknown, max: number): string | undefined {
  const text = prose(value, max);
  if (text === undefined) return undefined;
  return APPROVAL_LIKE.test(text) || text === APPROVAL_FIELD_TEXT
    ? capLength(`The server's text: ${text}`, max)
    : text;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** `enum` members (strings only), deduplicated, inert and capped; undefined when none survive. */
function enumValues(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const member of value.slice(0, MAX_ENUM_VALUES)) {
    const text = prose(member, MAX_ENUM_CHARS);
    if (text !== undefined && !out.includes(text)) out.push(text);
  }
  return out.length > 0 ? out : undefined;
}

/** `oneOf` / `anyOf` of `{ const, title }` (titled enums). */
function titledOptions(value: unknown): { const: string; title: string }[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: { const: string; title: string }[] = [];
  for (const option of value.slice(0, MAX_ENUM_VALUES)) {
    if (!isRecord(option)) continue;
    const constant = prose(option['const'], MAX_ENUM_CHARS);
    if (constant === undefined || out.some((o) => o.const === constant)) continue;
    out.push({ const: constant, title: label(option['title'], MAX_TITLE_CHARS) ?? constant });
  }
  return out.length > 0 ? out : undefined;
}

function labels(field: Record<string, unknown>, out: Record<string, unknown>): void {
  const title = label(field['title'], MAX_TITLE_CHARS);
  if (title !== undefined) out['title'] = title;
  const description = label(field['description'], MAX_DESCRIPTION_CHARS);
  if (description !== undefined) out['description'] = description;
}

/** One primitive field of the MCP elicitation schema, allowlisted; undefined when unusable. */
function sanitizeField(field: unknown): Record<string, unknown> | undefined {
  if (!isRecord(field)) return undefined;
  const out: Record<string, unknown> = {};
  switch (field['type']) {
    case 'string': {
      out['type'] = 'string';
      labels(field, out);
      const options = titledOptions(field['oneOf']);
      const members = enumValues(field['enum']);
      if (options !== undefined) {
        out['oneOf'] = options;
      } else if (members !== undefined) {
        out['enum'] = members;
        // Labels pair with members by position: keep them only when every
        // member survived as sent, so no label can land on another value.
        const names = Array.isArray(field['enumNames']) ? field['enumNames'] : undefined;
        const sent = field['enum'] as unknown[];
        if (
          names !== undefined &&
          names.length === sent.length &&
          sent.length === members.length &&
          sent.every((member, i) => member === members[i])
        ) {
          out['enumNames'] = names.map((name) => label(name, MAX_TITLE_CHARS) ?? '');
        }
      } else {
        const minLength = count(field['minLength']);
        if (minLength !== undefined) out['minLength'] = minLength;
        const maxLength = count(field['maxLength']);
        if (maxLength !== undefined) out['maxLength'] = maxLength;
        if (typeof field['format'] === 'string' && STRING_FORMATS.has(field['format'])) {
          out['format'] = field['format'];
        }
      }
      const fallback = prose(field['default'], MAX_DEFAULT_CHARS);
      if (fallback !== undefined) out['default'] = fallback;
      return out;
    }
    case 'number':
    case 'integer': {
      out['type'] = field['type'];
      labels(field, out);
      for (const key of ['minimum', 'maximum', 'default'] as const) {
        const value = finite(field[key]);
        if (value !== undefined) out[key] = value;
      }
      return out;
    }
    case 'boolean': {
      out['type'] = 'boolean';
      labels(field, out);
      if (typeof field['default'] === 'boolean') out['default'] = field['default'];
      return out;
    }
    case 'array': {
      const items = isRecord(field['items']) ? field['items'] : undefined;
      if (items === undefined) return undefined;
      const options = titledOptions(items['anyOf']);
      const members = enumValues(items['enum']);
      if (options === undefined && members === undefined) return undefined;
      out['type'] = 'array';
      labels(field, out);
      out['items'] = options !== undefined ? { anyOf: options } : { type: 'string', enum: members };
      const minItems = count(field['minItems']);
      if (minItems !== undefined) out['minItems'] = minItems;
      const maxItems = count(field['maxItems']);
      if (maxItems !== undefined) out['maxItems'] = maxItems;
      return out;
    }
    default:
      return undefined;
  }
}

/**
 * The server's `requestedSchema`, reduced to the MCP elicitation primitives
 * (S5): at most 12 fields whose names are plain identifiers; each field a
 * string, number, integer, boolean or a multi-select of string options,
 * with only the keywords that shape the form; every string neutralized and
 * capped. Anything else — nested objects, `$ref`, vendor keys, comments,
 * examples, patterns, `additionalProperties` — is dropped, and `required`
 * keeps only surviving fields. Pure and total.
 */
export function sanitizeElicitationSchema(schema: unknown): ElicitationSchema {
  const out: ElicitationSchema = { type: 'object', properties: {} };
  if (!isRecord(schema) || !isRecord(schema['properties'])) return out;
  for (const [name, field] of Object.entries(schema['properties'])) {
    if (Object.keys(out.properties).length >= MAX_FIELDS) break;
    if (!FIELD_NAME.test(name)) continue;
    const safe = sanitizeField(field);
    if (safe !== undefined) out.properties[name] = safe;
  }
  if (Array.isArray(schema['required'])) {
    const required = [
      ...new Set(
        schema['required'].filter(
          (name): name is string => typeof name === 'string' && Object.hasOwn(out.properties, name),
        ),
      ),
    ];
    if (required.length > 0) out.required = required;
  }
  return out;
}

/**
 * An accepted form's content, checked against the schema the human saw:
 * only its fields, each of its type. What the client sends is not trusted
 * to be what the form allowed, and the server is not handed anything else.
 */
function checkedAnswer(schema: ElicitationSchema, content: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isRecord(content)) return out;
  for (const [name, field] of Object.entries(schema.properties)) {
    if (!Object.hasOwn(content, name)) continue;
    const value = content[name];
    switch (field['type']) {
      case 'string':
        if (typeof value === 'string') out[name] = capLength(value, MAX_ANSWER_CHARS);
        break;
      case 'number':
        if (typeof value === 'number' && Number.isFinite(value)) out[name] = value;
        break;
      case 'integer':
        if (typeof value === 'number' && Number.isInteger(value)) out[name] = value;
        break;
      case 'boolean':
        if (typeof value === 'boolean') out[name] = value;
        break;
      case 'array':
        if (Array.isArray(value) && value.every((member) => typeof member === 'string')) {
          out[name] = value.slice(0, MAX_ENUM_VALUES).map((m) => capLength(m, MAX_ENUM_CHARS));
        }
        break;
    }
  }
  return out;
}

/** True when `key` is one of the facade's forwarded-question keys. */
export function isUpstreamKey(key: string): boolean {
  return key.startsWith(UPSTREAM_KEY_PREFIX);
}
