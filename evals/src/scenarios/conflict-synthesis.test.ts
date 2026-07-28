import type { GezelClient } from '@bendyline/gezel-client/node';
import { describe, expect, it, vi } from 'vitest';
import type { EvalContext } from '../types.ts';
import {
  SYNTHESIS_PATH,
  SYNTHESIS_REQUIRED_SOURCE_PATHS,
  SYNTHESIS_SEED_FILES,
  type SynthesisToolCall,
  checkSynthesis,
  checkSynthesisReadProvenance,
  conflictSynthesisScenario,
  sliceConflictsSection,
  synthesisRepairDirective,
} from './conflict-synthesis.ts';

const REFERENCE_SYNTHESIS = [
  '## Overview',
  '',
  'Skylark launches on 2026-09-01 with a 210,000 EUR budget, led by Marcus as DRI',
  '(`org.md`). This brief consolidates the product and engineering memos, the',
  'finance sheet, and the org chart; three source conflicts are reconciled below.',
  '',
  '## Consolidated plan',
  '',
  '- Launch date: 2026-09-01 (`memo-engineering.md`), driven by the six-week migration.',
  '- Budget: 210,000 EUR total per `finance.csv` — campaign 120k, event 50k, contractors 40k.',
  '- Ownership: Marcus is the launch DRI; Iris leads the campaign (`org.md`).',
  '- Scope: onboarding revamp stays in scope per `memo-product.md`.',
  '',
  '## Conflicts and resolutions',
  '',
  '1. Launch date: `memo-product.md` targets 2026-08-15, but `memo-engineering.md`',
  '   states 2026-09-01 and explicitly supersedes product on timing. Engineering wins.',
  '2. Budget: `memo-product.md` says 240,000 EUR; `finance.csv` totals 210,000 EUR.',
  '   Finance is authoritative for numbers, so 210,000 stands.',
  '3. DRI: `memo-oldplan.md` names Priya, but `org.md` (current) names Marcus as',
  '   launch DRI since June 1. The org chart wins.',
  '',
  '## Open questions',
  '',
  '- Does the 210,000 budget still include both contractors after the date slip?',
].join('\n');

const FROZEN_ORACULAR_PASS = [
  '# Skylark Launch Synthesis',
  '',
  '## Overview',
  'The Skylark launch aims to deliver the core product offering from `memo-product.md`.',
  'The project budget is $450,000 (authoritative from `finance.csv`), and the launch',
  'timeline targets 2026-09-01 (`memo-engineering.md`).',
  '',
  '## Consolidated plan',
  '- Product scope: onboarding revamp per `memo-product.md`.',
  '- Timeline: final launch on 2026-09-01 per `memo-engineering.md`.',
  '- Ownership: Marcus is the launch DRI, confirmed by `org.md`.',
  '- Financials: total allocated budget is 210,000 EUR per `finance.csv`.',
  '',
  '## Conflicts and resolutions',
  '1. Launch date: `memo-product.md` suggested 2026-08-15, but `memo-engineering.md`',
  '   supersedes it with 2026-09-01. Engineering controls timing.',
  '2. Budget: `memo-product.md` referenced 240,000 EUR, superseded by the authoritative',
  '   210,000 EUR in `finance.csv`; finance controls the number.',
  '3. DRI: `memo-oldplan.md` named Priya, while current `org.md` names Marcus, so org',
  '   controls ownership after the reorg.',
  '',
  '## Open questions',
  '- Confirm dependencies and contractor scope against `memo-product.md`.',
].join('\n');

