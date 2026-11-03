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
 * every dirty box, each box has at most one re-listing in flight, and
 * notifications during it fold into the next) and rate-capped (cycles start
 * at least `minIntervalMs` apart, each box backing off on failure), so a
 * server that spams the notification costs at most one bounded `tools/list`
 * walk per interval. Each box's result is applied as soon as its own
 * re-listing lands, so a slow box never keeps another distrusted.
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
   * Commit one re-listed box and rebuild the facade, synchronously and all
   * or nothing: a throw must leave the previous snapshot in place (the box
   * stays dirty), and nothing after the commit may throw. `trusted` is
   * every box with no notification outstanding once this lands.
   */
  apply(results: ReadonlyMap<ServerAlias, T>, trusted: ReadonlySet<ServerAlias>): void;
  /** A box just went dirty: rebuild what the gate decides with, synchronously. */
  distrust(trusted: ReadonlySet<ServerAlias>): void;
}

interface Waiter {
  /** The box's generation when the refresh was asked for. */
  target: number;
  resolve: () => void;
  reject: (err: unknown) => void;
}

/**
 * Per-facade scheduler for re-listing boxes whose server said their tool
 * list changed. A cycle starts a re-listing of every dirty box that is not
 * already being re-listed, and each box's result is applied as soon as its
 * own re-listing settles: a slow box never holds a fast one back. A box
 * notified again while it is re-listed is picked up by a later cycle.
 */
