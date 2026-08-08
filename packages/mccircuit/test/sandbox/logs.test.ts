import { describe, expect, it } from 'vitest';
import { LogCollector, TRUNCATION_MARKER_PREFIX } from '../../src/sandbox/logs.js';
import { withSession } from './helpers.js';

describe('console capture (R31)', () => {
  it('captures all five console levels as structured entries with segment index', async () => {
    const code = `
      console.log('plain', { a: 1 });
      console.info('informational');
      console.warn('warning');
      console.error('failure');
      console.debug('debugging');
      export default 1;
    `;
    await withSession({ code, segment: 3 }, async (session) => {
      const logs = session.getLogs();
      expect(logs.map((l) => [l.level, l.message])).toEqual([
        ['log', 'plain {"a":1}'],
        ['info', 'informational'],
        ['warn', 'warning'],
        ['error', 'failure'],
        ['debug', 'debugging'],
      ]);
      for (const entry of logs) {
        expect(entry.segment).toBe(3);
        expect(entry.ts).toBeGreaterThanOrEqual(0);
        expect(entry.ts).toBeLessThan(30_000);
      }
    });
  });

  it('keeps logs available across evaluate calls and after errors', async () => {
    await withSession({ code: `console.log('at boot'); export default 1;` }, async (session) => {
      await session.evaluate(`console.warn('from driver'); export default null;`);
      await session.evaluate(`console.log('pre-crash'); throw new Error('x');`).catch(() => {});
      expect(session.getLogs().map((l) => l.message)).toEqual([
        'at boot',
        'from driver',
        'pre-crash',
      ]);
    });
  });

  it('truncates over-budget output drop-middle with an explicit marker (in-VM)', async () => {
    const code = `
      for (let i = 0; i < 200; i++) {
        console.log('entry-' + String(i).padStart(3, '0') + '-' + 'x'.repeat(40));
      }
      export default 1;
    `;
    await withSession({ code, caps: { maxConsoleBytes: 1_000 } }, async (session) => {
      const logs = session.getLogs();
      const messages = logs.map((l) => l.message);
      // Head kept
      expect(messages[0]).toContain('entry-000');
      // Tail kept
      expect(messages[messages.length - 1]).toContain('entry-199');
      // Explicit marker between them
      const marker = logs.find((l) => l.message.startsWith(TRUNCATION_MARKER_PREFIX));
      expect(marker).toBeDefined();
      expect(marker?.level).toBe('warn');
      expect(marker?.message).toMatch(/\d+ entries dropped/);
      // Budget respected (marker exempt)
      const bytes = messages
        .filter((m) => !m.startsWith(TRUNCATION_MARKER_PREFIX))
        .reduce((sum, m) => sum + m.length, 0);
      expect(bytes).toBeLessThanOrEqual(1_000);
    });
  });
});

describe('LogCollector unit behavior', () => {
  it('returns entries verbatim while under budget', () => {
    const collector = new LogCollector(10_000, 0);
    collector.push('log', ['one']);
    collector.push('warn', ['two', { b: 2 }]);
    expect(collector.snapshot().map((l) => [l.level, l.message])).toEqual([
      ['log', 'one'],
      ['warn', 'two {"b":2}'],
    ]);
  });

  it('drops the middle, keeping head and tail halves', () => {
    const collector = new LogCollector(400, 1);
    for (let i = 0; i < 100; i++) {
      collector.push('log', [`msg-${String(i).padStart(2, '0')}-${'y'.repeat(20)}`]);
    }
    const logs = collector.snapshot();
    const messages = logs.map((l) => l.message);
    expect(messages[0]).toContain('msg-00');
    expect(messages[messages.length - 1]).toContain('msg-99');
    const markerIndex = messages.findIndex((m) => m.startsWith(TRUNCATION_MARKER_PREFIX));
    expect(markerIndex).toBeGreaterThan(0);
    expect(markerIndex).toBeLessThan(messages.length - 1);
    // Everything before the marker is the head run, everything after the tail run.
    expect(messages[markerIndex - 1]).toContain('msg-0');
    expect(logs[markerIndex]?.segment).toBe(1);
  });

  it('clamps a single oversized message instead of blowing the budget', () => {
    const collector = new LogCollector(200, 0);
    collector.push('log', ['z'.repeat(5_000)]);
    const [entry] = collector.snapshot();
    expect(entry).toBeDefined();
    expect(entry!.message.length).toBeLessThanOrEqual(200);
    expect(entry!.message).toContain('…[truncated]');
  });

  it('formats errors and unserializable values defensively', () => {
    const collector = new LogCollector(10_000, 0);
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    collector.push('error', [new Error('kaboom'), circular, undefined]);
    const [entry] = collector.snapshot();
    expect(entry!.message).toContain('Error: kaboom');
    expect(entry!.message).toContain('[object Object]');
    expect(entry!.message).toContain('undefined');
  });
});
