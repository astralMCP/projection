/**
 * Following a wrapped server's `notifications/tools/list_changed` (PRD R65,
 * DECISIONS D43): the scheduling, the trust bookkeeping and the pieces both
 * facade kinds share.
 *
 * A notification marks its box **dirty** at once. Until a re-listing that
 * started after the last notification lands, the box is decided with its
 * annotations distrusted (see {@link distrustEntries}): a tool the server
 * re-annotated from read-only to write can never run unapproved off the
 * stale snapshot. The re-listing is debounced, coalesced (one cycle covers
 * every dirty box, and notifications during a cycle fold into the next) and
 * rate-capped (cycles start at least `minIntervalMs` apart, backing off on
 * failure), so a server that spams the notification costs at most one
 * bounded `tools/list` walk per interval.
 *
 * Each box carries a **generation**, bumped by every notification. A
 * request decides with the snapshot it started with; the executor it runs
 * (see {@link guardedExecutor}) refuses a call to a box that was trusted in
 * that snapshot and has been notified since, so an in-flight request never
 * auto-runs a call that the current catalog might gate.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { ProjectionError } from '../errors.js';
import type {
  PolicyOverrides,
  ServerAlias,
  ServerCatalog,
  ToolAnnotations,
  ToolCallOutcome,
  ToolCatalogEntry,
  ToolExecutor,
} from '../types.js';

/** `WrapOptions.followListChanged`, resolved. */
export interface FollowSettings {
  /** Subscribe to the wrapped servers' `tools/list_changed` (owned connections only). */
  follow: boolean;
  /** Wait after the first notification before re-listing, so a burst is one cycle. */
  debounceMs: number;
  /** Least time between the starts of two cycles: the rate cap. */
  minIntervalMs: number;
}

export const DEFAULT_FOLLOW_DEBOUNCE_MS = 250;
export const DEFAULT_FOLLOW_MIN_INTERVAL_MS = 2_000;
/** The floor of `minIntervalMs`: the rate cap cannot be configured away. */
export const MIN_FOLLOW_INTERVAL_MS = 100;
const MAX_FOLLOW_DEBOUNCE_MS = 60_000;
const MAX_FOLLOW_INTERVAL_MS = 3_600_000;
/** Longest wait between retries of a failing cycle. */
const MAX_FOLLOW_BACKOFF_MS = 60_000;

function invalid(detail: string): ProjectionError {
  return new ProjectionError('validate', `followListChanged ${detail}`, {
    hint: 'Pass true (the default), false, or { debounceMs?: 0–60000, minIntervalMs?: 100–3600000 }.',
  });
}

/**
 * Validate `WrapOptions.followListChanged`: absent or `true` follows with
 * the default timing, `false` does not subscribe, and an object tunes the
 * timing (`debounceMs` 0–60 000, `minIntervalMs` 100–3 600 000, whole
 * milliseconds). Anything else is a `validate` error at wrap time.
 */
export function resolveFollowSettings(value: unknown): FollowSettings {
  const defaults = {
    debounceMs: DEFAULT_FOLLOW_DEBOUNCE_MS,
    minIntervalMs: DEFAULT_FOLLOW_MIN_INTERVAL_MS,
  };
  if (value === undefined || value === true) return { follow: true, ...defaults };
  if (value === false) return { follow: false, ...defaults };
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid('must be a boolean or { debounceMs?, minIntervalMs? }');
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'debounceMs' && key !== 'minIntervalMs') throw invalid(`has an unknown key`);
  }
  const whole = (key: string, min: number, max: number, fallback: number): number => {
    const raw = record[key];
    if (raw === undefined) return fallback;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
      throw invalid(`.${key} must be a whole number of milliseconds from ${min} to ${max}`);
    }
    return raw;
  };
  return {
    follow: true,
    debounceMs: whole('debounceMs', 0, MAX_FOLLOW_DEBOUNCE_MS, defaults.debounceMs),
    minIntervalMs: whole(
      'minIntervalMs',
      MIN_FOLLOW_INTERVAL_MS,
      MAX_FOLLOW_INTERVAL_MS,
      defaults.minIntervalMs,
    ),
  };
}

