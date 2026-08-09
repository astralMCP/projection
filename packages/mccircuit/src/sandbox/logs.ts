/**
 * Console capture with byte-capped, drop-middle truncation (R31, R12).
 *
 * All `console.log/info/warn/error/debug` calls inside the VM are recorded as
 * structured {@link LogEntry} values. The total captured output per segment is
 * capped at `maxConsoleBytes`: the head and tail of the stream are kept (half
 * the budget each) and the middle is dropped, replaced by a single explicit
 * truncation marker entry.
 */

import type { LogEntry, LogLevel } from '../types.js';

const encoder = new TextEncoder();

/** UTF-8 byte length of a string (shared cached encoder). */
export function utf8Length(value: string): number {
  return encoder.encode(value).length;
}

/** Truncate a string to at most `maxBytes` UTF-8 bytes, appending a marker. */
function truncateUtf8(value: string, maxBytes: number): string {
  if (utf8Length(value) <= maxBytes) {
    return value;
  }
  const suffix = '…[truncated]';
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && utf8Length(value.slice(0, end)) + utf8Length(suffix) > maxBytes) {
    end = Math.floor(end / 2);
  }
  return value.slice(0, end) + suffix;
}

/** Best-effort single-string rendering of one console argument. */
function formatParam(param: unknown): string {
  if (typeof param === 'string') {
    return param;
  }
  if (param instanceof Error) {
    return `${param.name}: ${param.message}`;
  }
  if (typeof param === 'function') {
    return '[function]';
  }
  try {
    const json = JSON.stringify(param);
    return json === undefined ? String(param) : json;
  } catch {
    return String(param);
  }
}

/** Marker prefix used in the synthetic truncation entry. */
export const TRUNCATION_MARKER_PREFIX = '[mccircuit] console output truncated:';

/**
 * Collects console output for one execution segment, enforcing the
 * `maxConsoleBytes` cap with drop-middle truncation.
 */
export class LogCollector {
  private readonly head: LogEntry[] = [];
  private readonly tail: LogEntry[] = [];
  private headBytes = 0;
  private tailBytes = 0;
  private dropped = 0;
  private readonly halfBudget: number;
  private readonly startedAt = Date.now();

  constructor(
    private readonly maxBytes: number,
    private readonly segment: number,
  ) {
    this.halfBudget = Math.max(64, Math.floor(maxBytes / 2));
  }

  /** Record one console call. `params` are the marshaled console arguments. */
  push(level: LogLevel, params: unknown[]): void {
    const message = truncateUtf8(params.map(formatParam).join(' '), this.halfBudget);
    const cost = utf8Length(message);
    const entry: LogEntry = {
      level,
      message,
      ts: Date.now() - this.startedAt,
      segment: this.segment,
    };
    if (this.tail.length === 0 && this.headBytes + cost <= this.halfBudget) {
      this.head.push(entry);
      this.headBytes += cost;
      return;
    }
    this.tail.push(entry);
    this.tailBytes += cost;
    while (this.tailBytes > this.halfBudget && this.tail.length > 1) {
      const evicted = this.tail.shift();
      if (evicted !== undefined) {
        this.tailBytes -= utf8Length(evicted.message);
        this.dropped += 1;
      }
    }
  }

  /**
   * The captured entries in order. When entries were dropped, a synthetic
   * `warn` marker entry sits between the kept head and tail.
   */
  snapshot(): LogEntry[] {
    if (this.dropped === 0) {
      return [...this.head, ...this.tail];
    }
    const marker: LogEntry = {
      level: 'warn',
      message: `${TRUNCATION_MARKER_PREFIX} ${this.dropped} entries dropped (maxConsoleBytes=${this.maxBytes})`,
      ts: this.tail[0]?.ts ?? Date.now() - this.startedAt,
      segment: this.segment,
    };
    return [...this.head, marker, ...this.tail];
  }
}
