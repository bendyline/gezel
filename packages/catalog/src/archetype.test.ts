import { CraftbookSchema } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { type ArchetypeSpec, archetypeToCraftbook, archetypeToFiles } from './archetype.js';

const arcade: ArchetypeSpec = {
  id: 'html-arcade-game',
  name: 'HTML Arcade Game',
  role: 'project-starter',
  description:
    'Build a playable single-file HTML arcade game, with a game-design phase and a visual-design phase before the build.',
  tags: ['game', 'html'],
  triggers: ['arcade game', 'build a game'],
  phases: [
    {
      id: 'game-design',
      name: 'Game design',
      role: 'game-designer',
      summary: 'mechanics, controls, win/lose',
      prompt: 'Define mechanics, controls, win/lose, and the acceptance-criteria checklist.',
    },
    {
      id: 'visual-design',
      name: 'Visual design',
      role: 'visual-designer',
      summary: 'look, palette, layout',
      prompt: 'Decide palette, layout, sprites/shapes. No code yet.',
    },
    {
      id: 'build',
      name: 'Build',
      role: 'developer',
      summary: 'implement the game',
      prompt: 'Implement the game in one index.html to satisfy the criteria.',
    },
  ],
  evaluate: { prompt: 'Check the game against every acceptance criterion; play it if you can.' },
};