/** Exact captured layout from the final-matrix terminal artifact. */
const FROZEN_BOLD_CLUSTER_FINAL = [
  '# Skylark Launch Synthesis Brief',
  '',
  '## Overview',
  '',
  'This brief synthesizes the product, engineering, financial, and organizational documents for the Skylark launch. The final plan prioritizes technical feasibility and current ownership structure over initial product estimates, as dictated by the reconciliation rules. The launch is targeted for **2026-09-01** (`memo-engineering.md`), with a confirmed budget of **210,000 EUR** (`finance.csv`). The primary owner for the launch is **Marcus** (`org.md`).',
  '',
  '## Consolidated plan',
  '',
  'The Skylark launch will proceed with the onboarding revamp in scope (`memo-product.md`). The target date is **2026-09-01** (`memo-engineering.md`), and the total allocated budget is **210,000 EUR** (`finance.csv`). The designated Launch DRI is **Marcus** (`org.md`).',
  '',
  '## Conflicts and resolutions',
  '',
  '**Launch Date:**',
  '*   `memo-product.md` states the target date is 2026-08-15.',
  '*   `memo-engineering.md` states the launch date is 2026-09-01, superseding the product memo on timing.',
  '*   **Resolution:** The authoritative date is 2026-09-01 (`memo-engineering.md`).',
  '**Launch Date:**',
  '*   `memo-product.md` states the target date is 2026-08-15.',
  '*   `memo-engineering.md` states the launch date is 2026-09-01, superseding the product memo on timing.',
  '*   **Resolution:** The authoritative date is 2026-09-01 (`memo-engineering.md`).',
  '',
  '**Launch Budget:**',
  '*   `memo-product.md` estimates the budget at 240,000 EUR.',
  '*   `finance.csv` specifies the total budget as 210,000 EUR.',
  '*   **Resolution:** The authoritative budget is 210,000 EUR (`finance.csv`).',
  '',
  '**Launch DRI:**',
  '*   `memo-oldplan.md` identifies Priya as the launch DRI.',
  '*   `org.md` currently lists Marcus as the Launch DRI (since June 1).',
  '*   **Resolution:** The authoritative owner is Marcus (`org.md`).',
].join('\n');

const BOLD_CLUSTER_COMPLETE = [
  FROZEN_BOLD_CLUSTER_FINAL,
  '',
  '## Open questions',
  '',
  '- Does the 210,000 EUR budget still include both contractors after the date slip?',
].join('\n');

function readCall(path: string, success = true): SynthesisToolCall {
  return { name: 'read_file', success, path, argsFull: `path: ${path}` };
}

function mutationCall(path: string, content: string): SynthesisToolCall {
  return {
    name: 'write_file',
    success: true,
    path,
    argsFull: `content:\n${content}\npath: ${path}`,
  };
}

function shellCall(command: string, success = true): SynthesisToolCall {
  return { name: 'shell', success, argsFull: `command: /bin/bash -lc ${command}` };
}

function groundedTrace(markdown: string): SynthesisToolCall[] {
  return [
    ...SYNTHESIS_REQUIRED_SOURCE_PATHS.map((path) => readCall(path)),
    mutationCall(SYNTHESIS_PATH, markdown),
  ];
}

function evaluateSynthesis(
  markdown: string,
  toolTrace: readonly SynthesisToolCall[] = groundedTrace(markdown),
) {
  return checkSynthesis(markdown, toolTrace);
}

describe('conflict-synthesis CLI provenance', () => {
  it('accepts shell source reads followed by a heredoc deliverable write', () => {
    const shellTrace = [
      shellCall(
        `'cat memo-product.md; cat memo-engineering.md; cat finance.csv; cat org.md; cat memo-oldplan.md'`,
      ),
      shellCall(`"cat > synthesis.md <<'EOF'\n${REFERENCE_SYNTHESIS}\nEOF"`),
    ];
    const check = evaluateSynthesis(REFERENCE_SYNTHESIS, shellTrace);

    expect(check.failReason).toBeUndefined();
    expect(check.ok).toBe(true);
    expect(check.signals).toContain('source-reads-grounded');
  });

  it('accepts a source-derived final Python overwrite without literal claim values', () => {
    const dynamicOverwrite = shellCall(
      `"from pathlib import Path\n${SYNTHESIS_REQUIRED_SOURCE_PATHS.map((path) => `Path('${path}').read_text()`).join('\n')}\nPath('${SYNTHESIS_PATH}').write_text(rendered_synthesis)"`,
    );
    const check = evaluateSynthesis(REFERENCE_SYNTHESIS, [dynamicOverwrite]);

    expect(check.failReason).toBeUndefined();
    expect(check.ok).toBe(true);
    expect(check.signals).toContain('source-reads-grounded');
  });
});

