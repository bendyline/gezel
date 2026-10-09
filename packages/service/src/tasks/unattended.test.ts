import { describe, expect, it } from 'vitest';
import { unattendedNightWork, unattendedQuestionDecline } from './unattended.js';

const sweep = {
  projectId: 'site',
  title: 'Nightly fixes — 3 open issues',
  origin: { kind: 'boekwachter-issue' as const, issueRef: 'BW-531', path: 'src/a.ts' },
  nightShift: { enabled: true, onceADay: true },
};

describe('unattended night work', () => {
  it('covers the nightly review, a night fix sweep, and the shards it spawns', () => {
    expect(
      unattendedNightWork({
        projectId: 'default',
        title: 'Night-shift oversight: project review',
        nightShift: { enabled: true, onceADay: true },
      }),
    ).toBe('review');
    expect(unattendedNightWork(sweep)).toBe('night-fix');
    const shard = {
      projectId: 'site',
      title: 'Guard the null token',
      nightShift: { enabled: true },
      parentTaskRef: 'site/8',
    };
    expect(unattendedNightWork(shard, sweep)).toBe('night-fix');
  });

  it("leaves a person's own work alone, even at night", () => {
    // "Fix with AI" on an issue: same origin, no night binding.
    expect(unattendedNightWork({ ...sweep, nightShift: undefined })).toBeNull();
    // A task the person queued for tonight.
    expect(
      unattendedNightWork({ projectId: 'site', title: 'Research', nightShift: { enabled: true } }),
    ).toBeNull();
  });

  it('tells each kind what to do instead of asking', () => {
    expect(unattendedQuestionDecline('review')).toMatch(/in the report/);
    expect(unattendedQuestionDecline('night-fix')).toMatch(/task note/);
  });
});