describe('archetypeToCraftbook', () => {
  it('produces a runtime-valid craftbook (passes CraftbookSchema graph checks)', () => {
    const { steps, entryStepId } = archetypeToCraftbook(arcade);
    const cb = {
      id: arcade.id,
      name: arcade.name,
      description: arcade.description,
      version: '1.0.0',
      steps,
      entryStepId,
      createdAt: '2026-06-05T00:00:00Z',
      updatedAt: '2026-06-05T00:00:00Z',
    };
    const result = CraftbookSchema.safeParse(cb);
    if (!result.success) throw new Error(result.error.message);
    expect(result.success).toBe(true);
  });

  it('wires design → … → evaluate → (loop back to build) → finish, preserving per-phase roles', () => {
    const { steps, entryStepId } = archetypeToCraftbook(arcade);
    expect(entryStepId).toBe('game-design');
    const byId = new Map(steps.map((s) => [s.id, s]));
    expect(byId.get('game-design')?.suggestedRole).toBe('game-designer');
    expect(byId.get('visual-design')?.suggestedRole).toBe('visual-designer');
    expect(byId.get('game-design')?.next).toBe('visual-design');
    expect(byId.get('build')?.next).toBe('evaluate');
    // Default loop-back target is the last build phase — the safe failure
    // mode is "keep improving", never advance to finish half-done.
    expect(byId.get('evaluate')?.next).toBe('build');
    expect(byId.get('finish')?.terminal).toBe(true);
  });

  it('honors an explicit loopBackTo', () => {
    const spec: ArchetypeSpec = {
      ...arcade,
      evaluate: { ...arcade.evaluate, loopBackTo: 'visual-design' },
    };
    expect(archetypeToCraftbook(spec).steps.find((s) => s.id === 'evaluate')?.next).toBe(
      'visual-design',
    );
  });

  it('rejects reserved ids, empty phases, and an unknown loopBackTo', () => {
    expect(() => archetypeToCraftbook({ ...arcade, phases: [] })).toThrow();
    expect(() =>
      archetypeToCraftbook({
        ...arcade,
        phases: [{ id: 'evaluate', name: 'x', role: 'developer', summary: 'x', prompt: 'x' }],
      }),
    ).toThrow(/reserved/);
    expect(() =>
      archetypeToCraftbook({ ...arcade, evaluate: { ...arcade.evaluate, loopBackTo: 'nope' } }),
    ).toThrow();
  });

  it('emits completion gates on producing phases: floor checks + standard scripts + onReject self', () => {
    const spec: ArchetypeSpec = {
      ...arcade,
      phases: [
        {
          id: 'design',
          name: 'Design',
          role: 'game-designer',
          summary: 'notes',
          prompt: 'Write design notes.',
          produces: { path: 'design.md', kind: 'markdown-notes' },
        },
        {
          id: 'build',
          name: 'Build',
          role: 'developer',
          summary: 'implement',
          prompt: 'Build the game.',
          produces: { path: 'index.html', kind: 'html-game' },
        },
      ],
    };
    const { steps } = archetypeToCraftbook(spec);
    const byId = new Map(steps.map((s) => [s.id, s]));

    // No evaluator-step pairs anymore — the gate lives on the work step.
    expect(steps.some((s) => s.id.includes('--'))).toBe(false);
    expect(steps.map((s) => s.id)).toEqual(['design', 'build', 'evaluate', 'finish']);

    const design = byId.get('design');
    expect(design?.advanceWhen).toMatchObject({ file: 'design.md' });
    expect(
      design?.advanceWhen && 'goto' in design.advanceWhen ? design.advanceWhen.goto : undefined,
    ).toBeUndefined();
    const designGate = design?.gate;
    expect(designGate && 'at' in designGate && designGate.at).toBe('completion');
    expect(designGate && 'onReject' in designGate && designGate.onReject).toBe('design');
    expect(designGate && 'maxAttempts' in designGate && designGate.maxAttempts).toBe(3);

    const build = byId.get('build');
    const buildGate = build?.gate;
    expect(buildGate && 'at' in buildGate && buildGate.at).toBe('completion');
    expect(buildGate && 'maxAttempts' in buildGate && buildGate.maxAttempts).toBe(4);
    const scripts = buildGate && 'scripts' in buildGate ? (buildGate.scripts ?? []) : [];
    expect(scripts.map((r) => r.name)).toEqual(['checkHtmlGame', 'checkJsParses']);
    expect(scripts.every((r) => r.scope === 'standard')).toBe(true);
    const checks = buildGate && 'checks' in buildGate ? (buildGate.checks ?? []) : [];
    expect(checks[0]).toMatchObject({ kind: 'minBytes', file: 'index.html', bytes: 1500 });

    // Evaluate keeps the Layer-2 judgment with no runtime gate.
    expect(byId.get('evaluate')?.gate).toBeUndefined();
    expect(byId.get('evaluate')?.next).toBe('build');
  });

  const disciplineSpec: ArchetypeSpec = {
    ...arcade,
    phases: [
      {
        id: 'scope',
        name: 'Scope',
        role: 'reviewer',
        summary: 'lock the rubric',
        prompt: 'Lock the rubric.',
        produces: { path: 'notes/scope.md', kind: 'markdown-notes' },
      },
      {
        id: 'report',
        name: 'Report',
        role: 'reviewer',
        summary: 'write the report',
        prompt: 'Write the report.',
        produces: { path: 'audit.md', kind: 'markdown-report' },
      },
    ],
    sourceDiscipline: 'Source discipline:\n\n- Only audit supplied claims.',
  };

  it('folds sourceDiscipline into the about after the Phases list, before the trailing boilerplate', () => {
    const doc = JSON.parse(
      archetypeToFiles(disciplineSpec, '2026-06-05T00:00:00Z').files[1]!.content,
    ) as { description: string };
    expect(doc.description).toContain(
      '(markdown-report)\n\nSource discipline:\n\n- Only audit supplied claims.\n\nThe gates never advance',
    );
  });

  it('places sourceDiscipline after the boilerplate when disciplinePlacement=after-boilerplate', () => {
    const doc = JSON.parse(
      archetypeToFiles(
        { ...disciplineSpec, disciplinePlacement: 'after-boilerplate' },
        '2026-06-05T00:00:00Z',
      ).files[1]!.content,
    ) as { description: string };
    expect(doc.description).toContain(
      'owning phase to fix named gaps.\n\nSource discipline:\n\n- Only audit supplied claims.\n',
    );
    expect(doc.description).not.toContain('claims.\n\nThe gates never advance');
  });

  it('splices sourceDiscipline into the description prose (about-only) with placement=in-description', () => {
    const g = archetypeToFiles(
      { ...disciplineSpec, disciplinePlacement: 'in-description' },
      '2026-06-05T00:00:00Z',
    );
    const doc = JSON.parse(g.files[1]!.content) as { description: string };
    const manifest = JSON.parse(g.files[0]!.content) as { description: string };
    // In the about, the block sits before the standing boilerplate…
    expect(doc.description).toContain(
      'Only audit supplied claims.\n\nA gallery craftbook generated from an archetype spec.',
    );
    // …and NOT after the phase list.
    expect(doc.description).not.toContain('(markdown-report)\n\nSource discipline:');
    // The catalog description / manifest stays free of the discipline block.
    expect(manifest.description).not.toContain('Source discipline:');
  });

  it('routes artifact-drawer deliverables through the drawer gate + advanceWhen and the artifact-note about', () => {
    const spec: ArchetypeSpec = {
      ...disciplineSpec,
      sourceDiscipline: undefined,
      artifactNote: 'Every deliverable lands in the drawer.',
      phases: [
        {
          id: 'scope',
          name: 'Scope',
          role: 'planner',
          summary: 'lock scope',
          prompt: 'Lock scope.',
          produces: { path: 'reports/scope.md', kind: 'markdown-notes', artifact: true },
        },
        {
          id: 'report',
          name: 'Report',
          role: 'reviewer',
          summary: 'write the report',
          prompt: 'Write the report.',
          produces: { path: 'reports/report.md', kind: 'markdown-report', artifact: true },
        },
      ],
    };
    const { steps } = archetypeToCraftbook(spec);
    const byId = new Map(steps.map((s) => [s.id, s]));
    const scope = byId.get('scope');
    expect(scope?.advanceWhen).toMatchObject({ file: 'reports/scope.md', artifact: true });
    const scopeChecks = scope?.gate && 'checks' in scope.gate ? (scope.gate.checks ?? []) : [];
    expect(scopeChecks.every((c) => (c as { artifact?: boolean }).artifact === true)).toBe(true);
    expect(scope?.gate && 'scripts' in scope.gate ? scope.gate.scripts : undefined).toBeUndefined();

    // A markdown report's heading requirement (a workspace gate script) is
    // re-expressed as a drawer-readable `contains` check.
    const report = byId.get('report');
    const reportChecks = report?.gate && 'checks' in report.gate ? (report.gate.checks ?? []) : [];
    expect(reportChecks.some((c) => c.kind === 'contains')).toBe(true);
    expect(reportChecks.every((c) => (c as { artifact?: boolean }).artifact === true)).toBe(true);

    const doc = JSON.parse(archetypeToFiles(spec, '2026-06-05T00:00:00Z').files[1]!.content) as {
      description: string;
    };
    expect(doc.description).toContain('Every deliverable lands in the drawer.\n\nPhases:');
    expect(doc.description).toContain('gated on artifact `reports/scope.md`');
  });

  it('report/notes kinds default to the artifacts drawer; product-source kinds stay in the workspace', () => {
    const spec: ArchetypeSpec = {
      ...arcade,
      phases: [
        {
          id: 'scan',
          name: 'Scan',
          role: 'developer',
          summary: 'inventory deps',
          prompt: 'Inventory every dependency into `notes/scan.md`.',
          produces: { path: 'notes/scan.md', kind: 'markdown-notes' },
        },
        {
          id: 'build',
          name: 'Build',
          role: 'developer',
          summary: 'implement',
          prompt: 'Build the page.',
          produces: { path: 'index.html', kind: 'html-page' },
        },
        {
          id: 'report',
          name: 'Report',
          role: 'reviewer',
          summary: 'write the audit report',
          prompt: 'Write `dependency-audit.md`.',
          produces: { path: 'dependency-audit.md', kind: 'markdown-report' },
        },
      ],
    };
    const { steps } = archetypeToCraftbook(spec);
    const byId = new Map(steps.map((s) => [s.id, s]));

    expect(byId.get('scan')?.advanceWhen).toMatchObject({ file: 'notes/scan.md', artifact: true });
    expect(byId.get('report')?.advanceWhen).toMatchObject({
      file: 'dependency-audit.md',
      artifact: true,
    });
    const buildAdvance = byId.get('build')?.advanceWhen as { artifact?: boolean } | undefined;
    expect(buildAdvance?.artifact).toBeUndefined();

    const scanChecks =
      byId.get('scan')?.gate && 'checks' in byId.get('scan')!.gate!
        ? (byId.get('scan')!.gate!.checks ?? [])
        : [];
    expect(scanChecks.length).toBeGreaterThan(0);
    expect(scanChecks.every((c) => (c as { artifact?: boolean }).artifact === true)).toBe(true);

    // Deterministic drawer steering lands on the step prompt and the
    // evaluate footer so path-first spec prose can't send the model to
    // `write_file`/`read_file` against a drawer-gated deliverable.
    expect(byId.get('scan')?.prompt).toContain('write_artifact');
    expect(byId.get('build')?.prompt).not.toContain('write_artifact');
    expect(byId.get('evaluate')?.prompt).toContain('read_artifact');
  });

  it('an explicit artifact:false keeps a notes deliverable in the workspace', () => {
    const spec: ArchetypeSpec = {
      ...arcade,
      phases: [
        {
          id: 'notes',
          name: 'Notes',
          role: 'developer',
          summary: 'working notes',
          prompt: 'Write working notes.',
          produces: { path: 'notes/working.md', kind: 'markdown-notes', artifact: false },
        },
      ],
    };
    const { steps } = archetypeToCraftbook(spec);
    const notes = steps.find((s) => s.id === 'notes');
    expect((notes?.advanceWhen as { artifact?: boolean } | undefined)?.artifact).toBeUndefined();
    expect(notes?.prompt).not.toContain('write_artifact');
    const checks = notes?.gate && 'checks' in notes.gate ? (notes.gate.checks ?? []) : [];
    expect(checks.some((c) => (c as { artifact?: boolean }).artifact === true)).toBe(false);
  });

  it('drawer-defaulted books get the standing artifact note in the about when the spec has none', () => {
    const spec: ArchetypeSpec = {
      ...disciplineSpec,
      sourceDiscipline: undefined,
    };
    const doc = JSON.parse(archetypeToFiles(spec, '2026-06-05T00:00:00Z').files[1]!.content) as {
      description: string;
    };
    expect(doc.description).toContain('artifacts drawer (`write_artifact` / `read_artifact`)');
    expect(doc.description).toContain('gated on artifact `audit.md`');
  });

  it('regeneration is deterministic: same spec → byte-identical files', () => {
    const a = archetypeToFiles(arcade, '2026-06-05T00:00:00Z');
    const b = archetypeToFiles(arcade, '2026-06-05T00:00:00Z');
    expect(a).toEqual(b);
  });

  it('archetypeToFiles emits the single-document V2 layout, tagged gallery', () => {
    const g = archetypeToFiles(arcade, '2026-06-05T00:00:00Z');
    expect(g.shard).toBe('ht');
    expect(g.files.map((f) => f.relPath)).toEqual([
      'manifest.json',
      'versions/1.0.0/craftbook.json',
    ]);
    const top = JSON.parse(g.files[0]!.content) as {
      id: string;
      role: string;
      tags: string[];
    };
    expect(top.id).toBe('html-arcade-game');
    expect(top.role).toBe('project-starter');
    expect(top.tags).toContain('gallery');
    const doc = JSON.parse(g.files[1]!.content) as {
      entryStepId: string;
      steps: unknown[];
      description: string;
      version: string;
      releasedAt: string;
    };
    expect(doc.entryStepId).toBe('game-design');
    expect(doc.steps).toHaveLength(5); // 3 phases + evaluate + finish
    expect(doc.description.length).toBeGreaterThan(0); // about prose inlined
    expect(doc.version).toBe('1.0.0');
    expect(doc.releasedAt).toBe('2026-06-05T00:00:00Z');
  });

  it('emits an explicit immutable release without rewriting the 1.0.0 path', () => {
    const spec: ArchetypeSpec = {
      ...arcade,
      release: { version: '1.1.0', releasedAt: '2026-08-09T00:00:00Z' },
    };
    const generated = archetypeToFiles(spec, '2026-06-05T00:00:00Z');
    expect(generated.files.map((file) => file.relPath)).toEqual([
      'manifest.json',
      'versions/1.1.0/craftbook.json',
    ]);
    const doc = JSON.parse(generated.files[1]!.content) as {
      version: string;
      releasedAt: string;
    };
    expect(doc).toMatchObject({
      version: '1.1.0',
      releasedAt: '2026-08-09T00:00:00Z',
    });
  });
});
