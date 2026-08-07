import { describe, expect, it } from 'vitest';
import {
  coerceDeliverableKind,
  deliverableKindForStep,
  deliverableStep,
  expandStepDeliverable,
  expandStepDeliverables,
  inferDeliverableKind,
  stepDeliverablePath,
} from './deliverable.js';
import { validateCraftbookGraph, validateCraftbookScriptRefs } from './schemas/index.js';

describe('deliverableStep', () => {
  it('builds advanceWhen + a self-looping completion gate for a markdown report', () => {
    const { advanceWhen, gate } = deliverableStep({
      selfId: 'build',
      path: 'report.md',
      kind: 'markdown-report',
    });
    expect(advanceWhen?.file).toBe('report.md');
    expect(gate.at).toBe('completion');
    expect(gate.onReject).toBe('build');
    expect(gate.checks?.some((c) => c.kind === 'minBytes' && c.file === 'report.md')).toBe(true);
    expect(gate.scripts?.some((s) => s.name === 'checkContains')).toBe(true);
  });

  it('uses an html sniff for html kinds and honors a minBytes override', () => {
    const { advanceWhen, gate } = deliverableStep({
      selfId: 'page',
      path: 'index.html',
      kind: 'html-page',
      minBytes: 5000,
    });
    expect(advanceWhen?.sniff).toBe('html-complete');
    expect(gate.checks?.find((c) => c.kind === 'minBytes')).toMatchObject({ bytes: 5000 });
    expect(gate.checks).toContainEqual({ kind: 'htmlLint', file: 'index.html' });
    expect(gate.scripts?.some((s) => s.name === 'checkHtmlComplete')).toBe(true);
  });

  it('defaults maxAttempts to 3', () => {
    const { gate } = deliverableStep({ selfId: 's', path: 'x.json', kind: 'json' });
    expect(gate.maxAttempts).toBe(3);
  });

  it('gates a data-file deliverable on the data-table sniff (output parses), not just minBytes', () => {
    // The data-class fix: a data deliverable must be the produced, parseable
    // output — not an empty file or the transform script left in its place.
    const { advanceWhen, gate } = deliverableStep({
      selfId: 'build',
      path: 'out/customers.json',
      kind: 'data-file',
    });
    expect(advanceWhen?.file).toBe('out/customers.json');
    expect(
      gate.checks?.some(
        (c) => c.kind === 'sniff' && c.file === 'out/customers.json' && c.sniff === 'data-table',
      ),
    ).toBe(true);
    // The cheap byte floor is still present underneath.
    expect(gate.checks?.some((c) => c.kind === 'minBytes')).toBe(true);
  });

  it('gates a code-module deliverable on esmImports (wrong-builtin imports break at load)', () => {
    const { gate } = deliverableStep({
      selfId: 'build',
      path: 'src/server.mjs',
      kind: 'code-module',
    });
    expect(gate.checks?.some((c) => c.kind === 'esmImports' && c.file === 'src/server.mjs')).toBe(
      true,
    );
  });

  it('artifact deliverables keep only drawer-capable checks and drop workspace scripts', () => {
    const { advanceWhen, gate } = deliverableStep({
      selfId: 'audit',
      path: 'threat-model.md',
      kind: 'markdown-report',
      artifact: true,
    });
    expect(advanceWhen?.artifact).toBe(true);
    expect(gate.scripts).toBeUndefined();
    expect(gate.checks?.length).toBeGreaterThan(0);
    for (const c of gate.checks ?? []) {
      expect(['minBytes', 'sniff', 'contains']).toContain(c.kind);
      expect((c as { artifact?: boolean }).artifact).toBe(true);
    }
  });

  it('requireChange threads onto advanceWhen (edit deliverables hold until written)', () => {
    const { advanceWhen } = deliverableStep({
      selfId: 'fix',
      path: 'src/parser.ts',
      kind: 'code-module',
      requireChange: true,
    });
    expect(advanceWhen?.requireChange).toBe(true);
  });

  it('json deliverables with columns get a recordSchema floor (same as data-file)', () => {
    const { gate } = deliverableStep({
      selfId: 'build',
      path: 'out/customers.json',
      kind: 'json',
      columns: ['id', 'name', 'signupDate'],
      minRows: 10,
    });
    const record = gate.checks?.find((c) => c.kind === 'recordSchema');
    expect(record).toMatchObject({
      file: 'out/customers.json',
      minRows: 10,
    });
    expect((record as { fields?: Array<{ name: string }> }).fields?.map((f) => f.name)).toEqual([
      'id',
      'name',
      'signupDate',
    ]);
  });

  it('csv data-file with columns gets csvShape; execute stays code-only', () => {
    const { gate } = deliverableStep({
      selfId: 'build',
      path: 'data/output.csv',
      kind: 'data-file',
      columns: ['email', 'status'],
      execute: true,
    });
    expect(gate.checks?.some((c) => c.kind === 'csvShape')).toBe(true);
    // execute on a data kind is ignored — running the CSV is meaningless;
    // shape checks + the derive_file production path are the equivalent.
    expect(gate.checks?.some((c) => c.kind === 'nodeRuns')).toBe(false);

    const code = deliverableStep({
      selfId: 'build',
      path: 'contract.test.mjs',
      kind: 'code-with-tests',
      execute: true,
    });
    expect(code.gate.checks?.some((c) => c.kind === 'nodeRuns')).toBe(true);
  });
});

