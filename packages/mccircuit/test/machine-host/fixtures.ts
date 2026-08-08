import { generateToolTypes } from '../../src/typegen/index.js';
import type {
  ServerCatalog,
  ToolCallOutcome,
  ToolCatalogEntry,
  ToolExecutor,
} from '../../src/types.js';

export function entry(overrides: Partial<ToolCatalogEntry> = {}): ToolCatalogEntry {
  return { name: 'read_file', inputSchema: { type: 'object' }, ...overrides };
}

export const CATALOG: ServerCatalog = {
  alias: 'default',
  identity: 'files@1.0.0',
  tools: [
    entry({
      name: 'read_file',
      description: 'Read a file.',
      annotations: { readOnlyHint: true },
    }),
    entry({
      name: 'list_dir',
      description: 'List a directory.',
      annotations: { readOnlyHint: true },
    }),
    entry({ name: 'write_file', description: 'Write a file.' }),
    entry({
      name: 'delete_file',
      description: 'Delete a file.',
      annotations: { destructiveHint: true },
    }),
  ],
};

export const BRIDGE_SOURCE = generateToolTypes(CATALOG).bridgeSource;

/** Records every call and answers from a scripted table. */
export class FakeExecutor implements ToolExecutor {
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  private readonly results: Record<string, ToolCallOutcome>;

  constructor(results: Record<string, ToolCallOutcome> = {}) {
    this.results = results;
  }

  callTool(_alias: string, name: string, args: Record<string, unknown>): Promise<ToolCallOutcome> {
    this.calls.push({ name, args });
    return Promise.resolve(this.results[name] ?? { ok: true, result: `${name}-ok` });
  }
}

export const baseOptions = {
  catalog: CATALOG,
  bridgeSource: BRIDGE_SOURCE,
} as const;
