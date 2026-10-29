import type { Diagnostic, ErrorPhase, LogEntry, StructuredError } from './types.js';

/**
 * Error carrying the structured `isError` body every failure returns (R25).
 */
export class ProjectionError extends Error {
  readonly phase: ErrorPhase;
  readonly diagnostics: Diagnostic[];
  readonly hint: string;
  logs: LogEntry[];

  constructor(
    phase: ErrorPhase,
    message: string,
    options: { diagnostics?: Diagnostic[]; hint?: string; logs?: LogEntry[]; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'ProjectionError';
    this.phase = phase;
    this.diagnostics = options.diagnostics ?? [];
    this.hint = options.hint ?? '';
    this.logs = options.logs ?? [];
  }

  toStructured(): StructuredError {
    return {
      phase: this.phase,
      message: this.message,
      diagnostics: this.diagnostics,
      hint: this.hint,
      logs: this.logs,
    };
  }
}

/** A configuration mistake caught at wrap time (R39's rule): a `validate` error. */
export function invalidConfig(message: string, hint: string): ProjectionError {
  return new ProjectionError('validate', message, { hint });
}

/** Convert any thrown value into a StructuredError, defaulting to `runtime` phase. */
export function toStructuredError(err: unknown, logs: LogEntry[] = []): StructuredError {
  if (err instanceof ProjectionError) {
    const structured = err.toStructured();
    return { ...structured, logs: structured.logs.length > 0 ? structured.logs : logs };
  }
  return {
    phase: 'runtime',
    message: err instanceof Error ? err.message : String(err),
    diagnostics: [],
    hint: '',
    logs,
  };
}