export class ListChangeTracker<T> {
  readonly #hooks: ListChangeHooks<T>;
  readonly #settings: FollowSettings;
  /** Bumped by every notification. */
  readonly #generation = new Map<ServerAlias, number>();
  /** The generation the current snapshot of each box reflects. */
  readonly #applied = new Map<ServerAlias, number>();
  readonly #waiters = new Map<ServerAlias, Waiter[]>();
  /** The boxes whose re-listing is in flight. */
  readonly #inFlight = new Set<ServerAlias>();
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** When the armed timer fires. */
  #timerAt = Number.POSITIVE_INFINITY;
  #lastStart = Number.NEGATIVE_INFINITY;
  /** Per box: consecutive failed re-listings, and when it may be tried again. */
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
   * once a re-listing that started after this call has landed: resolves
   * when it is applied (even if a later notification already left the box
   * dirty again), rejects with the failure of such a re-listing.
   */
  refresh(alias: ServerAlias): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.#closed || !this.#generation.has(alias)) {
        resolve();
        return;
      }
      this.notify(alias);
      const target = this.generation(alias);
      this.#waiters.set(alias, [...(this.#waiters.get(alias) ?? []), { target, resolve, reject }]);
    });
  }

  /** Stop: no further cycle starts, and a re-listing in flight applies nothing. */
  close(): void {
    this.#closed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#timerAt = Number.POSITIVE_INFINITY;
    for (const waiters of this.#waiters.values()) for (const waiter of waiters) waiter.resolve();
    this.#waiters.clear();
  }

  /** The dirty boxes not being re-listed already. */
  #pending(): ServerAlias[] {
    return [...this.#generation]
      .filter(([alias, generation]) => this.#applied.get(alias) !== generation)
      .map(([alias]) => alias)
      .filter((alias) => !this.#inFlight.has(alias));
  }

  #schedule(): void {
    if (this.#closed) return;
    const pending = this.#pending();
    if (pending.length === 0) return;
    // Debounced from the notification, rate-capped from the last cycle's
    // start, and no sooner than the first pending box's own backoff allows.
    const now = Date.now();
    const eligible = Math.min(...pending.map((alias) => this.#eligibleAt.get(alias) ?? 0));
    const delay = Math.max(
      this.#settings.debounceMs,
      this.#lastStart + this.#settings.minIntervalMs - now,
      eligible - now,
    );
    // One shared timer; a box notified while another box's backoff holds
    // it re-arms it sooner, so it never waits out that backoff.
    if (this.#timer !== undefined) {
      if (now + delay >= this.#timerAt) return;
      clearTimeout(this.#timer);
    }
    this.#timerAt = now + delay;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#timerAt = Number.POSITIVE_INFINITY;
      this.#cycle();
    }, delay);
    // A pending re-listing never keeps the process alive on its own.
    this.#timer.unref?.();
  }

  #cycle(): void {
    if (this.#closed) return;
    const now = Date.now();
    const aliases = this.#pending().filter((alias) => (this.#eligibleAt.get(alias) ?? 0) <= now);
    if (aliases.length > 0) {
      this.#lastStart = now;
      for (const alias of aliases) {
        const started = this.generation(alias);
        this.#inFlight.add(alias);
        let relisting: Promise<T>;
        try {
          relisting = this.#hooks.relist(alias);
        } catch (error) {
          relisting = Promise.reject(error);
        }
        relisting
          .then(
            (value) => this.#landed(alias, started, value),
            (error: unknown) => this.#failed(alias, started, error),
          )
          .finally(() => {
            this.#inFlight.delete(alias);
            this.#schedule();
          });
      }
    }
    // Boxes still backing off, or notified meanwhile, get their own timer.
    this.#schedule();
  }

  /** One box's re-listing (started at generation `started`) succeeded: apply it. */
  #landed(alias: ServerAlias, started: number, value: T): void {
    if (this.#closed) return;
    const trusted = this.trusted();
    if (started === this.generation(alias)) trusted.add(alias);
    else trusted.delete(alias);
    try {
      this.#hooks.apply(new Map([[alias, value]]), trusted);
    } catch (error) {
      this.#failed(alias, started, error);
      return;
    }
    this.#applied.set(alias, started);
    this.#failures.delete(alias);
    this.#eligibleAt.delete(alias);
    // A notification that arrived during the apply itself (a listener that
    // refreshes, say) found the box dirty already and distrusted nothing,
    // yet the snapshot just committed trusts it: distrust it now, so a
    // dirty box is always decided distrusted.
    if (this.generation(alias) !== started && trusted.has(alias)) {
      this.#hooks.distrust(this.trusted());
    }
    this.#settleWaiters(alias, started);
  }

  /** One box's re-listing failed, or could not be applied: back off. */
  #failed(alias: ServerAlias, started: number, error: unknown): void {
    if (this.#closed) return;
    // Per box: a box whose server keeps failing never delays another box's
    // re-listing beyond the shared rate cap.
    const failures = (this.#failures.get(alias) ?? 0) + 1;
    this.#failures.set(alias, failures);
    const wait = Math.min(this.#settings.minIntervalMs * 2 ** failures, MAX_FOLLOW_BACKOFF_MS);
    this.#eligibleAt.set(alias, Date.now() + wait);
    this.#settleWaiters(alias, started, error ?? new Error('re-listing failed'));
  }

  /**
   * Settle the waiters a re-listing started at generation `started`
   * answers: those asked for at or before it. Later waiters wait on.
   */
  #settleWaiters(alias: ServerAlias, started: number, err?: unknown): void {
    const waiters = this.#waiters.get(alias);
    if (waiters === undefined) return;
    const answered = waiters.filter((waiter) => waiter.target <= started);
    const rest = waiters.filter((waiter) => waiter.target > started);
    if (rest.length > 0) this.#waiters.set(alias, rest);
    else this.#waiters.delete(alias);
    for (const waiter of answered) {
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
 * The overrides a dirty box is decided with: every exact-name `policy`
 * entry, and the rule outcomes that tighten (`ask`, `deny`); a rule's
 * `auto` is dropped, since a function rule may have decided it on
 * annotations that are now stale. A rule can only make a dirty box
 * stricter, never looser. `inBox` says which names belong to the dirty
 * boxes; every other entry is kept as resolved.
 */
export function distrustOverrides(
  resolved: PolicyOverrides | undefined,
  exact: PolicyOverrides | undefined,
  inBox: (name: string) => boolean,
): PolicyOverrides | undefined {
  if (resolved === undefined) return undefined;
  const kept: [string, PolicyOverrides[string]][] = [];
  for (const [name, decision] of Object.entries(resolved)) {
    if (
      decision !== 'auto' ||
      !inBox(name) ||
      (exact !== undefined && Object.hasOwn(exact, name))
    ) {
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
 * Call each of a facade's `onToolsChanged` listeners; one that throws never
 * stops the others, nor the refresh that has already been committed.
 */
export function notifyListeners(listeners: Iterable<() => void>): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // The listener's own failure; the refresh stands.
    }
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
