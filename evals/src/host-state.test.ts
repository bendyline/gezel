import { describe, expect, it } from 'vitest';
import {
  buildHostStateSnapshot,
  formatHostState,
  parseMeminfoMb,
  parseProcUptime,
  parseVmstatCounter,
} from './host-state.ts';

// Verbatim shapes from the DGX Spark this was built to diagnose.
const UPTIME = '72645.31 1401234.88\n';
const MEMINFO = [
  'MemTotal:       127535020 kB',
  'MemFree:        72139292 kB',
  'MemAvailable:   120673240 kB',
  'Cached:         48331204 kB',
  'Dirty:              1804 kB',
].join('\n');
const VMSTAT = [
  'pgmigrate_fail 0',
  'compact_stall 0',
  'compact_fail 0',
  'thp_fault_alloc 1734',
  'thp_fault_fallback 0',
  'thp_collapse_alloc_failed 0',
].join('\n');

describe('parseProcUptime', () => {
  it('reads seconds since boot from the first field', () => {
    expect(parseProcUptime(UPTIME)).toBe(72645);
  });

  it('returns undefined on junk rather than 0', () => {
    // 0 would read as "just booted", the opposite of the truth.
    expect(parseProcUptime('')).toBeUndefined();
    expect(parseProcUptime('not-a-number x')).toBeUndefined();
  });
});

describe('parseMeminfoMb', () => {
  it('converts kB entries to MB', () => {
    expect(parseMeminfoMb(MEMINFO, 'MemAvailable')).toBe(117845);
    expect(parseMeminfoMb(MEMINFO, 'MemTotal')).toBe(124546);
  });

  it('does not confuse MemFree with MemTotal on a prefix match', () => {
    // Anchored match matters: 'MemFree' must not be satisfied by 'MemFree' in
    // a line-leading position of a different key, nor 'Mem' match everything.
    expect(parseMeminfoMb(MEMINFO, 'MemFree')).toBe(70449);
    expect(parseMeminfoMb(MEMINFO, 'Mem')).toBeUndefined();
  });

  it('returns undefined for an absent key', () => {
    expect(parseMeminfoMb(MEMINFO, 'HugePages_Total')).toBeUndefined();
  });
});

describe('parseVmstatCounter', () => {
  it('reads fragmentation counters', () => {
    expect(parseVmstatCounter(VMSTAT, 'thp_fault_fallback')).toBe(0);
    expect(parseVmstatCounter(VMSTAT, 'compact_stall')).toBe(0);
    expect(parseVmstatCounter(VMSTAT, 'thp_fault_alloc')).toBe(1734);
  });

  it('distinguishes thp_fault_alloc from thp_fault_fallback', () => {
    // A loose regex would let 'thp_fault_alloc' match the fallback key's line
    // and silently report the wrong counter — the exact counter whose value
    // decides whether fragmentation is implicated.
    expect(parseVmstatCounter(VMSTAT, 'thp_fault')).toBeUndefined();
  });

  it('returns undefined for an absent counter', () => {
    expect(parseVmstatCounter(VMSTAT, 'nonexistent_counter')).toBeUndefined();
  });
});

describe('buildHostStateSnapshot', () => {
  it('assembles every field when all sources are present', () => {
    expect(buildHostStateSnapshot({ uptime: UPTIME, meminfo: MEMINFO, vmstat: VMSTAT })).toEqual({
      uptimeSeconds: 72645,
      memAvailableMb: 117845,
      memTotalMb: 124546,
      thpFaultFallback: 0,
      compactStall: 0,
      compactFail: 0,
    });
  });

  it('omits fields rather than zero-filling when a source is missing', () => {
    expect(buildHostStateSnapshot({ uptime: UPTIME })).toEqual({ uptimeSeconds: 72645 });
    expect(buildHostStateSnapshot({})).toEqual({});
  });
});

describe('formatHostState', () => {
  it('renders hours under a day and days beyond it', () => {
    expect(formatHostState({ uptimeSeconds: 72645 })).toBe('uptime 20.2h');
    expect(formatHostState({ uptimeSeconds: 3.5 * 86400 })).toBe('uptime 3.5d');
  });

  it('includes the fragmentation counters that discriminate the hypothesis', () => {
    const text = formatHostState({
      uptimeSeconds: 72645,
      memAvailableMb: 117845,
      memTotalMb: 124546,
      thpFaultFallback: 42,
      compactStall: 7,
    });
    expect(text).toContain('uptime 20.2h');
    expect(text).toContain('115/122 GB avail');
    expect(text).toContain('thpFallback 42');
    expect(text).toContain('compactStall 7');
  });

  it('says so plainly when uptime is unavailable', () => {
    expect(formatHostState({})).toBe('unavailable');
  });
});