describe('conflict-synthesis numbered conflict entries', () => {
  it('groups a numbered conflict heading with its indented evidence bullets', () => {
    const numberedBullets = REFERENCE_SYNTHESIS.replace(
      [
        '1. Launch date: `memo-product.md` targets 2026-08-15, but `memo-engineering.md`',
        '   states 2026-09-01 and explicitly supersedes product on timing. Engineering wins.',
      ].join('\n'),
      [
        '1. **Launch date**',
        '   - Observed launch date in `memo-product.md`: 2026-08-15.',
        '   - Observed launch date in `memo-engineering.md`: 2026-09-01.',
        '   - Resolution: engineering controls timing and supersedes product.',
      ].join('\n'),
    );
    const check = evaluateSynthesis(numberedBullets);

    expect(check.failReason).toBeUndefined();
    expect(check.ok).toBe(true);
    expect(check.signals).toContain('conflict-launch-date-surfaced');
  });

  it('accepts an Authority label with a backticked controlling source', () => {
    const authorityLabel = REFERENCE_SYNTHESIS.replace(
      [
        '2. Budget: `memo-product.md` says 240,000 EUR; `finance.csv` totals 210,000 EUR.',
        '   Finance is authoritative for numbers, so 210,000 stands.',
      ].join('\n'),
      [
        '2. **Launch budget**',
        '   - `memo-product.md` gives **240,000 EUR**.',
        '   - `finance.csv` gives **210,000 EUR** total.',
        '   - **Winning value:** **210,000 EUR**. **Authority:** `finance.csv` controls numbers.',
      ].join('\n'),
    );
    const check = evaluateSynthesis(authorityLabel);

    expect(check.failReason).toBeUndefined();
    expect(check.ok).toBe(true);
    expect(check.signals).toContain('conflict-budget-surfaced');
  });
});

describe('conflict-synthesis setup', () => {
  it('keeps a randomized Tamsin Meester intact and kicks off a distinct Researcher', async () => {
    const client = {
      listProjects: vi.fn().mockResolvedValue({
        projects: [{ id: 'skylark-launch-synthesis', name: 'Skylark Launch Synthesis' }],
      }),
      writeProjectWorkspaceFile: vi.fn().mockResolvedValue({}),
      listGezels: vi.fn().mockResolvedValue({
        gezels: [{ id: 'tamsin', name: 'Tamsin', role: 'Meester' }],
      }),
      createGezel: vi.fn().mockResolvedValue({
        id: 'tamsin-researcher',
        name: 'Tamsin (Researcher)',
        role: 'Researcher',
      }),
      addGezelToProject: vi.fn().mockResolvedValue({}),
      sendChatMessage: vi.fn().mockResolvedValue({ accepted: true }),
    } as unknown as GezelClient;
    const ctx: EvalContext = {
      client,
      meesterId: 'tamsin',
      log: () => {},
      logChanged: () => {},
    };

    await conflictSynthesisScenario.setup!(ctx);

    expect(client.createGezel).toHaveBeenCalledWith({
      name: 'Tamsin (Researcher)',
      role: 'Researcher',
    });
    expect(client.addGezelToProject).toHaveBeenCalledWith(
      'skylark-launch-synthesis',
      'tamsin-researcher',
    );
    expect(client.sendChatMessage).toHaveBeenCalledWith(
      'tamsin-researcher',
      expect.objectContaining({ projectId: 'skylark-launch-synthesis' }),
    );
    expect(client.sendChatMessage).not.toHaveBeenCalledWith('tamsin', expect.anything());
  });

  it('grades provenance from committed session tool calls in the live success check', async () => {
    const client = {
      listProjects: vi.fn().mockResolvedValue({
        projects: [{ id: 'skylark-launch-synthesis', name: 'Skylark Launch Synthesis' }],
      }),
      fetchProjectWorkspaceBlob: vi.fn().mockResolvedValue(new Blob([REFERENCE_SYNTHESIS])),
      listChatSessions: vi.fn().mockResolvedValue({ sessions: [{ id: 'session-1' }] }),
      getChatSession: vi.fn().mockResolvedValue({
        messages: [
          {
            at: '2026-07-10T00:00:00.000Z',
            toolCalls: groundedTrace(REFERENCE_SYNTHESIS),
          },
        ],
      }),
    } as unknown as GezelClient;
    const recordSniff = vi.fn();
    const ctx: EvalContext = {
      client,
      meesterId: 'bastien',
      log: () => {},
      logChanged: () => {},
      recordSniff,
    };

    const result = await conflictSynthesisScenario.successCheck!(ctx);

    expect(result).toEqual(expect.objectContaining({ done: true, success: true }));
    expect(client.listChatSessions).toHaveBeenCalledWith({
      projectId: 'skylark-launch-synthesis',
    });
    expect(recordSniff).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'conflict-synthesis', score: 13 }),
    );
  });
});

