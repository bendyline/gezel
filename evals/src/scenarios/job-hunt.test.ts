import { describe, expect, it } from 'vitest';
import { checkPipelineTracked } from './job-hunt.js';

/**
 * Winnable-grader guard: the verdict passes on a conforming pipeline
 * document (what the application-store script writes) and fails on the
 * seeded empty state — without a daemon.
 */

const SEEDED = {
  version: 1,
  role: 'Staff Engineer',
  stages: ['applied', 'screening', 'interview', 'offer', 'closed'],
  records: [],
};

const TRACKED = {
  ...SEEDED,
  records: [
    {
      id: 'acme-staff-engineer',
      status: 'applied',
      fields: { company: 'Acme', role: 'Staff Engineer' },
      createdAt: '2026-07-18T10:00:00.000Z',
      updatedAt: '2026-07-18T10:00:00.000Z',
      history: [{ at: '2026-07-18T10:00:00.000Z', from: null, to: 'applied' }],
    },
  ],
};

const ACTIVITY = {
  version: 1,
  events: [
    {
      at: '2026-07-18T10:00:00.000Z',
      kind: 'applied',
      note: 'Applied to Acme for Staff Engineer.',
      data: { applicationId: 'acme-staff-engineer' },
    },
  ],
};

describe('job-hunt grader', () => {
  it('fails the seeded empty pipeline', () => {
    const verdict = checkPipelineTracked(SEEDED, { version: 1, events: [] });
    expect(verdict.ok).toBe(false);
    expect(verdict.failReason).toContain('no records');
  });

  it('fails when records exist but none names Acme', () => {
    const verdict = checkPipelineTracked(
      {
        ...SEEDED,
        records: [{ id: 'x', status: 'applied', fields: { company: 'Globex' } }],
      },
      ACTIVITY,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.failReason).toContain('Acme');
  });

  it('passes a conforming tracked pipeline with all signals', () => {
    const verdict = checkPipelineTracked(TRACKED, ACTIVITY);
    expect(verdict.ok).toBe(true);
    expect(verdict.signals).toEqual(['application-recorded', 'stage-valid', 'event-logged']);
  });

  it('tolerates missing activity (optional signal only)', () => {
    const verdict = checkPipelineTracked(TRACKED, null);
    expect(verdict.ok).toBe(true);
    expect(verdict.signals).toContain('application-recorded');
    expect(verdict.signals).not.toContain('event-logged');
  });

  it('survives malformed documents without throwing', () => {
    expect(checkPipelineTracked(null, null).ok).toBe(false);
    expect(checkPipelineTracked({ records: 'nope' } as never, {} as never).ok).toBe(false);
  });
});
