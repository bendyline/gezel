import { describe, expect, it } from 'vitest';
import {
  CraftbookStepSchema,
  GateCheckSchema,
  GateScriptResultSchema,
  StepGateUnionSchema,
  gateEdgeTargets,
  isLegacyGateSpec,
  normalizeStepGate,
  removeStepAndCleanEdges,
  requiredOutputMediaForGate,
  validateCraftbookGraph,
} from './index.js';

describe('GateCheckSchema — connector coverage', () => {
  it('parses a workspace ledger against an artifact corpus', () => {
    expect(
      GateCheckSchema.parse({
        kind: 'corpusCoverage',
        file: 'pr-review-coverage.json',
        corpusDir: 'artifacts/data/github-pulls/pr-52',
      }),
    ).toMatchObject({ kind: 'corpusCoverage' });
  });

  it('keeps the artifact flag on every check whose evaluator can honor it', () => {
    // Zod strips undeclared keys, so a variant that forgets `artifact`
    // does not reject the craftbook — it silently drops the flag and the
    // gate then reads the wrong tree. That is how Pull Request Review's
    // coverage ledger, authored `artifact: true`, was judged as a
    // workspace deliverable and paused every writes-off project.
    const flagged = [
      { kind: 'corpusCoverage', file: 'c.json', corpusDir: 'artifacts/data/pr-46' },
      { kind: 'totalMinBytes', files: ['a.md', 'b.md'], bytes: 10 },
      { kind: 'fileCount', ext: ['png'], min: 1 },
      { kind: 'cssMinBytes', bytes: 10 },
      { kind: 'jsonPathEquals', file: 'a.json', path: 'a.b', value: 1 },
      { kind: 'csvShape', file: 'a.csv', minRows: 1 },
      {
        kind: 'unsupportedClaims',
        file: 'a.md',
        sourceFiles: ['b.md'],
        patterns: [{ pattern: 'best' }],
      },
      { kind: 'jsParses', file: 'a.html' },
      { kind: 'htmlLint', file: 'a.html' },
      { kind: 'esmImports', file: 'a.mjs' },
      { kind: 'sourceParses', file: 'a.ts' },
      { kind: 'markdownHeadingsMatch', file: 'a.md', outlineFile: 'o.md' },
    ];
    for (const check of flagged) {
      expect(GateCheckSchema.parse({ ...check, artifact: true })).toMatchObject({ artifact: true });
    }
  });

  it('does NOT accept artifact on nodeRuns — the sandbox only runs the workspace', () => {
    // The one file-reading check that bypasses the swappable gate reader:
    // it hands the path to the sandbox executor. Accepting the flag would
    // parse cleanly and then execute the wrong tree.
    expect(
      GateCheckSchema.parse({ kind: 'nodeRuns', file: 'test.mjs', artifact: true }),
    ).not.toHaveProperty('artifact');
  });
});

describe('requiredOutputMediaForGate', () => {
  it('derives task-note output from the gate script that inspects task notes', () => {
    expect([
      ...requiredOutputMediaForGate({
        at: 'completion',
        scripts: [{ name: 'checkTaskNoteContains', scope: 'standard' }],
      }),
    ]).toEqual(['task-note']);
  });

  it('does not infer an output surface from unrelated, project-local, or legacy gates', () => {
    expect([
      ...requiredOutputMediaForGate({
        at: 'completion',
        scripts: [{ name: 'checkJsonShape', scope: 'standard' }],
      }),
    ]).toEqual([]);
    expect([
      ...requiredOutputMediaForGate({
        at: 'completion',
        scripts: [{ name: 'checkTaskNoteContains', scope: 'project' }],
      }),
    ]).toEqual([]);
    expect([
      ...requiredOutputMediaForGate({
        checks: [{ kind: 'minBytes', file: 'report.md', bytes: 10 }],
      }),
    ]).toEqual([]);
  });
});

describe('TaskCraftbookStepSchema — plateau-trail back-compat', () => {
  it('parses persisted steps without the new escalation fields, and with them', async () => {
    const { TaskCraftbookStepSchema } = await import('./task.js');
    const legacy = TaskCraftbookStepSchema.parse({
      id: 'build',
      name: 'Build',
      createdAt: '2026-06-01T00:00:00.000Z',
      gateAttempts: 2,
      lastGateReject: {
        messageFingerprint: 'abc',
        message: '- index.html is 40 bytes, need ≥ 100',
        at: '2026-06-01T00:05:00.000Z',
      },
    });
    expect(legacy.gateAttemptHistory).toBeUndefined();

    const withTrail = TaskCraftbookStepSchema.parse({
      id: 'build',
      name: 'Build',
      createdAt: '2026-06-01T00:00:00.000Z',
      gateAttemptHistory: [
        {
          at: '2026-06-01T00:05:00.000Z',
          attempt: 1,
          signatureHash: 'deadbeef',
          messageFingerprint: 'abc',
          failedChecks: ['minBytes index.html'],
          frozen: true,
        },
      ],
    });
    expect(withTrail.gateAttemptHistory).toHaveLength(1);
  });
});

