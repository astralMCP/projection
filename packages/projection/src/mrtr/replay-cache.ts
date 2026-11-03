/**
 * The process-local replay cache (R38, DECISIONS D42). Opt-in, never a
 * default: it is correct only when one process serves every retry (a stdio
 * server). Behind a load balancer each instance would keep its own set and
 * a replay sent to another instance would execute (G4), so a horizontally
 * scaled deployment supplies a shared store instead.
 *
 * A restart forgets every nonce. With a persistent blob key, a blob sealed
 * before the restart can be replayed until it expires (`callTtlMs` or
 * `ttlMs`). Where that matters, generate the blob key at startup: blobs
 * from before the restart then fail verification.
 */

import { ProjectionError } from '../errors.js';
import type { ReplayCache } from '../types.js';

/** Default most live nonces a {@link MemoryReplayCache} holds. */
export const DEFAULT_REPLAY_CACHE_MAX_ENTRIES = 100_000;

/** How often, at most, a {@link MemoryReplayCache} sweeps expired nonces. */
const SWEEP_INTERVAL_MS = 1_000;

export interface MemoryReplayCacheOptions {
  /**
   * Most unexpired nonces held at once. Default
   * {@link DEFAULT_REPLAY_CACHE_MAX_ENTRIES}. A full cache refuses new
   * approvals (`cap_exceeded`) until entries expire and a sweep runs (at
   * most once a second); it never forgets a live nonce to make room.
   */
  maxEntries?: number;
  /** Clock override for testability, Unix ms. Default `Date.now()`. */
  now?: () => number;
}

/**
 * An in-memory {@link ReplayCache} for single-process deployments (stdio).
 * Pass it as `WrapOptions.replayCache`:
 *
 * ```ts
 * wrapMcpServer(server, { blob: { key }, replayCache: new MemoryReplayCache() });
 * ```
 *
 * `seen` tests and sets in one synchronous step, so concurrent retries in
 * this process cannot both pass. Expired nonces are swept, so memory is
 * bounded by the approvals live within the blob TTL. A nonce is forgotten
 * only after its blob has expired. A nonce not held whose `exp` is at or
 * before one already forgotten cannot be checked: that only happens after
 * the clock stepped back, so `seen` rejects it (`blob_verification`) rather
 * than revive a swept approval.
 */
export class MemoryReplayCache implements ReplayCache {
  /** Nonce → its blob's `exp` (Unix ms). */
  readonly #entries = new Map<string, number>();
  readonly #maxEntries: number;
  readonly #now: () => number;
  #lastSweep = Number.NEGATIVE_INFINITY;
  /** The latest `exp` swept so far; nothing at or before it is known. */
  #forgottenThrough = Number.NEGATIVE_INFINITY;

  constructor(options: MemoryReplayCacheOptions = {}) {
    const max = options.maxEntries ?? DEFAULT_REPLAY_CACHE_MAX_ENTRIES;
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new RangeError('MemoryReplayCache: maxEntries must be a positive integer');
    }
    this.#maxEntries = max;
    this.#now = options.now ?? Date.now;
  }

  /** Number of nonces currently held (expired ones may linger until a sweep). */
  get size(): number {
    return this.#entries.size;
  }

  seen(nonce: string, exp: number): Promise<boolean> {
    // No await anywhere below: the test and the set happen in one turn of
    // the event loop, so this is atomic within the process.
    if (typeof nonce !== 'string' || !Number.isFinite(exp)) {
      return Promise.reject(
        new ProjectionError('blob_verification', 'the replay cache got an invalid nonce'),
      );
    }
    const now = this.#now();
    // Throttled even when full, so a full cache is not swept on every call.
    // The absolute value lets a backwards clock step still sweep.
    if (Math.abs(now - this.#lastSweep) >= SWEEP_INTERVAL_MS) this.#sweep(now);
    if (this.#entries.has(nonce)) return Promise.resolve(true);
    if (exp <= this.#forgottenThrough) {
      // Its nonce may have been swept: this only happens after a clock step.
      return Promise.reject(
        new ProjectionError(
          'blob_verification',
          'this approval could not be checked against the replay cache because the server clock changed, so it was refused and nothing ran',
          {
            hint: 'Start the call again to request a fresh approval. If this repeats, the server clock moved back; it clears once the clock catches up.',
          },
        ),
      );
    }
    if (this.#entries.size >= this.#maxEntries) {
      return Promise.reject(
        new ProjectionError(
          'cap_exceeded',
          `the replay cache is full (${this.#maxEntries} unexpired approvals), so this approval was refused and nothing ran`,
          { hint: 'Try again once earlier approvals have expired.' },
        ),
      );
    }
    this.#entries.set(nonce, exp);
    return Promise.resolve(false);
  }

  /** Drop every nonce whose blob has expired (the sealer refuses `now >= exp`). */
  #sweep(now: number): void {
    this.#lastSweep = now;
    for (const [nonce, exp] of this.#entries) {
      if (exp <= now) {
        this.#entries.delete(nonce);
        if (exp > this.#forgottenThrough) this.#forgottenThrough = exp;
      }
    }
  }
}