/** What a {@link ListChangeTracker} drives. */
export interface ListChangeHooks<T> {
  /** Re-list one box, bounded (the introspect timeout). Must not commit anything. */
  relist(alias: ServerAlias): Promise<T>;
  /**
   * Commit re-listed boxes and rebuild the facade, synchronously and all or
   * nothing. `trusted` is every box with no notification outstanding once
   * these land. A throw keeps the previous snapshot; the boxes stay dirty.
   */
  apply(results: ReadonlyMap<ServerAlias, T>, trusted: ReadonlySet<ServerAlias>): void;
  /** A box just went dirty: rebuild what the gate decides with, synchronously. */
  distrust(trusted: ReadonlySet<ServerAlias>): void;
}

interface Waiter {
  resolve: () => void;
  reject: (err: unknown) => void;
}

/**
 * Per-facade scheduler for re-listing boxes whose server said their tool
 * list changed. One cycle at a time; a cycle re-lists every dirty box
 * concurrently and applies the results in one rebuild.
 */
export class ListChangeTracker<T> {
  readonly #hooks: ListChangeHooks<T>;
  readonly #settings: FollowSettings;
  /** Bumped by every notification. */
  readonly #generation = new Map<ServerAlias, number>();
  /** The generation the current snapshot of each box reflects. */
  readonly #applied = new Map<ServerAlias, number>();
  readonly #waiters = new Map<ServerAlias, Waiter[]>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;
  #lastStart = Number.NEGATIVE_INFINITY;
  /** Per box: consecutive failed cycles, and when it may be tried again. */
  readonly #failures = new Map<ServerAlias, number>();
  readonly #eligibleAt = new Map<ServerAlias, number>();
  #closed = false;

  constructor(aliases: Iterable<ServerAlias>, settings: FollowSettings, hooks: ListChangeHooks<T>) {
    this.#hooks = hooks;
    this.#settings = settings;
    for (const alias of aliases) {
      this.#generation.set(alias, 0);
      this.#applied.set(alias, 0);
    }
  }

  /** The box's current generation (see the module comment). */
  generation(alias: ServerAlias): number {
    return this.#generation.get(alias) ?? 0;
  }