describe('research and Markdown-outline gate checks', () => {
  it('parses observable research evidence and locked-heading checks', () => {
    const step = CraftbookStepSchema.parse({
      id: 'research',
      name: 'Research',
      suggestedRole: 'researcher',
      gate: {
        at: 'completion',
        checks: [
          {
            kind: 'researchEvidence',
            sourcePath: '',
            tools: ['wikipedia_search', 'fetch_url', 'browser_navigate'],
            minSuccessful: 1,
            externalOptional: true,
          },
          {
            kind: 'markdownHeadingsMatch',
            file: 'deck.md',
            outlineFile: 'notes/outline.md',
          },
        ],
      },
    });
    expect(step.gate).toBeDefined();
    expect(step.gate?.checks?.[0]).toMatchObject({ externalOptional: true });
  });
});

describe('GateCheckSchema — grounding kinds', () => {
  it('accepts the in-process HTML lint gate', () => {
    expect(GateCheckSchema.parse({ kind: 'htmlLint', file: 'index.html' })).toEqual({
      kind: 'htmlLint',
      file: 'index.html',
    });
  });

  it('parses citationsResolve with and without options', () => {
    expect(GateCheckSchema.parse({ kind: 'citationsResolve', file: 'review.md' })).toMatchObject({
      kind: 'citationsResolve',
    });
    expect(
      GateCheckSchema.parse({
        kind: 'citationsResolve',
        file: 'review.md',
        minCitations: 3,
        corpus: ['docs/a.md', 'https://example.com/spec'],
        artifact: true,
      }),
    ).toMatchObject({ minCitations: 3 });
    expect(() =>
      GateCheckSchema.parse({ kind: 'citationsResolve', file: 'review.md', corpus: [] }),
    ).toThrow();
  });

  it('parses valueGrounding facts and rejects empty required lists', () => {
    expect(
      GateCheckSchema.parse({
        kind: 'valueGrounding',
        file: 'brief.md',
        facts: [{ id: 'rev', required: ['\\$4\\.2M'], forbidden: ['\\$7\\.9M'] }],
      }),
    ).toMatchObject({ kind: 'valueGrounding' });
    expect(() =>
      GateCheckSchema.parse({
        kind: 'valueGrounding',
        file: 'brief.md',
        facts: [{ id: 'rev', required: [] }],
      }),
    ).toThrow();
    expect(() => GateCheckSchema.parse({ kind: 'valueGrounding', file: 'brief.md' })).toThrow();
  });
});

describe('StepGateUnionSchema', () => {
  it('parses a legacy GateSpec (no `at`) through the legacy branch', () => {
    const gate = StepGateUnionSchema.parse({
      checks: [{ kind: 'minBytes', file: 'index.html', bytes: 2048 }],
      onFail: 'build',
      onPass: 'finish',
      maxAttempts: 3,
    });
    expect(isLegacyGateSpec(gate)).toBe(true);
    const n = normalizeStepGate(gate);
    expect(n).toMatchObject({
      at: 'activation',
      legacy: true,
      onReject: 'build',
      onApprove: 'finish',
      maxAttempts: 3,
      scripts: [],
    });
    expect(n.checks).toHaveLength(1);
  });

  it('parses a current StepGate and normalizes defaults', () => {
    const gate = StepGateUnionSchema.parse({
      at: 'completion',
      scripts: [{ name: 'checkHtmlComplete', scope: 'standard', inputs: { file: 'index.html' } }],
    });
    expect(isLegacyGateSpec(gate)).toBe(false);
    const n = normalizeStepGate(gate);
    expect(n).toMatchObject({ at: 'completion', legacy: false, maxAttempts: 4 });
    expect(n.scripts[0]?.scope).toBe('standard');
    expect(n.checks).toEqual([]);
  });

  it('rejects a gate with neither checks nor scripts', () => {
    expect(StepGateUnionSchema.safeParse({ at: 'completion' }).success).toBe(false);
  });

  it('parses negative content checks', () => {
    const gate = StepGateUnionSchema.parse({
      at: 'completion',
      checks: [
        {
          kind: 'notContains',
          file: 'CHANGELOG.md',
          pattern: 'Internal|CI',
          flags: 'i',
          label: 'exclude internal release noise',
        },
      ],
    });
    const n = normalizeStepGate(gate);
    expect(n.checks[0]).toMatchObject({
      kind: 'notContains',
      file: 'CHANGELOG.md',
      label: 'exclude internal release noise',
    });
  });

  it('parses unsupported claim checks', () => {
    const gate = StepGateUnionSchema.parse({
      at: 'completion',
      checks: [
        {
          kind: 'unsupportedClaims',
          file: 'press-release.md',
          sourceFiles: ['source/news-brief.md'],
          patterns: [
            {
              pattern: 'fundamentally(?: changes?)?',
              label: 'avoid sweeping overclaims',
            },
          ],
          flags: 'i',
        },
      ],
    });
    const n = normalizeStepGate(gate);
    expect(n.checks[0]).toMatchObject({
      kind: 'unsupportedClaims',
      file: 'press-release.md',
      sourceFiles: ['source/news-brief.md'],
    });
  });

  it('parses CSV shape checks', () => {
    const gate = StepGateUnionSchema.parse({
      at: 'completion',
      checks: [
        {
          kind: 'csvShape',
          file: 'updates.csv',
          exactColumns: ['object_type', 'email', 'status'],
          minRows: 2,
          allowedValues: { status: ['Active', 'UNMATCHED'] },
        },
      ],
    });
    const n = normalizeStepGate(gate);
    expect(n.checks[0]).toMatchObject({
      kind: 'csvShape',
      file: 'updates.csv',
      minRows: 2,
    });
  });

  it('gateEdgeTargets reads both generations', () => {
    expect(
      gateEdgeTargets({ checks: [{ kind: 'minBytes', file: 'a', bytes: 1 }], onFail: 'x' }),
    ).toEqual(['x']);
    expect(
      gateEdgeTargets({
        at: 'completion',
        scripts: [{ name: 's' }],
        onReject: 'a',
        onApprove: 'b',
      }),
    ).toEqual(['a', 'b']);
  });
});

