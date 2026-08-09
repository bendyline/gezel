import { describe, expect, it } from 'vitest';
import { checkMeetingFollowup } from './meeting-followup.ts';

const VALID_BRIEF = `# Orchid launch follow-up

## Decisions

Launch phase one on 2026-09-14 for EU only. Use one overnight batch; the rolling migration proposal was rejected.

## Action items

Morgan publishes the field map, then Priya runs the dry-run. Luis drafts customer communications. Jordan schedules the annual-plan review.

## Open questions

The annual plan is not decided and remains open. Rollback communications has no owner and remains TBD.

## Risks and dependencies

Priya's work depends on Morgan's field map. Legal review is unscheduled and remains a launch risk.
`;

const VALID_CSV = `id,owner,action,due_date,depends_on,status
A1,Morgan Ivers,Publish billing export field map,2026-08-29,,todo
A2,Priya Raman,Run migration dry-run,2026-09-02,A1,todo
A3,Luis Ortega,Draft status-page and customer-email copy,2026-09-03,,todo
A4,Jordan Lee,Schedule annual-plan decision review,2026-08-30,,todo
`;

describe('meeting follow-up grader', () => {
  it('accepts the authoritative brief and exact action register', () => {
    const result = checkMeetingFollowup(VALID_BRIEF, VALID_CSV);
    expect(result.ok).toBe(true);
    expect(result.score).toBe(result.scoreMax);
  });

  it('rejects a lost dependency and names only the offending row', () => {
    const result = checkMeetingFollowup(
      VALID_BRIEF,
      VALID_CSV.replace('2026-09-02,A1,todo', '2026-09-02,,todo'),
    );
    expect(result.ok).toBe(false);
    expect(result.failReason).toMatch(/row A2 is wrong: depends_on/i);
    expect(result.missingRequiredSignals).toEqual(['action-row-a2']);
    expect(result.repairArtifact).toBe('csv');
  });

  it('gives per-row credit instead of collapsing the register to one gate', () => {
    const threeGood = VALID_CSV.replace(
      'A4,Jordan Lee,Schedule annual-plan decision review,2026-08-30,,todo',
      'A4,Casey Nobody,Something else,2026-12-01,,todo',
    );
    const allBad = VALID_CSV.split('\n')
      .map((line, index) => (index === 0 ? line : line.replace(/,todo$/, ',done')))
      .join('\n');
    expect(checkMeetingFollowup(VALID_BRIEF, threeGood).score).toBeGreaterThan(
      checkMeetingFollowup(VALID_BRIEF, allBad).score,
    );
  });

  it('accepts conventional empty-dependency fillers', () => {
    for (const filler of ['-', '—', 'none', 'N/A']) {
      const csv = VALID_CSV.replace(
        'field map,2026-08-29,,todo',
        `field map,2026-08-29,${filler},todo`,
      );
      expect(checkMeetingFollowup(VALID_BRIEF, csv).ok, filler).toBe(true);
    }
  });

  it('accepts a roster name the model retyped in a different case', () => {
    const result = checkMeetingFollowup(
      VALID_BRIEF,
      VALID_CSV.replace('Morgan Ivers', 'morgan ivers'),
    );
    expect(result.ok).toBe(true);
  });

  it('routes repair to the brief when the brief is what is broken', () => {
    const result = checkMeetingFollowup(
      VALID_BRIEF.replace('## Decisions', '## Outcomes'),
      VALID_CSV,
    );
    expect(result.ok).toBe(false);
    expect(result.repairArtifact).toBe('brief');
  });

  it('routes repair to the CSV even when a brief gate also fails later', () => {
    // Regression: the old heuristic grepped the failure message and, because
    // brief checks run first, could never steer at the CSV.
    const brokenBoth = checkMeetingFollowup(
      VALID_BRIEF.replace('Legal review is unscheduled and remains a launch risk.', ''),
      VALID_CSV.replace(
        'id,owner,action,due_date,depends_on,status',
        'id,owner,task,due,dep,state',
      ),
    );
    expect(brokenBoth.missingRequiredSignals).toContain('csv-header');
    expect(brokenBoth.missingRequiredSignals).toContain('legal-risk');
    expect(brokenBoth.repairArtifact).toBe('brief');
    // …and once the brief is clean, the CSV becomes the target.
    const csvOnly = checkMeetingFollowup(
      VALID_BRIEF,
      VALID_CSV.replace(
        'id,owner,action,due_date,depends_on,status',
        'id,owner,task,due,dep,state',
      ),
    );
    expect(csvOnly.repairArtifact).toBe('csv');
  });

  it('rejects the stale launch date as a current decision', () => {
    const result = checkMeetingFollowup(VALID_BRIEF.replace('2026-09-14', '2026-09-07'), VALID_CSV);
    expect(result.ok).toBe(false);
    expect(result.missingRequiredSignals).toContain('launch-decision');
  });

  it('allows stale proposals to be named when they are explicitly rejected', () => {
    const result = checkMeetingFollowup(
      VALID_BRIEF.replace(
        'Launch phase one',
        'The stale September 7 and global-launch proposals were rejected. Launch phase one',
      ),
      VALID_CSV,
    );
    expect(result.ok).toBe(true);
  });
});
