/**
 * Credential-leak assertions (PRD S1, R59, §13 "No credential leaks"):
 * capture everything the process prints — every `console.*` method and raw
 * `process.stderr` / `process.stdout` writes — and grep it, together with
 * every result, error and blob a test produced, for distinctive secrets.
 */

import { vi } from 'vitest';

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

export interface CapturedOutput {
  /** Everything printed so far, one entry per call. */
  readonly lines: string[];
  text(): string;
  restore(): void;
}

function render(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message} ${String(arg.stack)}`;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

/** Start capturing (and silencing) all console and std stream output. */
export function captureOutput(): CapturedOutput {
  const lines: string[] = [];
  const spies = [
    ...CONSOLE_METHODS.map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(`console.${method}: ${render(args)}`);
      }),
    ),
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      lines.push(`stderr: ${String(chunk)}`);
      return true;
    }),
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      lines.push(`stdout: ${String(chunk)}`);
      return true;
    }),
  ];
  return {
    lines,
    text: () => lines.join('\n'),
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

/** Everything about a value a test can serialize, errors included (message, stack, cause chain). */
export function dump(value: unknown): string {
  const seen = new Set<unknown>();
  const walk = (item: unknown, depth: number): string => {
    if (depth > 6 || item === null || item === undefined) return String(item);
    if (typeof item !== 'object') return String(item);
    if (seen.has(item)) return '';
    seen.add(item);
    if (item instanceof Error) {
      return [
        item.name,
        item.message,
        String(item.stack),
        JSON.stringify(item),
        walk(item.cause, depth + 1),
        ...Object.getOwnPropertyNames(item).map((key) =>
          walk((item as unknown as Record<string, unknown>)[key], depth + 1),
        ),
      ].join('\n');
    }
    try {
      return JSON.stringify(item);
    } catch {
      return Object.values(item as Record<string, unknown>)
        .map((child) => walk(child, depth + 1))
        .join('\n');
    }
  };
  return walk(value, 0);
}

/** The secrets that appear anywhere in `haystack`. */
export function leakedSecrets(haystack: string, secrets: readonly string[]): string[] {
  return secrets.filter((secret) => secret.length > 0 && haystack.includes(secret));
}
