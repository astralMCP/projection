import { describe, expect, it } from 'vitest';
import { clampCaps, DEFAULT_CAPS, MAX_CAPS } from '../src/types.js';

describe('clampCaps', () => {
  it('returns defaults when nothing is requested', () => {
    expect(clampCaps({})).toEqual(DEFAULT_CAPS);
  });

  it('allows configuring downward', () => {
    const caps = clampCaps({ segmentWallClockMs: 5_000 });
    expect(caps.segmentWallClockMs).toBe(5_000);
  });

  it('clamps at the hard maxima', () => {
    const caps = clampCaps({ maxRoundTrips: 999, wasmMemoryBytes: Number.MAX_SAFE_INTEGER });
    expect(caps.maxRoundTrips).toBe(MAX_CAPS.maxRoundTrips);
    expect(caps.wasmMemoryBytes).toBe(MAX_CAPS.wasmMemoryBytes);
  });
});