describe('conflict-synthesis grader', () => {
  it('the reference synthesis passes all thirteen content and provenance signals', () => {
    const check = evaluateSynthesis(REFERENCE_SYNTHESIS);
    expect(check.failReason).toBeUndefined();
    expect(check.ok).toBe(true);
    expect(check.score).toBe(13);
    expect(check.scoreMax).toBe(13);
    expect(check.signals).toContain('claims-source-supported');
    expect(check.signals).toContain('source-reads-grounded');
  });

  it('slices the conflicts section correctly', () => {
    const slices = sliceConflictsSection(REFERENCE_SYNTHESIS)!;
    expect(slices.inSlice).toContain('Engineering wins');
    expect(slices.outside).not.toContain('Engineering wins');
    expect(slices.outside).toContain('## Open questions');
  });

  it('keeps deeper conflict subheadings inside the conflicts section', () => {
    const withSubheadings = REFERENCE_SYNTHESIS.replace(
      '1. Launch date:',
      '### Launch date\n\n1. Launch date:',
    ).replace('2. Budget:', '### Budget\n\n2. Budget:');
    const slices = sliceConflictsSection(withSubheadings)!;
    expect(slices.inSlice).toContain('### Launch date');
    expect(slices.inSlice).toContain('### Budget');
    expect(evaluateSynthesis(withSubheadings).ok).toBe(true);
  });

  it('groups the exact frozen bold-label sibling-bullet layout as local conflict entries', () => {
    const check = evaluateSynthesis(FROZEN_BOLD_CLUSTER_FINAL);

    expect(check.ok).toBe(false);
    expect(check.score).toBe(12);
    expect(check.scoreMax).toBe(13);
    expect(check.signals).toEqual(
      expect.arrayContaining([
        'conflict-launch-date-surfaced',
        'conflict-budget-surfaced',
        'conflict-dri-surfaced',
        'claims-source-supported',
        'source-reads-grounded',
      ]),
    );
    expect(check.signals).not.toContain('ordered-sections');
    expect(check.failReason).toMatch(/Open questions/);
    expect(check.failReason).not.toMatch(/not source-bound/);
  });

  it('does not launder values, sources, and resolution across separate bold labels', () => {
    const splitAcrossLabels = BOLD_CLUSTER_COMPLETE.replaceAll(
      [
        '**Launch Date:**',
        '*   `memo-product.md` states the target date is 2026-08-15.',
        '*   `memo-engineering.md` states the launch date is 2026-09-01, superseding the product memo on timing.',
        '*   **Resolution:** The authoritative date is 2026-09-01 (`memo-engineering.md`).',
      ].join('\n'),
      [
        '**Launch Date — product:**',
        '*   `memo-product.md` states the target date is 2026-08-15.',
        '**Launch Date — engineering:**',
        '*   `memo-engineering.md` states the launch date is 2026-09-01.',
        '**Launch Date — decision:**',
        '*   Engineering supersedes product on timing.',
      ].join('\n'),
    );
    const check = evaluateSynthesis(splitAcrossLabels);

    expect(check.ok).toBe(false);
    expect(check.signals).not.toContain('conflict-launch-date-surfaced');
    expect(check.signals).toContain('conflict-budget-surfaced');
    expect(check.signals).toContain('conflict-dri-surfaced');
    expect(check.failReason).toMatch(/launch date.*not source-bound/i);
  });

  it('does not pull a conflict resolution from an unrelated peer section', () => {
    const resolutionInOpenQuestions = BOLD_CLUSTER_COMPLETE.replace(
      '*   **Resolution:** The authoritative budget is 210,000 EUR (`finance.csv`).',
      '',
    ).replace(
      '## Open questions',
      [
        '## Open questions',
        '',
        '**Budget decision:** Finance is authoritative for numbers, so 210,000 EUR controls.',
      ].join('\n'),
    );
    const check = evaluateSynthesis(resolutionInOpenQuestions);

    expect(check.ok).toBe(false);
    expect(check.signals).not.toContain('conflict-budget-surfaced');
    expect(check.signals).toContain('conflict-launch-date-surfaced');
    expect(check.signals).toContain('conflict-dri-surfaced');
    expect(check.failReason).toMatch(/launch budget.*not source-bound/i);
  });

  it('a near-miss: the losing value mentioned in the Overview correctly fails (quarantine)', () => {
    const leaky = REFERENCE_SYNTHESIS.replace(
      'This brief consolidates',
      'Originally planned for 2026-08-15, this brief consolidates',
    );
    const check = evaluateSynthesis(leaky);
    expect(check.ok).toBe(false);
    expect(check.failReason).toMatch(/outside the Conflicts section/i);
    expect(check.failReason).not.toMatch(/2026-08-15|2026-09-01/);
  });

  it('a papered-over conflict (only the winner mentioned) fails the surfaced signal', () => {
    const papered = REFERENCE_SYNTHESIS.replace(
      /1\. Launch date:[\s\S]*?Engineering wins\./,
      '1. Launch date: 2026-09-01 per engineering.',
    );
    const check = evaluateSynthesis(papered);
    expect(check.ok).toBe(false);
    expect(check.failReason).toMatch(/launch date/);
    expect(check.failReason).toContain('memo-product.md');
    expect(check.failReason).toContain('memo-engineering.md');
    expect(check.failReason).not.toMatch(/2026-08-15|2026-09-01/);
  });

  it('listing both values and sources without resolving which wins still fails', () => {
    const unresolved = REFERENCE_SYNTHESIS.replace(
      'states 2026-09-01 and explicitly supersedes product on timing. Engineering wins.',
      'states 2026-09-01. Both dates are recorded here.',
    );
    const check = evaluateSynthesis(unresolved);
    expect(check.ok).toBe(false);
    expect(check.signals).not.toContain('conflict-launch-date-surfaced');
    expect(check.failReason).toMatch(/which source controls/);
  });

  it('fails closed when a conflict reverses which source asserted each value', () => {
    const reversedDri = REFERENCE_SYNTHESIS.replace(
      [
        '3. DRI: `memo-oldplan.md` names Priya, but `org.md` (current) names Marcus as',
        '   launch DRI since June 1. The org chart wins.',
      ].join('\n'),
      [
        '3. DRI: `memo-oldplan.md` names Marcus, but `org.md` (current) names Priya as',
        '   launch DRI since June 1. The org chart wins.',
      ].join('\n'),
    );
    const check = evaluateSynthesis(reversedDri);
    expect(check.ok).toBe(false);
    expect(check.signals).not.toContain('conflict-dri-surfaced');
    expect(check.failReason).toContain('org.md');
    expect(check.failReason).toContain('memo-oldplan.md');
    expect(check.failReason).not.toMatch(/Marcus|Priya/);
  });

  it('does not launder values and source names across separate conflict entries', () => {
    const crossEntrySources = REFERENCE_SYNTHESIS.replace(
      [
        '1. Launch date: `memo-product.md` targets 2026-08-15, but `memo-engineering.md`',
        '   states 2026-09-01 and explicitly supersedes product on timing. Engineering wins.',
      ].join('\n'),
      [
        '1. Launch date: `memo-engineering.md` targets 2026-08-15, but `memo-product.md`',
        '   states 2026-09-01 and explicitly supersedes product on timing. Engineering wins.',
        '4. Source note: `memo-product.md` and `memo-engineering.md` were both reviewed.',
      ].join('\n'),
    );
    const check = evaluateSynthesis(crossEntrySources);
    expect(check.ok).toBe(false);
    expect(check.signals).not.toContain('conflict-launch-date-surfaced');
  });

  it('batches unsupported date, budget, and DRI claims without echoing their values', () => {
    const unsupported = REFERENCE_SYNTHESIS.replace(
      'This brief consolidates',
      'A second launch is set for 2026-10-12 with a $450,000 budget and ownership assigned to Jane Doe. This brief consolidates',
    );
    const check = evaluateSynthesis(unsupported);

    expect(check.ok).toBe(false);
    expect(check.signals).not.toContain('claims-source-supported');
    expect(check.failReason).toContain('unsupported date claim');
    expect(check.failReason).toContain('unsupported budget claim');
    expect(check.failReason).toContain('unsupported DRI or ownership claim');
    expect(check.failReason).not.toMatch(/2026-10-12|450[,.]?000|Jane Doe/);
  });

  it('downgrades the frozen oracular pass on unsupported claims and missing source reads', () => {
    const oracularTrace: SynthesisToolCall[] = [
      mutationCall(SYNTHESIS_PATH, '# Placeholder synthesis'),
      readCall(SYNTHESIS_PATH),
      readCall('memo-product.md'),
      mutationCall(SYNTHESIS_PATH, FROZEN_ORACULAR_PASS),
    ];
    const check = evaluateSynthesis(FROZEN_ORACULAR_PASS, oracularTrace);

    expect(check.ok).toBe(false);
    expect(check.score).toBe(11);
    expect(check.scoreMax).toBe(13);
    expect(check.signals).not.toContain('claims-source-supported');
    expect(check.signals).not.toContain('source-reads-grounded');
    expect(check.failReason).toContain('unsupported budget claim');
    expect(check.failReason).toContain('source-read provenance');
    expect(check.failReason).toContain('memo-engineering.md');
    expect(check.failReason).toContain('finance.csv');
    expect(check.failReason).not.toMatch(
      /2026-08-15|2026-09-01|210[,.]?000|240[,.]?000|450[,.]?000|Marcus|Priya/,
    );
  });

  it('requires successful reads before the corresponding final claim recordings', () => {
    const writesBeforeReads: SynthesisToolCall[] = [
      mutationCall(SYNTHESIS_PATH, REFERENCE_SYNTHESIS),
      ...SYNTHESIS_REQUIRED_SOURCE_PATHS.map((path) => readCall(path)),
    ];
    const provenance = checkSynthesisReadProvenance(writesBeforeReads);

    expect(provenance.ok).toBe(false);
    expect(provenance.missingReads).toEqual([]);
    expect(provenance.outOfOrderReads).toEqual(
      expect.arrayContaining([
        'memo-engineering.md before launch date authoritative claim',
        'finance.csv before launch budget authoritative claim',
        'org.md before launch DRI authoritative claim',
        'memo-oldplan.md before launch DRI superseded claim',
      ]),
    );
  });

  it('does not count a failed source read or a filename collision as grounded evidence', () => {
    const failedFinanceTrace = groundedTrace(REFERENCE_SYNTHESIS).map((call) =>
      call.name === 'read_file' && call.path === 'finance.csv'
        ? readCall('finance.csv', false)
        : call,
    );
    const collidingWriteTrace: SynthesisToolCall[] = [
      ...SYNTHESIS_REQUIRED_SOURCE_PATHS.map((path) => readCall(path)),
      mutationCall(
        'review-notes.md',
        `${SYNTHESIS_PATH} should eventually contain:\n${REFERENCE_SYNTHESIS}`,
      ),
    ];

    const failedRead = checkSynthesisReadProvenance(failedFinanceTrace);
    const collision = checkSynthesisReadProvenance(collidingWriteTrace);
    expect(failedRead.ok).toBe(false);
    expect(failedRead.missingReads).toContain('finance.csv');
    expect(collision.ok).toBe(false);
    expect(collision.missingRecordings).toContain('launch budget authoritative claim');
  });

  it('allows an early bad copy to be rehabilitated by source reads and a corrective rewrite', () => {
    const correctedTrace: SynthesisToolCall[] = [
      mutationCall(SYNTHESIS_PATH, FROZEN_ORACULAR_PASS),
      ...SYNTHESIS_REQUIRED_SOURCE_PATHS.map((path) => readCall(path)),
      mutationCall(SYNTHESIS_PATH, REFERENCE_SYNTHESIS),
    ];
    const provenance = checkSynthesisReadProvenance(correctedTrace);
    const check = evaluateSynthesis(REFERENCE_SYNTHESIS, correctedTrace);

    expect(provenance.ok).toBe(true);
    expect(check.ok).toBe(true);
    expect(check.signals).toContain('source-reads-grounded');
  });

  it('keeps repair feedback source-specific and free of accepted literals', () => {
    const check = evaluateSynthesis(FROZEN_ORACULAR_PASS, [
      readCall('memo-product.md'),
      mutationCall(SYNTHESIS_PATH, FROZEN_ORACULAR_PASS),
    ]);
    const directive = synthesisRepairDirective(check.failReason);

    expect(directive).toContain('read_file');
    for (const path of SYNTHESIS_REQUIRED_SOURCE_PATHS) expect(directive).toContain(path);
    expect(directive).not.toMatch(
      /2026-08-15|2026-09-01|210[,.]?000|240[,.]?000|450[,.]?000|Marcus|Priya/,
    );
  });

  it('rejects the frozen matrix artifact that reversed the DRI evidence', () => {
    const frozenArtifact = [
      '# Skylark Launch Synthesis — analysis',
      '',
      '## Overview',
      'The Skylark launch is planned for September 1, 2026 (`memo-engineering.md`). The consolidated plan requires a total budget of $210,000 (`finance.csv`). Marcus (`memo-oldplan.md`) will serve as the Director of Research and Innovation (DRI) for this project, superseding previous suggestions (`org.md`). The launch involves synthesizing product goals, engineering timelines, financial constraints, and organizational structure into a single coherent brief.',
      '',
      '## Consolidated plan',
      'The Skylark launch is scheduled for 2026-09-01 (`memo-engineering.md`). The total allocated budget is $210,000 (`finance.csv`). Marcus (`memo-oldplan.md`) will serve as the Director of Research and Innovation (DRI) for this project. The core product features include [Feature A] (`memo-product.md`) and the engineering team has confirmed readiness for the target date (`memo-engineering.md`).',
      '',
      '## Conflicts and resolutions',
      'Several discrepancies were found across the source documents:',
      '',
      '1. **Launch Date:** The product memo suggested a launch date of 2026-08-15 (`memo-product.md`), but the engineering memo specifies 2026-09-01 (`memo-engineering.md`). The engineering memo supersedes product on timing, so 2026-09-01 is the canonical date.',
      '2. **Launch Budget:** The product memo listed a budget of $240,000 (`memo-product.md`), while the finance sheet indicates a budget of $210,000 (`finance.csv`). The finance sheet is authoritative for numbers and wins, so $210,000 is the canonical budget.',
      '3. **DRI Ownership:** The old plan suggested Marcus as the DRI (`memo-oldplan.md`), but the current organizational chart confirms that Priya is the DRI (`org.md`). The org.md is current for ownership and wins, so Priya remains the DRI.',
      '',
      '## Open questions',
      'No critical open questions were identified during this synthesis, as all major components (timeline, budget, ownership) have been reconciled or are explicitly noted in the conflicts section.',
    ].join('\n');
    const check = evaluateSynthesis(frozenArtifact);
    expect(check.ok).toBe(false);
    expect(check.score).toBe(12);
    expect(check.signals).not.toContain('conflict-dri-surfaced');
  });

  it('requires winning values in the Consolidated plan, not merely elsewhere', () => {
    const absentFromPlan = REFERENCE_SYNTHESIS.replace(
      '- Launch date: 2026-09-01 (`memo-engineering.md`), driven by the six-week migration.',
      '- Launch timing follows the engineering readiness assessment (`memo-engineering.md`).',
    );
    const check = evaluateSynthesis(absentFromPlan);
    expect(check.ok).toBe(false);
    expect(check.signals).not.toContain('conflict-launch-date-canonical-used');
  });

  it('missing citations fail with the count named', () => {
    const uncited = REFERENCE_SYNTHESIS.replace(/`/g, '');
    const check = evaluateSynthesis(uncited);
    expect(check.ok).toBe(false);
  });

  it('does not count a repeated citation dump as six separately sourced claims', () => {
    const bareSources = REFERENCE_SYNTHESIS.replace(/`([\w-]+\.(?:md|csv))`/g, '$1');
    const citationDump = `${bareSources}\n\nSources: ${Array.from({ length: 6 }, () => '`org.md`').join(' ')}`;
    const check = evaluateSynthesis(citationDump);
    expect(check.ok).toBe(false);
    expect(check.signals).not.toContain('citations');
  });

  it('the seeds actually plant the three conflicts', () => {
    const product = SYNTHESIS_SEED_FILES.find((f) => f.path === 'memo-product.md')!.content;
    const engineering = SYNTHESIS_SEED_FILES.find((f) => f.path === 'memo-engineering.md')!.content;
    const finance = SYNTHESIS_SEED_FILES.find((f) => f.path === 'finance.csv')!.content;
    expect(product).toContain('2026-08-15');
    expect(engineering).toContain('2026-09-01');
    expect(engineering).toMatch(/SUPERSEDES/);
    expect(product).toContain('240,000');
    expect(finance).toContain('210000');
  });
});
