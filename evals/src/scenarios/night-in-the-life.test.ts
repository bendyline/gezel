import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  type MorningEvidence,
  changedPaths,
  encodeScenePng,
  gradeMorning,
  trialNightWindow,
} from './night-in-the-life.ts';

const good: MorningEvidence = {
  card: {
    prompt: 'The night shift finished 1 task.',
    intent: { kind: 'night-shift-review', windowKey: '2026-10-07', tasksCompleted: 1, reports: [] },
  },
  photos: { eligible: 4, shadowsPending: 0, skipped: 1 },
  code: { summarized: 3, reviewed: 2 },
  changed: [],
};

describe('night-in-the-life grader', () => {
  it('passes a swept night that left the folders alone', () => {
    expect(gradeMorning(good)).toEqual({ ok: true, reasons: [] });
  });

  it('fails a night that touched a folder, however productive', () => {
    const grade = gradeMorning({ ...good, changed: ['.gezel/index/index.db'] });
    expect(grade.ok).toBe(false);
    expect(grade.reasons[0]).toContain('.gezel/index/index.db');
  });

  it('fails without a card, a described photo, or reviewed code', () => {
    expect(gradeMorning({ ...good, card: null }).reasons).toContain(
      'no morning card for the window',
    );
    expect(
      gradeMorning({ ...good, photos: { eligible: 4, shadowsPending: 2, skipped: 2 } }).reasons,
    ).toContain('no photo was described');
    expect(gradeMorning({ ...good, code: { summarized: 3, reviewed: 0 } }).reasons).toContain(
      'no code file was reviewed',
    );
  });

  it('names added, removed and changed paths', () => {
    expect(changedPaths({ a: '1', b: '2' }, { a: '1', b: '3', c: '4' })).toEqual(['b', 'c']);
  });
});

describe('trialNightWindow', () => {
  it('opens now and closes one to two hours out, across midnight too', () => {
    expect(trialNightWindow(new Date(2026, 9, 7, 14, 10))).toEqual({ startHour: 14, endHour: 15 });
    expect(trialNightWindow(new Date(2026, 9, 7, 14, 45))).toEqual({ startHour: 14, endHour: 16 });
    expect(trialNightWindow(new Date(2026, 9, 7, 23, 50))).toEqual({ startHour: 23, endHour: 1 });
  });
});

describe('encodeScenePng', () => {
  it('writes a well-formed PNG of the declared size', () => {
    const png = encodeScenePng([0, 0, 255], [255, 0, 0], 'disc');
    expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(64);
    expect(png.readUInt32BE(20)).toBe(48);
    const idatLength = png.readUInt32BE(33);
    const pixels = inflateSync(png.subarray(41, 41 + idatLength));
    expect(pixels.length).toBe(48 * (1 + 64 * 3));
  });
});