describe('inferDeliverableKind', () => {
  it('maps extensions to classes', () => {
    expect(inferDeliverableKind('index.html')).toBe('html-page');
    expect(inferDeliverableKind('notes/report.md')).toBe('markdown-doc');
    expect(inferDeliverableKind('out/data.json')).toBe('json');
    expect(inferDeliverableKind('out/orders.csv')).toBe('data-file');
    expect(inferDeliverableKind('ci.yaml')).toBe('yaml-spec');
    expect(inferDeliverableKind('src/lib.ts')).toBe('code-module');
    expect(inferDeliverableKind('src/lib.test.ts')).toBe('code-with-tests');
    expect(inferDeliverableKind('theme.wav')).toBe('audio-file');
    expect(inferDeliverableKind('LICENSE')).toBe('generic-file');
  });
});

describe('coerceDeliverableKind', () => {
  it('accepts exact kinds, loose aliases, and case/separator noise', () => {
    expect(coerceDeliverableKind('html-game')).toBe('html-game');
    expect(coerceDeliverableKind('html')).toBe('html-page');
    expect(coerceDeliverableKind('Markdown')).toBe('markdown-doc');
    expect(coerceDeliverableKind('CSV')).toBe('data-file');
    expect(coerceDeliverableKind('code')).toBe('code-module');
    expect(coerceDeliverableKind('web page')).toBe('html-page');
    expect(coerceDeliverableKind('no-such-thing')).toBeNull();
  });
});

describe('expandStepDeliverable(s)', () => {
  it('expands deliverable sugar into advanceWhen + a self-looping gate', () => {
    const steps = expandStepDeliverables([
      { name: 'Build the page', deliverable: { path: 'index.html' } },
      { name: 'Done', terminal: true },
    ]);
    expect(steps[0]!.id).toBe('build-the-page');
    expect(steps[0]!.advanceWhen?.file).toBe('index.html');
    expect(steps[0]!.gate).toMatchObject({ at: 'completion', onReject: 'build-the-page' });
    expect(steps[1]!.gate).toBeUndefined();
    expect(validateCraftbookGraph({ steps, entryStepId: 'build-the-page' })).toEqual([]);
  });

  it('uses the post-dedup minted id for onReject when slugs collide', () => {
    const steps = expandStepDeliverables([
      { name: 'Build', deliverable: { path: 'a.md' } },
      { name: 'Build', deliverable: { path: 'b.md' } },
    ]);
    expect(steps[0]!.id).toBe('build');
    expect(steps[1]!.id).toBe('build-2');
    expect(steps[1]!.gate).toMatchObject({ onReject: 'build-2' });
    expect(steps[1]!.advanceWhen?.file).toBe('b.md');
  });

  it('explicit gate/advanceWhen on the blueprint wins over the expansion', () => {
    const explicitGate = {
      at: 'completion' as const,
      checks: [{ kind: 'minBytes' as const, file: 'x.md', bytes: 9 }],
    };
    const step = expandStepDeliverable(
      { id: 's', name: 'S', gate: explicitGate },
      { path: 'x.md', kind: 'markdown-doc' },
    );
    expect(step.gate).toBe(explicitGate);
    // The un-authored half is still filled in.
    expect(step.advanceWhen?.file).toBe('x.md');
  });
});

