import { describe, expect, it } from 'vitest';
import { formatAbsoluteTime, formatRelativeTime } from './relative-time.js';

const NOW = Date.parse('2026-08-20T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('formatRelativeTime', () => {
  it('walks the scale in short style', () => {
    const at = (ms: number) => formatRelativeTime(ago(ms), { now: NOW });
    expect(at(0)).toBe('just now');
    expect(at(30 * SEC)).toBe('just now');
    expect(at(18 * MIN)).toBe('18m ago');
    expect(at(3 * HOUR)).toBe('3h ago');
    expect(at(25 * HOUR)).toBe('yesterday');
    expect(at(4 * DAY)).toBe('4d ago');
    expect(at(17 * DAY)).toBe('2w ago');
    expect(at(90 * DAY)).toBe('3mo ago');
    expect(at(800 * DAY)).toBe('2y ago');
  });

  it('walks the same buckets in long style', () => {
    const at = (ms: number) => formatRelativeTime(ago(ms), { now: NOW, style: 'long' });
    expect(at(30 * SEC)).toBe('just now');
    expect(at(1 * MIN)).toBe('1 minute ago');
    expect(at(18 * MIN)).toBe('18 minutes ago');
    expect(at(1 * HOUR)).toBe('1 hour ago');
    expect(at(25 * HOUR)).toBe('yesterday');
    expect(at(4 * DAY)).toBe('4 days ago');
    expect(at(17 * DAY)).toBe('2 weeks ago');
  });

  /* The bug this module exists to kill: the git status bar rolled over to a
     calendar date after a day while the panel next to it kept counting. */
  it('stays relative past a day instead of switching to a calendar date', () => {
    const label = formatRelativeTime(ago(17 * DAY), { now: NOW });
    expect(label).toBe('2w ago');
    expect(label).not.toMatch(/\d{4}/);
  });

  it('counts seconds only when the caller asks', () => {
    expect(formatRelativeTime(ago(12 * SEC), { now: NOW })).toBe('just now');
    expect(formatRelativeTime(ago(12 * SEC), { now: NOW, seconds: true })).toBe('12s ago');
    expect(formatRelativeTime(ago(12 * SEC), { now: NOW, seconds: true, style: 'long' })).toBe(
      '12 seconds ago',
    );
  });

  it('accepts epoch millis and Date alongside ISO strings', () => {
    expect(formatRelativeTime(NOW - 5 * MIN, { now: NOW })).toBe('5m ago');
    expect(formatRelativeTime(new Date(NOW - 5 * MIN), { now: NOW })).toBe('5m ago');
  });

  /* A daemon clock running ahead of the renderer must not print "-3m ago". */
  it('clamps future timestamps to the present', () => {
    expect(formatRelativeTime(NOW + 3 * MIN, { now: NOW })).toBe('just now');
  });

  it('returns the fallback for missing or unparseable input', () => {
    expect(formatRelativeTime(undefined)).toBe('');
    expect(formatRelativeTime(null)).toBe('');
    expect(formatRelativeTime('')).toBe('');
    expect(formatRelativeTime('not a date', { fallback: 'not a date' })).toBe('not a date');
    expect(formatRelativeTime(Number.NaN)).toBe('');
  });
});

describe('formatAbsoluteTime', () => {
  it('renders a date and a time for the hover title', () => {
    const title = formatAbsoluteTime('2026-07-24T09:30:00.000Z');
    expect(title).toMatch(/2026/);
    expect(title.length).toBeGreaterThan(0);
  });

  it('returns the fallback for unusable input', () => {
    expect(formatAbsoluteTime(undefined)).toBe('');
    expect(formatAbsoluteTime('nope', '—')).toBe('—');
  });
});