  /** The boxes with no notification outstanding. */
  trusted(): Set<ServerAlias> {
    const trusted = new Set<ServerAlias>();
    for (const [alias, generation] of this.#generation) {
      if (this.#applied.get(alias) === generation) trusted.add(alias);
    }
    return trusted;
  }

  /**
   * A box's server said its tool list changed. Marks it dirty (distrusting
   * it at once on the clean → dirty edge) and schedules a cycle. An unknown
   * alias is ignored.
   */
  notify(alias: ServerAlias): void {
    if (this.#closed) return;
    const generation = this.#generation.get(alias);
    if (generation === undefined) return;
    const wasClean = this.#applied.get(alias) === generation;
    this.#generation.set(alias, generation + 1);
    if (wasClean) this.#hooks.distrust(this.trusted());
    this.#schedule();
  }

  /**
   * Re-list `alias` now (through the same debounce and rate cap) and settle
   * once a cycle has applied it: resolves when it lands, rejects with the
   * failure of the cycle that tried.
   */
  refresh(alias: ServerAlias): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.#closed) {
        resolve();
        return;
      }
      this.#waiters.set(alias, [...(this.#waiters.get(alias) ?? []), { resolve, reject }]);
      this.notify(alias);
    });
  }

  /** Stop: no further cycle starts, and a cycle in flight applies nothing. */
  close(): void {
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const waiters of this.#waiters.values()) for (const waiter of waiters) waiter.resolve();
    this.#waiters.clear();
  }

  #dirty(): ServerAlias[] {
    return [...this.#generation]
      .filter(([alias, generation]) => this.#applied.get(alias) !== generation)
      .map(([alias]) => alias);
  }

  #schedule(): void {
    if (this.#closed || this.#running || this.#timer !== undefined) return;
    const dirty = this.#dirty();
    if (dirty.length === 0) return;
    // Debounced from the notification, rate-capped from the last cycle's
    // start, and no sooner than the first dirty box's own backoff allows.
    const now = Date.now();
    const eligible = Math.min(...dirty.map((alias) => this.#eligibleAt.get(alias) ?? 0));
    const delay = Math.max(
      this.#settings.debounceMs,
      this.#lastStart + this.#settings.minIntervalMs - now,
      eligible - now,
    );
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#cycle();
    }, delay);
    // A pending re-listing never keeps the process alive on its own.
    this.#timer.unref?.();
  }

  async #cycle(): Promise<void> {
    if (this.#closed) return;
    const now = Date.now();
    const aliases = this.#dirty().filter((alias) => (this.#eligibleAt.get(alias) ?? 0) <= now);
    if (aliases.length === 0) {
      this.#schedule();
      return;
    }
    this.#running = true;
    this.#lastStart = now;
    const started = new Map(aliases.map((alias) => [alias, this.generation(alias)]));
    const settled = await Promise.allSettled(aliases.map((alias) => this.#hooks.relist(alias)));
    try {
      if (this.#closed) return;
      const results = new Map<ServerAlias, T>();
      const failed = new Map<ServerAlias, unknown>();
      settled.forEach((outcome, index) => {
        const alias = aliases[index] as ServerAlias;
        if (outcome.status === 'fulfilled') results.set(alias, outcome.value);
        else failed.set(alias, outcome.reason);
      });
      // One rebuild for the cycle; when it throws, each box alone, so one
      // box whose new catalog cannot be applied never holds another's back.
      const err = this.#apply(results, started);
      if (err !== undefined) {
        for (const [alias, value] of results) {
          const alone = results.size > 1 ? this.#apply(new Map([[alias, value]]), started) : err;
          if (alone !== undefined) failed.set(alias, alone.error);
        }
      }
      for (const alias of aliases) {
        const error = failed.get(alias);
        if (!failed.has(alias)) {
          this.#failures.delete(alias);
          this.#eligibleAt.delete(alias);
          continue;
        }
        // Backs off per box: a box whose server keeps failing never delays
        // another box's re-listing beyond the shared rate cap.
        const failures = (this.#failures.get(alias) ?? 0) + 1;
        this.#failures.set(alias, failures);
        const wait = Math.min(this.#settings.minIntervalMs * 2 ** failures, MAX_FOLLOW_BACKOFF_MS);
        this.#eligibleAt.set(alias, Date.now() + wait);
        this.#settleWaiters(alias, error ?? new Error('re-listing failed'));
      }
    } finally {
      this.#running = false;
      this.#schedule();
    }
  }

  /** Apply `results`: the error a throwing rebuild threw, or `undefined` once applied. */
  #apply(
    results: ReadonlyMap<ServerAlias, T>,
    started: ReadonlyMap<ServerAlias, number>,
  ): { error: unknown } | undefined {
    if (results.size === 0) return undefined;
    const trusted = this.trusted();
    for (const alias of results.keys()) {
      if (started.get(alias) === this.generation(alias)) trusted.add(alias);
      else trusted.delete(alias);
    }
    try {
      this.#hooks.apply(results, trusted);
    } catch (error) {
      return { error };
    }
    for (const alias of results.keys()) {
      this.#applied.set(alias, started.get(alias) ?? 0);
      if (trusted.has(alias)) this.#settleWaiters(alias);
    }
    return undefined;
  }

  #settleWaiters(alias: ServerAlias, err?: unknown): void {
    const waiters = this.#waiters.get(alias);
    if (waiters === undefined) return;
    this.#waiters.delete(alias);
    for (const waiter of waiters) {
      if (err === undefined) waiter.resolve();
      else waiter.reject(err);
    }
  }
}

/**
 * A catalog entry decided as if its server had sent no relaxing hint: the
 * `readOnlyHint` and `destructiveHint` are dropped (the title and every
 * other field kept, so approval copy reads the same). Used for a dirty box,
 * whose annotations may already be stale.
 */
export function distrustEntries(tools: readonly ToolCatalogEntry[]): ToolCatalogEntry[] {
  return tools.map((entry) => {
    if (entry.annotations === undefined) return entry;
    const { readOnlyHint: _r, destructiveHint: _d, ...rest } = entry.annotations;
    const annotations: ToolAnnotations = rest;
    const { annotations: _a, ...without } = entry;
    return Object.keys(annotations).length > 0 ? { ...without, annotations } : without;
  });
}

/** A single-server catalog with its annotations distrusted. */
export function distrustCatalog(catalog: ServerCatalog): ServerCatalog {
  return { ...catalog, tools: distrustEntries(catalog.tools) };
}

/**
 * The overrides a dirty box is decided with: the exact-name `policy`
 * entries only, never a rule's outcome, since a function rule may have
 * decided on annotations that are now stale. `inBox` says which names
 * belong to the dirty boxes; every other entry is kept as resolved.
 */
export function distrustOverrides(
  resolved: PolicyOverrides | undefined,
  exact: PolicyOverrides | undefined,
  inBox: (name: string) => boolean,
): PolicyOverrides | undefined {
  if (resolved === undefined) return undefined;
  const kept: [string, PolicyOverrides[string]][] = [];
  for (const [name, decision] of Object.entries(resolved)) {
    if (!inBox(name) || (exact !== undefined && Object.hasOwn(exact, name))) {
      kept.push([name, decision]);
    }
  }
  return kept.length > 0 ? Object.fromEntries(kept) : undefined;
}

/**
 * The executor one request runs with: the facade's, except that a call to
 * a box that was trusted when the request started and has been notified
 * since is refused (as a tool failure, never run), because its decision
 * may rest on annotations the server has since changed. A box that was
 * already dirty was decided with its annotations distrusted: its calls run.
 */
export function guardedExecutor(
  executor: ToolExecutor,
  tracker: { generation(alias: ServerAlias): number },
  started: { trusted: ReadonlySet<ServerAlias>; generations: ReadonlyMap<ServerAlias, number> },
): ToolExecutor {
  return {
    callTool(alias, name, args, options) {
      if (
        started.trusted.has(alias) &&
        tracker.generation(alias) !== started.generations.get(alias)
      ) {
        const outcome: ToolCallOutcome = {
          ok: false,
          error: {
            message: `The server's tool list changed while this request ran, so "${name}" was not run. Call it again.`,
          },
        };
        return Promise.resolve(outcome);
      }
      return executor.callTool(alias, name, args, options);
    },
  };
}

/**
 * The servers a facade built that may still be serving (a held connection:
 * stdio, or one an integrator built with `registerOn`), weakly: a server
 * that `createMcpHandler` built for one request is collected once served.
 */
export class HeldServers<S> {
  readonly #refs = new Set<WeakRef<McpServer>>();
  readonly #state = new WeakMap<McpServer, S>();
  #pruneAt = 64;

  add(server: McpServer, state: S): void {
    this.#state.set(server, state);
    this.#refs.add(new WeakRef(server));
    if (this.#refs.size >= this.#pruneAt) {
      this.#prune();
      this.#pruneAt = Math.max(64, this.#refs.size * 2);
    }
  }

  /** Every live server and its state. */
  *entries(): Generator<[McpServer, S]> {
    this.#prune();
    for (const ref of this.#refs) {
      const server = ref.deref();
      const state = server !== undefined ? this.#state.get(server) : undefined;
      if (server !== undefined && state !== undefined) yield [server, state];
    }
  }

  #prune(): void {
    for (const ref of this.#refs) if (ref.deref() === undefined) this.#refs.delete(ref);
  }
}

/**
 * Run `change` on `server` with its tool-list notifications held back, then
 * send one `notifications/tools/list_changed` if anything changed (the SDK
 * sends one per registration change; a refresh may make hundreds).
 */
export function batchToolListChanged(server: McpServer, change: () => boolean): void {
  const held = server as unknown as { sendToolListChanged: () => void };
  held.sendToolListChanged = () => undefined;
  let changed = false;
  try {
    changed = change();
  } finally {
    delete (held as { sendToolListChanged?: unknown }).sendToolListChanged;
  }
  if (changed) server.sendToolListChanged();
}