describe('validateCraftbookScriptRefs', () => {
  it('skips books without a scripts map and flags missing craftbook-scope refs', () => {
    const steps = [
      {
        id: 'build',
        name: 'Build',
        gate: {
          at: 'completion' as const,
          scripts: [{ name: 'checkIt', scope: 'craftbook' as const }],
        },
      },
    ];
    expect(validateCraftbookScriptRefs({ steps })).toEqual([]);
    expect(validateCraftbookScriptRefs({ steps, scripts: { checkIt: 'x' } })).toEqual([]);
    const problems = validateCraftbookScriptRefs({ steps, scripts: { other: 'x' } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('"checkIt"');
    expect(problems[0]).toContain('available: other');
  });

  it('ignores non-craftbook scopes', () => {
    const steps = [{ id: 'a', name: 'A', onEnter: { name: 'setup', scope: 'standard' as const } }];
    expect(validateCraftbookScriptRefs({ steps, scripts: {} })).toEqual([]);
  });
});

describe('terminal-step deliverables (gate-only expansion)', () => {
  it('deliverableStep with terminal returns a gate and no advanceWhen', () => {
    const { advanceWhen, gate } = deliverableStep({
      selfId: 'verify',
      path: 'out/report.md',
      kind: 'markdown-report',
      terminal: true,
    });
    expect(advanceWhen).toBeUndefined();
    expect(gate.at).toBe('completion');
    expect(gate.onReject).toBe('verify');
  });

  it('a deliverable on a terminal blueprint step expands to a VALID graph', () => {
    const steps = expandStepDeliverables([
      { name: 'Build', deliverable: { path: 'out/orders.json', kind: 'json' } },
      { name: 'Verify', terminal: true, deliverable: { path: 'out/report.md' } },
    ]);
    const verify = steps[1]!;
    expect(verify.terminal).toBe(true);
    expect(verify.advanceWhen).toBeUndefined();
    expect(verify.gate).toMatchObject({ at: 'completion', onReject: 'verify' });
    expect(validateCraftbookGraph({ steps, entryStepId: 'build' })).toEqual([]);
  });
});

describe('deliverableKindForStep — inverse inference (D4)', () => {
  const roundTrip = (path: string, kind: Parameters<typeof deliverableStep>[0]['kind']) => {
    const { advanceWhen, gate } = deliverableStep({ selfId: 's', path, kind });
    return deliverableKindForStep({
      ...(advanceWhen ? { advanceWhen } : {}),
      gate,
    });
  };

  it('round-trips the signal-distinguishable kinds exactly', () => {
    expect(roundTrip('index.html', 'html-game')).toBe('html-game');
    expect(roundTrip('index.html', 'html-multiscreen-game')).toBe('html-multiscreen-game');
    expect(roundTrip('index.html', 'html-page')).toBe('html-page');
    expect(roundTrip('index.html', 'html-marketing-site')).toBe('html-marketing-site');
    expect(roundTrip('report.md', 'security-report')).toBe('security-report');
    expect(roundTrip('data/out.csv', 'data-file')).toBe('data-file');
    expect(roundTrip('config.json', 'json')).toBe('json');
    expect(roundTrip('assets', 'image-set')).toBe('image-set');
    expect(roundTrip('src/mod.ts', 'code-module')).toBe('code-module');
    expect(roundTrip('src/mod.test.ts', 'code-with-tests')).toBe('code-with-tests');
    expect(roundTrip('deck.md', 'slide-deck')).toBe('slide-deck');
  });

  it('extension fallbacks stay kit-accurate (markdown subkinds collapse to markdown-doc)', () => {
    expect(roundTrip('notes.md', 'markdown-notes')).toBe('markdown-doc');
    expect(roundTrip('report.md', 'markdown-report')).toBe('markdown-doc');
    expect(roundTrip('doc.md', 'markdown-doc')).toBe('markdown-doc');
    expect(roundTrip('spec.yaml', 'yaml-spec')).toBe('yaml-spec');
    expect(roundTrip('song.wav', 'audio-file')).toBe('audio-file');
    expect(roundTrip('thing.bin', 'generic-file')).toBe('generic-file');
  });

  it('sniff upgrades win over extension (data-table on a .json output)', () => {
    expect(
      deliverableKindForStep({
        advanceWhen: { file: 'out/rows.json', sniff: 'data-table' },
      }),
    ).toBe('data-file');
  });

  it('a step with no file signal yields null; stepDeliverablePath finds gate-check files', () => {
    expect(deliverableKindForStep({})).toBeNull();
    expect(
      stepDeliverablePath({
        gate: { at: 'completion', checks: [{ kind: 'minBytes', file: 'out.md', bytes: 10 }] },
      }),
    ).toBe('out.md');
  });
});