describe('GateScriptResultSchema', () => {
  it('requires a message on reject', () => {
    expect(GateScriptResultSchema.safeParse({ decision: 'reject' }).success).toBe(false);
    expect(GateScriptResultSchema.safeParse({ decision: 'reject', message: '  ' }).success).toBe(
      false,
    );
    expect(
      GateScriptResultSchema.safeParse({
        decision: 'reject',
        message: 'index.html is missing a game-over screen — add one and re-advance.',
      }).success,
    ).toBe(true);
  });

  it('approve needs no message and may carry goto + handoff', () => {
    const parsed = GateScriptResultSchema.parse({
      decision: 'approve',
      goto: 'polish',
      handoff: { message: 'Tests are green; focus polish on the title screen.', params: { n: 3 } },
    });
    expect(parsed.handoff?.params).toEqual({ n: 3 });
  });
});

describe('graph validation with gates', () => {
  const steps = (gate: unknown) => [
    CraftbookStepSchema.parse({ id: 'build', name: 'Build', next: 'done', gate }),
    CraftbookStepSchema.parse({ id: 'done', name: 'Done', terminal: true }),
  ];

  it('validates onReject/onApprove edges on the current shape', () => {
    const ok = validateCraftbookGraph({
      steps: steps({ at: 'completion', scripts: [{ name: 'g' }], onReject: 'build' }),
      entryStepId: 'build',
    });
    expect(ok).toEqual([]);
    const bad = validateCraftbookGraph({
      steps: steps({ at: 'completion', scripts: [{ name: 'g' }], onReject: 'nope' }),
      entryStepId: 'build',
    });
    expect(bad.some((p) => p.includes('gate route "nope"'))).toBe(true);
  });

  it('allows a completion gate on a terminal step but not an activation gate', () => {
    const terminalWith = (gate: unknown) => [
      CraftbookStepSchema.parse({ id: 'only', name: 'Only', terminal: true, gate }),
    ];
    expect(
      validateCraftbookGraph({
        steps: terminalWith({ at: 'completion', scripts: [{ name: 'g' }] }),
        entryStepId: 'only',
      }),
    ).toEqual([]);
    expect(
      validateCraftbookGraph({
        steps: terminalWith({ at: 'activation', scripts: [{ name: 'g' }] }),
        entryStepId: 'only',
      }).some((p) => p.includes('activation gate')),
    ).toBe(true);
  });

  it('removeStepAndCleanEdges strips gate routes of both generations', () => {
    const cleaned = removeStepAndCleanEdges(
      [
        CraftbookStepSchema.parse({
          id: 'a',
          name: 'A',
          gate: { at: 'completion', scripts: [{ name: 'g' }], onReject: 'b', onApprove: 'c' },
        }),
        CraftbookStepSchema.parse({
          id: 'legacy',
          name: 'L',
          gate: { checks: [{ kind: 'minBytes', file: 'x', bytes: 1 }], onFail: 'b' },
        }),
        CraftbookStepSchema.parse({ id: 'b', name: 'B' }),
        CraftbookStepSchema.parse({ id: 'c', name: 'C' }),
      ],
      'b',
    );
    const a = cleaned.find((s) => s.id === 'a');
    const legacy = cleaned.find((s) => s.id === 'legacy');
    expect(a?.gate && gateEdgeTargets(a.gate)).toEqual(['c']);
    expect(legacy?.gate && gateEdgeTargets(legacy.gate)).toEqual([]);
  });
});
