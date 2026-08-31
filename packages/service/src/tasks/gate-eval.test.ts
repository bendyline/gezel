import { describe, expect, it } from 'vitest';
import { type GateWorkspaceReader, evaluateGate, taskSuppliedCitationPaths } from './gate-eval.js';

const reader = (files: Record<string, string>): GateWorkspaceReader => ({
  read: async (f) => (f in files ? files[f]! : null),
  list: async () => Object.keys(files),
});

/** A reader with separate workspace + artifacts trees, to exercise the `artifact` flag. */
const splitReader = (
  workspace: Record<string, string>,
  artifacts: Record<string, string>,
): GateWorkspaceReader => ({
  read: async (f) => (f in workspace ? workspace[f]! : null),
  list: async () => Object.keys(workspace),
  readArtifact: async (f) => (f in artifacts ? artifacts[f]! : null),
  listArtifacts: async () => Object.keys(artifacts),
});

describe('evaluateGate', () => {
  it('totalMinBytes: passes over the floor, fails with a concrete gap', async () => {
    const ok = await evaluateGate(
      [{ kind: 'totalMinBytes', files: ['index.html', 'game.js'], bytes: 20 }],
      reader({ 'index.html': 'a'.repeat(12), 'game.js': 'b'.repeat(12) }),
    );
    expect(ok.pass).toBe(true);
    const bad = await evaluateGate(
      [{ kind: 'totalMinBytes', files: ['index.html', 'game.js'], bytes: 5000 }],
      reader({ 'index.html': 'a'.repeat(100) }),
    );
    expect(bad.pass).toBe(false);
    expect(bad.failures[0]).toMatch(/total 100 bytes, need ≥ 5000/);
  });

  it('fileCount: counts images by extension (the marketing-site case)', async () => {
    const r = reader({ 'a.png': 'x', 'b.jpg': 'x', 'c.svg': 'x', 'd.txt': 'x' });
    expect(
      (await evaluateGate([{ kind: 'fileCount', ext: ['png', 'jpg', 'svg', 'webp'], min: 3 }], r))
        .pass,
    ).toBe(true);
    expect((await evaluateGate([{ kind: 'fileCount', ext: ['png'], min: 2 }], r)).pass).toBe(false);
  });

  it('cssMinBytes: sums inline <style> + linked stylesheet', async () => {
    const r = reader({
      'index.html': `<style>${'a'.repeat(600)}</style><link rel="stylesheet" href="site.css">`,
      'site.css': 'b'.repeat(600),
    });
    expect((await evaluateGate([{ kind: 'cssMinBytes', bytes: 1024 }], r)).pass).toBe(true);
    expect((await evaluateGate([{ kind: 'cssMinBytes', bytes: 5000 }], r)).pass).toBe(false);
  });

  it('minBytes + sniff + contains compose; ALL must pass', async () => {
    const r = reader({
      'index.html': `<canvas></canvas><script>${'x'.repeat(500)}</script></body>`,
    });
    const res = await evaluateGate(
      [
        { kind: 'minBytes', file: 'index.html', bytes: 100 },
        { kind: 'sniff', file: 'index.html', sniff: 'html-game' },
        { kind: 'contains', file: 'index.html', pattern: '<canvas' },
      ],
      r,
    );
    expect(res.pass).toBe(true);
    expect(res.failures).toEqual([]);
  });

  it('artifact-flagged checks read the artifacts drawer, not the workspace', async () => {
    // The deliverable lives ONLY in the artifacts tree. A workspace-scoped
    // check can't see it (fails "not found"); the same check flagged
    // `artifact: true` reads it and passes — and the size/shape floor applies
    // identically there.
    const r = splitReader(
      {}, // empty workspace
      { 'reports/threat-model.md': `# Threats\n\n${'x'.repeat(1600)}` },
    );
    // Without the flag → reads workspace → not found → fail.
    const wsScoped = await evaluateGate(
      [{ kind: 'minBytes', file: 'reports/threat-model.md', bytes: 1500 }],
      r,
    );
    expect(wsScoped.pass).toBe(false);
    // With the flag → reads the artifacts drawer → over the floor + has a
    // heading → pass.
    const artScoped = await evaluateGate(
      [
        { kind: 'minBytes', file: 'reports/threat-model.md', bytes: 1500, artifact: true },
        {
          kind: 'contains',
          file: 'reports/threat-model.md',
          pattern: '(?:^|\\n)#{1,3}\\s+\\S',
          flags: 'i',
          artifact: true,
        },
        { kind: 'sniff', file: 'reports/threat-model.md', sniff: 'nonempty', artifact: true },
      ],
      r,
    );
    expect(artScoped.pass).toBe(true);
    expect(artScoped.failures).toEqual([]);
  });

  it('the code/prose checks honor the artifact flag instead of always reading the workspace', async () => {
    // These five read their content directly rather than through a helper,
    // and each had grabbed `ws` instead of the artifact-swapped `reader` —
    // so a drawer deliverable reported "not found" no matter what the
    // craftbook declared. A review of a read-only checkout can only write
    // the drawer, so this was the difference between a runnable gate and
    // an unwinnable one.
    const broken = 'function a() { return 1;';
    const r = splitReader(
      {},
      {
        'reports/build.mjs': broken,
        'reports/page.html': `<html><body><script>${broken}</script></body></html>`,
        'reports/imports.mjs': "import { nope } from 'node:url';\n",
        'reports/claims.md': 'This is the fastest renderer ever built.',
        'reports/source.md': 'It renders quickly.',
      },
    );
    const flagged = await evaluateGate(
      [
        { kind: 'sourceParses', file: 'reports/build.mjs', artifact: true },
        { kind: 'jsParses', file: 'reports/page.html', artifact: true },
        { kind: 'htmlLint', file: 'reports/page.html', artifact: true },
        { kind: 'esmImports', file: 'reports/imports.mjs', artifact: true },
        {
          kind: 'unsupportedClaims',
          file: 'reports/claims.md',
          sourceFiles: ['reports/source.md'],
          patterns: [{ pattern: 'fastest[\\w\\s]*ever built', label: 'superlative' }],
          artifact: true,
        },
      ],
      r,
    );
    // Every one of these FAILS on content — which is the point: the checks
    // reached the drawer and judged it. Before the fix they all failed as
    // "not found", indistinguishable from a missing deliverable.
    expect(flagged.pass).toBe(false);
    expect(flagged.failures.some((f) => /not found/.test(f))).toBe(false);

    const clean = splitReader(
      {},
      {
        'reports/build.mjs': 'export function a() {\n  return 1;\n}\n',
        'reports/imports.mjs': "import { fileURLToPath } from 'node:url';\n",
      },
    );
    const passing = await evaluateGate(
      [
        { kind: 'sourceParses', file: 'reports/build.mjs', artifact: true },
        { kind: 'esmImports', file: 'reports/imports.mjs', artifact: true },
      ],
      clean,
    );
    expect(passing.pass).toBe(true);
  });

  it('corpusCoverage accepts a drawer-side ledger (writes-off review projects)', async () => {
    // The PR-review book declares `artifact: true` here because a review
    // never writes the checkout. The flag used to be stripped by the
    // schema, so the ledger was hunted for in the workspace and the whole
    // craftbook was unsatisfiable on any writes-off project.
    const record = (path: string) => `---\npath: ${path}\nstatus: modified\n---\n\n# ${path}\n`;
    const r = splitReader(
      {},
      {
        'data/github-pulls/pr-46/files/001--a--aaaa1111.md': record('src/a.ts'),
        'pr-review-coverage.json': JSON.stringify({
          reviewedFiles: ['src/a.ts'],
          reviewedRecords: ['data/github-pulls/pr-46/files/001--a--aaaa1111.md'],
        }),
      },
    );
    const res = await evaluateGate(
      [
        {
          kind: 'corpusCoverage',
          file: 'pr-review-coverage.json',
          corpusDir: 'artifacts/data/github-pulls/pr-46',
          artifact: true,
        },
      ],
      r,
    );
    expect(res.pass).toBe(true);
  });

  describe('corpusBatches (fanout-input completeness)', () => {
    const CORPUS = 'data/github-pulls/pr-33';
    const MANIFEST = `${CORPUS}/attachments/001/pr-33-files.json`;

    const batch = (batchNumber: number, start: number, count: number) => ({
      number: batchNumber,
      batchNumber,
      start,
      end: start + count - 1,
      paths: Array.from({ length: count }, (_, i) => `packages/p${start + i}/src/file.ts`),
    });
    const MANIFEST_JSON = JSON.stringify({
      totalFiles: 30,
      batchSize: 25,
      batches: [batch(1, 1, 25), batch(2, 26, 5)],
    });
    /** What a correct publish looks like: the four fanout fields, verbatim. */
    const entry = (b: ReturnType<typeof batch>) => ({
      batchNumber: b.batchNumber,
      start: b.start,
      end: b.end,
      paths: b.paths,
    });
    const check = {
      kind: 'corpusBatches' as const,
      file: 'pr-review/batches.json',
      corpusDir: `artifacts/${CORPUS}`,
      artifact: true,
    };
    const withPublished = (published: unknown) =>
      splitReader(
        {},
        { [MANIFEST]: MANIFEST_JSON, 'pr-review/batches.json': JSON.stringify(published, null, 2) },
      );

    it('passes when every batch matches the manifest verbatim', async () => {
      const res = await evaluateGate(
        [check],
        withPublished([entry(batch(1, 1, 25)), entry(batch(2, 26, 5))]),
      );
      expect(res.pass).toBe(true);
    });

    it('rejects a truncated batch array that is still valid JSON', async () => {
      // The exact incident: the model's write hit its output cap, so it
      // published a syntactically perfect array holding half the batches.
      // json-valid + minBytes both pass on this file.
      const res = await evaluateGate([check], withPublished([entry(batch(1, 1, 25))]));
      expect(res.pass).toBe(false);
      expect(res.failures[0]).toMatch(/holds 1 batch\(es\) but .* defines 2/);
      expect(res.failures[0]).toMatch(/work nobody is assigned/);
    });

    it('rejects a retyped path even when the count is right', async () => {
      const wrong = entry(batch(2, 26, 5));
      wrong.paths = [...wrong.paths];
      wrong.paths[2] = 'packages/p28/src/File.ts';
      const res = await evaluateGate([check], withPublished([entry(batch(1, 1, 25)), wrong]));
      expect(res.pass).toBe(false);
      expect(res.failures[0]).toMatch(/path 3 is "packages\/p28\/src\/File\.ts"/);
      expect(res.failures[0]).toMatch(/Copy paths verbatim/);
    });

    it('rejects reordered batches the fanout would misaddress', async () => {
      const res = await evaluateGate(
        [check],
        withPublished([entry(batch(2, 26, 5)), entry(batch(1, 1, 25))]),
      );
      expect(res.pass).toBe(false);
      expect(res.failures[0]).toMatch(/batchNumber 2, expected 1/);
    });

    it('rejects a wrapper object around the array', async () => {
      const res = await evaluateGate(
        [check],
        withPublished({ batches: [entry(batch(1, 1, 25)), entry(batch(2, 26, 5))] }),
      );
      expect(res.pass).toBe(false);
      expect(res.failures[0]).toMatch(/must BE a JSON array/);
    });

    it('rejects a duplicated path even when it matches the manifest', async () => {
      // Verbatim comparison catches a retyped path first, so this branch only
      // fires when the CORPUS itself double-claims a file. It must still fail:
      // one path in two batches means two reviewers own it and the coverage
      // arithmetic downstream still adds up.
      const dup = batch(2, 26, 5);
      dup.paths = [...dup.paths];
      dup.paths[0] = 'packages/p1/src/file.ts';
      const r = splitReader(
        {},
        {
          [MANIFEST]: JSON.stringify({ totalFiles: 30, batches: [batch(1, 1, 25), dup] }),
          'pr-review/batches.json': JSON.stringify([entry(batch(1, 1, 25)), entry(dup)]),
        },
      );
      const res = await evaluateGate([check], r);
      expect(res.pass).toBe(false);
      expect(res.failures[0]).toMatch(/appears in more than one batch/);
    });

    it('fails closed when the corpus manifest is missing', async () => {
      const r = splitReader(
        {},
        { 'pr-review/batches.json': JSON.stringify([entry(batch(1, 1, 25))]) },
      );
      const res = await evaluateGate([check], r);
      expect(res.pass).toBe(false);
      expect(res.failures[0]).toMatch(/no '\*-files\.json' manifest/);
    });

    it('fails closed when two manifests could be the source of truth', async () => {
      const r = splitReader(
        {},
        {
          [MANIFEST]: MANIFEST_JSON,
          [`${CORPUS}/attachments/002/pr-34-files.json`]: MANIFEST_JSON,
          'pr-review/batches.json': JSON.stringify([
            entry(batch(1, 1, 25)),
            entry(batch(2, 26, 5)),
          ]),
        },
      );
      const res = await evaluateGate([check], r);
      expect(res.pass).toBe(false);
      expect(res.failures[0]).toMatch(/2 '\*-files\.json' manifests/);
    });

    it('fails closed without an artifact accessor', async () => {
      const res = await evaluateGate(
        [check],
        reader({ 'pr-review/batches.json': JSON.stringify([entry(batch(1, 1, 25))]) }),
      );
      expect(res.pass).toBe(false);
    });

    it('reports a missing batch file as missing, not malformed', async () => {
      const res = await evaluateGate([check], splitReader({}, { [MANIFEST]: MANIFEST_JSON }));
      expect(res.pass).toBe(false);
      expect(res.failures[0]).toMatch(/not found/);
    });
  });

  it('an artifact-flagged check fails closed when the reader has no artifact accessor', async () => {
    // A plain reader (no readArtifact) must not silently pass an artifact
    // check by reading the wrong tree — it fails "not found" instead.
    const r = reader({ 'reports/threat-model.md': 'x'.repeat(2000) });
    const res = await evaluateGate(
      [{ kind: 'minBytes', file: 'reports/threat-model.md', bytes: 1500, artifact: true }],
      r,
    );
    expect(res.pass).toBe(false);
  });

  it('corpusCoverage requires every connector-materialized PR path', async () => {
    const artifactRecord = (path: string) =>
      `---\npath: ${path}\nstatus: modified\n---\n\n# ${path}\n\n\`\`\`diff\n+changed\n\`\`\``;
    const artifacts = {
      'data/github-pulls/pr-52/files/001--early--aaaa1111.md': artifactRecord('src/early.ts'),
      'data/github-pulls/pr-52/files/002--late--bbbb2222.md': artifactRecord(
        'packages/client/src/client.ts',
      ),
      'data/github-pulls/pr-52/001--overview--cccc3333.md': '# overview',
    };
    const earlyRecord = 'data/github-pulls/pr-52/files/001--early--aaaa1111.md';
    const lateRecord = 'data/github-pulls/pr-52/files/002--late--bbbb2222.md';
    const check = {
      kind: 'corpusCoverage' as const,
      file: 'pr-review-coverage.json',
      corpusDir: 'artifacts/data/github-pulls/pr-52',
    };

    const partial = await evaluateGate(
      [check],
      splitReader(
        {
          'pr-review-coverage.json': JSON.stringify({
            reviewedFiles: ['src/early.ts'],
            reviewedRecords: [earlyRecord],
          }),
        },
        artifacts,
      ),
    );
    expect(partial.pass).toBe(false);
    expect(partial.failures[0]).toContain('packages/client/src/client.ts');

    const invented = await evaluateGate(
      [check],
      splitReader(
        {
          'pr-review-coverage.json': JSON.stringify({
            reviewedFiles: [
              'src/early.ts',
              'packages/client/src/client.ts',
              'packages/client/src/node/client.ts',
            ],
            reviewedRecords: [earlyRecord, lateRecord],
          }),
        },
        artifacts,
      ),
    );
    expect(invented.pass).toBe(false);
    expect(invented.failures[0]).toContain('Not in PR');

    const complete = await evaluateGate(
      [check],
      splitReader(
        {
          'pr-review-coverage.json': JSON.stringify({
            reviewedFiles: ['src/early.ts', 'packages/client/src/client.ts'],
            reviewedRecords: [`artifacts/${earlyRecord}`, lateRecord],
          }),
        },
        artifacts,
      ),
    );
    expect(complete.pass).toBe(true);
    expect(complete.checks[0]?.detail).toContain('all 2 changed path');
  });

  // Declarative fanout: each batch child is gated on its own slice, so it
  // can pass without covering files nobody handed it.
  describe('corpusCoverage expectPaths (fanout batch scoping)', () => {
    const record = (path: string) => `---\npath: ${path}\nstatus: modified\n---\n`;
    const artifacts = {
      'data/github-pulls/pr-52/files/001--a--aaaa1111.md': record('src/a.ts'),
      'data/github-pulls/pr-52/files/002--b--bbbb2222.md': record('src/b.ts'),
      'data/github-pulls/pr-52/files/003--c--cccc3333.md': record('src/c.ts'),
    };
    const batchCheck = (expectPaths: string) => ({
      kind: 'corpusCoverage' as const,
      file: 'coverage-2.json',
      corpusDir: 'artifacts/data/github-pulls/pr-52',
      expectPaths,
    });
    const ledger = (files: string[], records: string[]) =>
      splitReader(
        { 'coverage-2.json': JSON.stringify({ reviewedFiles: files, reviewedRecords: records }) },
        artifacts,
      );

    it('passes on the batch slice while the wider corpus is untouched', async () => {
      const res = await evaluateGate(
        [batchCheck(JSON.stringify(['src/b.ts', 'src/c.ts']))],
        ledger(
          ['src/b.ts', 'src/c.ts'],
          [
            'data/github-pulls/pr-52/files/002--b--bbbb2222.md',
            'data/github-pulls/pr-52/files/003--c--cccc3333.md',
          ],
        ),
      );
      expect(res.pass).toBe(true);
      expect(res.checks[0]?.detail).toContain('all 2 changed path(s) in this batch');
      expect(res.checks[0]?.evidence?.scopedToBatch).toBe(true);
    });

    it('still names what the batch itself is missing', async () => {
      const res = await evaluateGate(
        [batchCheck(JSON.stringify(['src/b.ts', 'src/c.ts']))],
        ledger(['src/b.ts'], ['data/github-pulls/pr-52/files/002--b--bbbb2222.md']),
      );
      expect(res.pass).toBe(false);
      expect(res.failures[0]).toContain('this batch covers 2');
      expect(res.failures[0]).toContain('src/c.ts');
      // The converging-loop accounting still applies per child.
      expect(res.checks[0]?.remaining).toBe(2);
    });

    it('rejects work claimed outside the batch', async () => {
      const res = await evaluateGate(
        [batchCheck(JSON.stringify(['src/b.ts']))],
        ledger(['src/b.ts', 'src/a.ts'], ['data/github-pulls/pr-52/files/002--b--bbbb2222.md']),
      );
      expect(res.pass).toBe(false);
      expect(res.failures[0]).toContain('Outside this batch: src/a.ts');
    });

    it('fails closed on an uninterpolated or malformed slice', async () => {
      const raw = await evaluateGate([batchCheck('{{paths}}')], ledger([], []));
      expect(raw.pass).toBe(false);
      expect(raw.failures[0]).toContain('never reached this gate');

      const wrongShape = await evaluateGate([batchCheck('[1, 2]')], ledger([], []));
      expect(wrongShape.pass).toBe(false);
      expect(wrongShape.failures[0]).toContain('non-empty JSON array');
    });

    it('fails closed when the batch names a path the corpus never mirrored', async () => {
      const res = await evaluateGate(
        [batchCheck(JSON.stringify(['src/b.ts', 'src/ghost.ts']))],
        ledger(['src/b.ts'], ['data/github-pulls/pr-52/files/002--b--bbbb2222.md']),
      );
      expect(res.pass).toBe(false);
      expect(res.failures[0]).toContain('src/ghost.ts');
      expect(res.failures[0]).toContain('no corpus record');
    });
  });

  it('corpusCoverage reads an artifact-flagged ledger from the drawer', async () => {
    // Review bookkeeping belongs in the drawer, which is also the only
    // surface a writes-off project leaves writable. The ledger used to be
    // read from the workspace whatever the flag said, so the drawer copy
    // read as "ledger not found".
    const artifactRecord = (path: string) => `---\npath: ${path}\nstatus: modified\n---\n`;
    const ledger = JSON.stringify({
      reviewedFiles: ['src/early.ts'],
      reviewedRecords: ['data/github-pulls/pr-52/files/001--early--aaaa1111.md'],
    });
    const check = {
      kind: 'corpusCoverage' as const,
      file: 'pr-review-coverage.json',
      corpusDir: 'artifacts/data/github-pulls/pr-52',
      artifact: true,
    };

    const res = await evaluateGate(
      [check],
      splitReader(
        {},
        {
          'pr-review-coverage.json': ledger,
          'data/github-pulls/pr-52/files/001--early--aaaa1111.md': artifactRecord('src/early.ts'),
        },
      ),
    );
    expect(res.pass).toBe(true);

    const workspaceOnly = await evaluateGate(
      [check],
      splitReader(
        { 'pr-review-coverage.json': ledger },
        { 'data/github-pulls/pr-52/files/001--early--aaaa1111.md': artifactRecord('src/early.ts') },
      ),
    );
    expect(workspaceOnly.pass).toBe(false);
    expect(workspaceOnly.failures[0]).toContain('not found');
  });

  it('notContains rejects forbidden content with a repairable gap', async () => {
    const res = await evaluateGate(
      [{ kind: 'notContains', file: 'CHANGELOG.md', pattern: 'Internal|CI', flags: 'i' }],
      reader({ 'CHANGELOG.md': '# 2.4.0\n\n- Internal reducer rename.\n' }),
    );
    expect(res.pass).toBe(false);
    expect(res.failures[0]).toContain('forbidden content');

    const ok = await evaluateGate(
      [{ kind: 'notContains', file: 'CHANGELOG.md', pattern: 'Internal|CI', flags: 'i' }],
      reader({ 'CHANGELOG.md': '# 2.4.0\n\n- Added CSV export.\n' }),
    );
    expect(ok.pass).toBe(true);
  });

  it('uses pattern labels in repair feedback', async () => {
    const res = await evaluateGate(
      [
        {
          kind: 'contains',
          file: 'press-release.md',
          pattern: 'BOSTON',
          label: 'include the dated dateline',
        },
      ],
      reader({ 'press-release.md': '# Draft\n' }),
    );
    expect(res.pass).toBe(false);
    // The verdict quotes the requirement (label + pattern) AND what was
    // observed (byte count) — Law 3: name the gap, not just the rule.
    expect(res.failures[0]).toBe(
      'press-release.md is missing required content: include the dated dateline — nothing in its 8 bytes matches /BOSTON/. Add that content.',
    );
  });

  it('includes the matched text for labeled forbidden content', async () => {
    const res = await evaluateGate(
      [
        {
          kind: 'notContains',
          file: 'press-release.md',
          pattern: 'significant(?:ly)?',
          flags: 'i',
          label: 'remove promotional wording',
        },
      ],
      reader({ 'press-release.md': 'This is a significant improvement.' }),
    );
    expect(res.pass).toBe(false);
    expect(res.failures[0]).toBe(
      'press-release.md contains forbidden content: remove promotional wording (matched "significant")',
    );
  });

  it('csvShape rejects malformed CSV shape and disallowed values', async () => {
    const check = {
      kind: 'csvShape' as const,
      file: 'updates.csv',
      exactColumns: ['object_type', 'email', 'status'],
      minRows: 2,
      allowedValues: { status: ['Active', 'Renewal Risk', 'Expansion', 'UNMATCHED'] },
    };
    const ok = await evaluateGate(
      [check],
      reader({
        'updates.csv':
          'object_type,email,status\nContact,a@example.com,Expansion\nContact,b@example.com,Renewal Risk\n',
      }),
    );
    expect(ok.pass).toBe(true);

    const bad = await evaluateGate(
      [check],
      reader({
        'updates.csv':
          'object_type,email,status\nContact,a@example.com,Bad\nContact,b@example.com,Active\n',
      }),
    );
    expect(bad.pass).toBe(false);
    expect(bad.failures[0]).toContain('expected one of');

    const ragged = await evaluateGate(
      [check],
      reader({
        'updates.csv':
          'object_type,email,status\nContact,a@example.com\nContact,b@example.com,Active\n',
      }),
    );
    expect(ragged.pass).toBe(false);
    expect(ragged.failures[0]).toContain('Keep empty placeholders as adjacent commas');
  });

  it('unsupportedClaims rejects risky wording that is not source-grounded', async () => {
    const res = await evaluateGate(
      [
        {
          kind: 'unsupportedClaims',
          file: 'press-release.md',
          sourceFiles: ['source/news-brief.md'],
          patterns: [{ pattern: 'customer experience', label: 'avoid invented benefit claims' }],
        },
      ],
      reader({
        'source/news-brief.md': 'Boreal Desk is launching guided returns intake.',
        'press-release.md': 'The launch improves the customer experience.',
      }),
    );
    expect(res.pass).toBe(false);
    expect(res.failures[0]).toBe(
      'press-release.md has unsupported claim wording: avoid invented benefit claims (matched "customer experience") — rewrite it using only source facts from source/news-brief.md or remove it.',
    );
  });

  it('unsupportedClaims allows risky wording when the source contains the phrase', async () => {
    const res = await evaluateGate(
      [
        {
          kind: 'unsupportedClaims',
          file: 'press-release.md',
          sourceFiles: ['source/news-brief.md'],
          patterns: [{ pattern: 'high-volume clients?', label: 'avoid invented audience claims' }],
        },
      ],
      reader({
        'source/news-brief.md': 'Audience: high-volume clients.',
        'press-release.md': 'The release serves high-volume clients.',
      }),
    );
    expect(res.pass).toBe(true);
  });

  it('jsParses: passes clean inline JS, fails broken JS with the parse error', async () => {
    const clean = reader({
      'index.html': '<canvas></canvas><script>function tick(){ if (a) { run(); } }</script></body>',
    });
    expect((await evaluateGate([{ kind: 'jsParses', file: 'index.html' }], clean)).pass).toBe(true);

    const broken = await evaluateGate(
      [{ kind: 'jsParses', file: 'index.html' }],
      // Extra `)` — the unbalanced-paren shape qwen3.5-9b shipped on tankcombat.
      reader({ 'index.html': '<script>function tick(){ if (a)) { run(); } }</script>' }),
    );
    expect(broken.pass).toBe(false);
    expect(broken.failures[0]).toMatch(/inline JavaScript does not parse/);
  });

  it('jsParses: a page with no inline JS passes (nothing to judge); defaults to index.html', async () => {
    const r = reader({ 'index.html': '<h1>static page</h1><p>no script here</p></body>' });
    expect((await evaluateGate([{ kind: 'jsParses' }], r)).pass).toBe(true);
  });

  it('jsParses: missing file fails rather than throwing', async () => {
    const res = await evaluateGate([{ kind: 'jsParses', file: 'index.html' }], reader({}));
    expect(res.pass).toBe(false);
    expect(res.failures[0]).toMatch(/not found/);
  });

  it('htmlLint: rejects duplicate handler declarations and passes a clean static page', async () => {
    const duplicate = await evaluateGate(
      [{ kind: 'htmlLint', file: 'index.html' }],
      reader({
        'index.html':
          '<html><body><script>function act(){} function act(){}</script></body></html>',
      }),
    );
    expect(duplicate.pass).toBe(false);
    expect(duplicate.failures[0]).toContain('top-level-functions-unique');

    const clean = await evaluateGate(
      [{ kind: 'htmlLint', file: 'index.html' }],
      reader({ 'index.html': '<!DOCTYPE html><html><body><h1>Static</h1></body></html>' }),
    );
    expect(clean.pass).toBe(true);
    expect(clean.checks[0]?.label).toBe('htmlLint index.html');
  });

  it('reports a missing file rather than throwing', async () => {
    const res = await evaluateGate(
      [{ kind: 'sniff', file: 'index.html', sniff: 'html-complete' }],
      reader({}),
    );
    expect(res.pass).toBe(false);
    expect(res.failures[0]).toMatch(/not found/);
  });

  it('esmImports: flags a wrong-source node: import with the fix; passes the corrected split', async () => {
    const bad = await evaluateGate(
      [{ kind: 'esmImports', file: 'contract-test.mjs' }],
      reader({ 'contract-test.mjs': "import { dirname, fileURLToPath } from 'node:url';" }),
    );
    expect(bad.pass).toBe(false);
    expect(bad.failures[0]).toMatch(/dirname/);
    expect(bad.failures[0]).toMatch(/node:path/);

    const ok = await evaluateGate(
      [{ kind: 'esmImports', file: 'contract-test.mjs' }],
      reader({
        'contract-test.mjs':
          "import { fileURLToPath } from 'node:url';\nimport { dirname } from 'node:path';",
      }),
    );
    expect(ok.pass).toBe(true);
  });

  it('esmImports: missing file fails rather than throwing', async () => {
    const res = await evaluateGate([{ kind: 'esmImports', file: 'x.mjs' }], reader({}));
    expect(res.pass).toBe(false);
    expect(res.failures[0]).toMatch(/not found/);
  });

  it('sniff data-table: passes real output, rejects a stub with a prescriptive "run it" gap', async () => {
    const ok = await evaluateGate(
      [{ kind: 'sniff', file: 'out/data.json', sniff: 'data-table' }],
      reader({ 'out/data.json': '[{"email":"a@b.com","name":"A"}]' }),
    );
    expect(ok.pass).toBe(true);

    const bad = await evaluateGate(
      [{ kind: 'sniff', file: 'out/data.json', sniff: 'data-table' }],
      reader({ 'out/data.json': '[]' }),
    );
    expect(bad.pass).toBe(false);
    expect(bad.failures[0]).toMatch(/not parseable data/);
    expect(bad.failures[0]).toMatch(/RUN it and write the produced data/);
  });
});

describe('evaluateGate — hardened kinds', () => {
  it('sourceParses: a truncated .ts rejects with line:column; a valid one passes', async () => {
    const ok = await evaluateGate(
      [{ kind: 'sourceParses', file: 'src/parser.ts' }],
      reader({
        'src/parser.ts': 'export function parse(x: string): number {\n  return x.length;\n}\n',
      }),
    );
    expect(ok.pass).toBe(true);

    const bad = await evaluateGate(
      [{ kind: 'sourceParses', file: 'src/parser.ts' }],
      reader({ 'src/parser.ts': 'export function parse(x: string): number {\n  return x.len' }),
    );
    expect(bad.pass).toBe(false);
    expect(bad.failures[0]).toMatch(/does not parse/);
    expect(bad.failures[0]).toMatch(/line \d+:\d+/);
  });

  it('sourceParses: html delegates to the inline-JS path', async () => {
    const bad = await evaluateGate(
      [{ kind: 'sourceParses', file: 'index.html' }],
      reader({ 'index.html': '<html><body><script>function broken( {</script></body></html>' }),
    );
    expect(bad.pass).toBe(false);
    expect(bad.failures[0]).toMatch(/inline JavaScript does not parse/);
  });

  it('tableShape: markdown table columns + row floor', async () => {
    const table = '| name | total |\n|---|---|\n| a | 1 |\n| b | 2 |\n';
    const ok = await evaluateGate(
      [{ kind: 'tableShape', file: 'report.md', requiredColumns: ['name', 'total'], minRows: 2 }],
      reader({ 'report.md': table }),
    );
    expect(ok.pass).toBe(true);
    const bad = await evaluateGate(
      [{ kind: 'tableShape', file: 'report.md', requiredColumns: ['name', 'price'] }],
      reader({ 'report.md': table }),
    );
    expect(bad.pass).toBe(false);
    expect(bad.failures[0]).toMatch(/missing required column "price"/);
  });

  it('recordSchema: JSON records conform to the declared fields', async () => {
    const data = JSON.stringify([
      { email: 'a@b.com', total: '12' },
      { email: 'c@d.com', total: '9' },
    ]);
    const ok = await evaluateGate(
      [
        {
          kind: 'recordSchema',
          file: 'out/orders.json',
          fields: [
            { name: 'email', type: 'email' },
            { name: 'total', type: 'number' },
          ],
          minRows: 2,
        },
      ],
      reader({ 'out/orders.json': data }),
    );
    expect(ok.pass).toBe(true);

    const bad = await evaluateGate(
      [
        {
          kind: 'recordSchema',
          file: 'out/orders.json',
          fields: [{ name: 'email', type: 'email' }, { name: 'status' }],
        },
      ],
      reader({ 'out/orders.json': data }),
    );
    expect(bad.pass).toBe(false);
    expect(bad.failures[0]).toMatch(/missing required field "status"/);
  });

  it('nodeRuns: fail-closed without an executor; verdict follows exit code with one', async () => {
    const noExec = await evaluateGate(
      [{ kind: 'nodeRuns', file: 'test.mjs' }],
      reader({ 'test.mjs': 'process.exit(0)' }),
    );
    expect(noExec.pass).toBe(false);
    expect(noExec.failures[0]).toMatch(/execution check unavailable/);

    const pass = await evaluateGate(
      [{ kind: 'nodeRuns', file: 'test.mjs' }],
      reader({ 'test.mjs': 'x' }),
      { sandboxExec: async () => ({ exitCode: 0, stderrTail: '', timedOut: false }) },
    );
    expect(pass.pass).toBe(true);

    const fail = await evaluateGate(
      [{ kind: 'nodeRuns', file: 'test.mjs' }],
      reader({ 'test.mjs': 'x' }),
      {
        sandboxExec: async () => ({
          exitCode: 1,
          stderrTail: 'AssertionError: expected 2 to equal 3',
          timedOut: false,
        }),
      },
    );
    expect(fail.pass).toBe(false);
    expect(fail.failures[0]).toMatch(/exited with code 1/);
    expect(fail.failures[0]).toMatch(/AssertionError/);

    const denied = await evaluateGate(
      [{ kind: 'nodeRuns', file: 'test.mjs' }],
      reader({ 'test.mjs': 'x' }),
      {
        sandboxExec: async () => ({
          exitCode: 1,
          stderrTail: 'Security policy: script execution is disabled',
          timedOut: false,
          denied: true,
        }),
      },
    );
    expect(denied.pass).toBe(false);
    expect(denied.failures[0]).toMatch(/Security policy/);

    const missingDep = await evaluateGate(
      [{ kind: 'nodeRuns', file: 'test.mjs' }],
      reader({ 'test.mjs': 'x' }),
      {
        sandboxExec: async () => ({
          exitCode: 1,
          stderrTail: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'lodash'",
          timedOut: false,
        }),
      },
    );
    expect(missingDep.pass).toBe(false);
    expect(missingDep.failures[0]).toMatch(/dependency-free files/);
  });

  it('returns structured per-check outcomes with stable labels and evidence', async () => {
    const res = await evaluateGate(
      [
        { kind: 'minBytes', file: 'report.md', bytes: 4 },
        { kind: 'contains', file: 'report.md', pattern: 'Total revenue' },
        { kind: 'jsonPathEquals', file: 'data.json', path: 'count', value: 5 },
      ],
      reader({ 'report.md': '# Draft report\n', 'data.json': '{"count": 3}' }),
    );
    expect(res.pass).toBe(false);
    expect(res.checks).toHaveLength(3);
    expect(res.checks.map((c) => c.label)).toEqual([
      'minBytes report.md',
      'contains report.md /Total revenue/',
      'jsonPathEquals data.json count',
    ]);
    expect(res.checks[0]).toMatchObject({ kind: 'minBytes', file: 'report.md', ok: true });
    expect(res.checks[1]).toMatchObject({ kind: 'contains', ok: false });
    const jsonCheck = res.checks[2]!;
    expect(jsonCheck.ok).toBe(false);
    expect(jsonCheck.evidence).toMatchObject({ actual: 3 });
    // failures[] stays derived from the failing details.
    expect(res.failures).toHaveLength(2);
    expect(res.failures).toEqual(res.checks.filter((c) => !c.ok).map((c) => c.detail));
  });

  it('sniff failures name the actual gap instead of restating the rule', async () => {
    const truncated = await evaluateGate(
      [{ kind: 'sniff', file: 'index.html', sniff: 'html-complete' }],
      reader({ 'index.html': '<html><body><script>const a = 1;' }),
    );
    expect(truncated.pass).toBe(false);
    expect(truncated.failures[0]).toContain('truncated mid-script');

    const noGame = await evaluateGate(
      [{ kind: 'sniff', file: 'index.html', sniff: 'html-game' }],
      reader({ 'index.html': '<html><body><p>static page</p></body></html>' }),
    );
    expect(noGame.pass).toBe(false);
    expect(noGame.failures[0]).toContain('no render surface');

    const badJson = await evaluateGate(
      [{ kind: 'sniff', file: 'out.json', sniff: 'json-valid' }],
      reader({ 'out.json': '{"a": 1,}' }),
    );
    expect(badJson.pass).toBe(false);
    expect(badJson.failures[0]).toContain('not valid JSON:');
  });

  it('citationsResolve: quotes fabricated citations; corpus allowlists URLs', async () => {
    const fabricated = await evaluateGate(
      [{ kind: 'citationsResolve', file: 'review.md' }],
      reader({
        'review.md': 'See `src/real.ts` and `lib/invented.ts` for details.',
        'src/real.ts': 'export {};',
      }),
    );
    expect(fabricated.pass).toBe(false);
    expect(fabricated.failures[0]).toContain('lib/invented.ts');
    const outcome = fabricated.checks[0]!;
    expect(outcome.evidence).toMatchObject({ unresolved: ['lib/invented.ts'] });

    const grounded = await evaluateGate(
      [{ kind: 'citationsResolve', file: 'review.md' }],
      reader({
        'review.md': 'See `src/real.ts`.',
        'src/real.ts': 'export {};',
      }),
    );
    expect(grounded.pass).toBe(true);

    const noCitationRequired = await evaluateGate(
      [{ kind: 'citationsResolve', file: 'review.md', minCitations: 0 }],
      reader({ 'review.md': 'Original proposals only; no factual sources used.' }),
    );
    expect(noCitationRequired.pass).toBe(true);

    const optionalStillRejectsFabrication = await evaluateGate(
      [{ kind: 'citationsResolve', file: 'review.md', minCitations: 0 }],
      reader({ 'review.md': 'See `invented/source.md`.' }),
    );
    expect(optionalStillRejectsFabrication.pass).toBe(false);
    expect(optionalStillRejectsFabrication.failures.join('\n')).toContain('invented/source.md');
  });

  it('citationsResolve forgives task-supplied metadata paths via deps.knownCitationPaths', async () => {
    // The powerpoint-deck wild catch: the research packet records its
    // invocation inputs (`tasks/8`, the future deck path) as the procedure
    // requires, and those tokens must not read as fabricated citations.
    const packet =
      'Working folder `tasks/8/`; deck lands at `powerpoint/task-8/deck.pptx`. Research skipped.';
    const forgiven = await evaluateGate(
      [{ kind: 'citationsResolve', file: 'sources.md', minCitations: 0 }],
      reader({ 'sources.md': packet }),
      { knownCitationPaths: ['tasks/8', 'powerpoint/task-8/deck.pptx'] },
    );
    expect(forgiven.pass).toBe(true);
    expect(forgiven.checks[0]!.evidence).toMatchObject({
      forgiven: ['tasks/8/', 'powerpoint/task-8/deck.pptx'],
    });

    // A path outside the supplied set is still fabrication.
    const stillCaught = await evaluateGate(
      [{ kind: 'citationsResolve', file: 'sources.md', minCitations: 0 }],
      reader({ 'sources.md': `${packet} Evidence in \`data/market.csv\`.` }),
      { knownCitationPaths: ['tasks/8', 'powerpoint/task-8/deck.pptx'] },
    );
    expect(stillCaught.pass).toBe(false);
    expect(stillCaught.failures.join('\n')).toContain('data/market.csv');
  });

  it('taskSuppliedCitationPaths collects param values and prompt path tokens', () => {
    const paths = taskSuppliedCitationPaths({
      stepPrompt:
        'Files outside it—including an earlier `notes/outline.md`, root `deck.md`—are not inputs. Write `tasks/8/sources.md` with the boundary.',
      params: {
        topic: 'AI startup ideas',
        outputDir: 'powerpoint/task-8',
        outputPath: 'powerpoint/task-8/deck.pptx',
        sourcePath: '',
      },
      artifactDir: 'tasks/8',
    });
    expect(paths).toContain('powerpoint/task-8');
    expect(paths).toContain('powerpoint/task-8/deck.pptx');
    expect(paths).toContain('tasks/8');
    expect(paths).toContain('notes/outline.md');
    expect(paths).toContain('tasks/8/sources.md');
    expect(paths).toContain('AI startup ideas');
    expect(paths).not.toContain('');
    // `deck.md` carries no slash — the citation extractor would never
    // count it either, so it need not be collected.
    expect(paths).not.toContain('deck.md');
  });

  it('researchEvidence fails closed without observable successful source retrieval', async () => {
    const check = {
      kind: 'researchEvidence' as const,
      sourcePath: '',
      tools: ['wikipedia_search', 'fetch_url', 'browser_navigate'],
    };
    const unavailable = await evaluateGate([check], reader({}));
    expect(unavailable.pass).toBe(false);
    expect(unavailable.failures.join('\n')).toContain('unavailable');

    const empty = await evaluateGate([check], reader({}), {
      researchEvidence: async () => ({ observable: true, matches: [] }),
    });
    expect(empty.pass).toBe(false);
    expect(empty.failures.join('\n')).toContain('No verifiable source acquisition');

    const observed = await evaluateGate([check], reader({}), {
      researchEvidence: async () => ({
        observable: true,
        matches: [
          {
            tool: 'wikipedia_search',
            target: 'Battle of Trafalgar',
            at: '2026-08-06T00:00:00.000Z',
          },
        ],
      }),
    });
    expect(observed.pass).toBe(true);

    const optionalExternal = { ...check, externalOptional: true };
    const optionalUnavailable = await evaluateGate([optionalExternal], reader({}));
    expect(optionalUnavailable.pass).toBe(true);
    expect(optionalUnavailable.checks[0]?.detail).toContain('optional');

    const optionalEmpty = await evaluateGate([optionalExternal], reader({}), {
      researchEvidence: async () => ({ observable: true, matches: [] }),
    });
    expect(optionalEmpty.pass).toBe(true);
    expect(optionalEmpty.checks[0]?.detail).toContain('No successful external source acquisition');

    const localSourceStillRequired = await evaluateGate(
      [{ ...optionalExternal, sourcePath: 'source/brief.md' }],
      reader({ 'source/brief.md': 'authoritative facts' }),
      { researchEvidence: async () => ({ observable: true, matches: [] }) },
    );
    expect(localSourceStillRequired.pass).toBe(false);
    expect(localSourceStillRequired.failures.join('\n')).toContain('source/brief.md');
  });

  it('markdownHeadingsMatch rejects a deck that drops a locked outline slide', async () => {
    const result = await evaluateGate(
      [
        {
          kind: 'markdownHeadingsMatch',
          file: 'deck.md',
          outlineFile: 'notes/outline.md',
        },
      ],
      reader({
        'notes/outline.md':
          '## Slide 1 — Opening\n## Slide 2 — Turning point\n## Slide 3 — Next step',
        'deck.md': '# Opening\n# Next step',
      }),
    );
    expect(result.pass).toBe(false);
    expect(result.failures.join('\n')).toContain('2 H1 slide headings');
  });

  it('markdownHeadingsMatch can compare workspace Markdown with an artifact outline', async () => {
    const result = await evaluateGate(
      [
        {
          kind: 'markdownHeadingsMatch',
          file: 'deck.md',
          outlineFile: 'notes/outline.md',
          outlineArtifact: true,
        },
      ],
      splitReader(
        { 'deck.md': '# Opening\n# Next step' },
        { 'notes/outline.md': '## Slide 1 — Opening\n## Slide 2 — Next step' },
      ),
    );
    expect(result.pass).toBe(true);
  });

  it('valueGrounding: rejects decoy values and quotes the offending pattern', async () => {
    const facts = [{ id: 'q3-revenue', required: ['\\$4\\.2M'], forbidden: ['\\$7\\.9M'] }];
    const decoyed = await evaluateGate(
      [{ kind: 'valueGrounding', file: 'brief.md', facts }],
      reader({ 'brief.md': 'Q3 revenue was $7.9M.' }),
    );
    expect(decoyed.pass).toBe(false);
    expect(decoyed.failures[0]).toContain('forbidden value');

    const grounded = await evaluateGate(
      [{ kind: 'valueGrounding', file: 'brief.md', facts }],
      reader({ 'brief.md': 'Q3 revenue was $4.2M.' }),
    );
    expect(grounded.pass).toBe(true);
    expect(grounded.checks[0]?.evidence).toMatchObject({ signals: ['q3-revenue'] });
  });

  it('valuesSubsetOf: names invented ids, resolves glob sources, and fails loudly with no sources', async () => {
    const files = {
      'out/customers.json': '[{"id":"C-001"},{"id":"A-002"}]',
      'data/raw/a.csv': 'id\nA-001\nA-002',
      'data/raw/b.csv': 'id\nB-003',
    };
    const check = {
      kind: 'valuesSubsetOf' as const,
      file: 'out/customers.json',
      sourceFiles: ['data/**'],
      pattern: '\\b([A-Z]-\\d{3})\\b',
    };
    const invented = await evaluateGate([check], reader(files));
    expect(invented.pass).toBe(false);
    expect(invented.failures[0]).toContain('C-001');
    expect(invented.checks[0]?.evidence).toMatchObject({ invented: ['C-001'] });

    const preserved = await evaluateGate(
      [check],
      reader({ ...files, 'out/customers.json': '[{"id":"A-001"},{"id":"B-003"}]' }),
    );
    expect(preserved.pass).toBe(true);

    const sourceless = await evaluateGate([check], reader({ 'out/customers.json': '[]' }));
    expect(sourceless.pass).toBe(false);
    expect(sourceless.failures[0]).toContain('no readable source files');
  });

  it('nodeRuns: appends the wrapper-return hint when stderr shows the shape', async () => {
    const res = await evaluateGate(
      [{ kind: 'nodeRuns', file: 'correct.mjs' }],
      reader({ 'correct.mjs': 'x' }),
      {
        sandboxExec: async () => ({
          exitCode: 1,
          stderrTail:
            'CASE dedupe-basic: expected [{"id":"a"}], got {"deduplicatedItems":[{"id":"a"}]}',
          timedOut: false,
        }),
      },
    );
    expect(res.pass).toBe(false);
    expect(res.failures[0]).toContain('Hint:');
    expect(res.failures[0]).toContain('"deduplicatedItems"');
    expect(res.checks[0]?.evidence).toMatchObject({ exitCode: 1 });
  });
});

describe('evaluateGate — planStructure', () => {
  const PLAN = [
    '| ID | Task | Owner | Depends on | Done when |',
    '| --- | --- | --- | --- | --- |',
    '| T1 | Survey the site | Beatrix | - | Survey notes reviewed by Cas |',
    '| T2 | Draft the layout | Cas | T1 | Layout approved in writing |',
  ].join('\n');

  it('passes a valid plan and reports row count', async () => {
    const res = await evaluateGate(
      [{ kind: 'planStructure', file: 'plan.md', minRows: 2, ownerRoster: ['Beatrix', 'Cas'] }],
      reader({ 'plan.md': PLAN }),
    );
    expect(res.pass).toBe(true);
    expect(res.checks[0]?.detail).toContain('plan table valid (2 rows');
  });

  it('missing file and Law-3 detail passthrough', async () => {
    const missing = await evaluateGate([{ kind: 'planStructure', file: 'plan.md' }], reader({}));
    expect(missing.pass).toBe(false);
    expect(missing.failures[0]).toContain('plan.md not found');

    const offRoster = await evaluateGate(
      [{ kind: 'planStructure', file: 'plan.md', ownerRoster: ['Beatrix'] }],
      reader({ 'plan.md': PLAN }),
    );
    expect(offRoster.pass).toBe(false);
    expect(offRoster.failures[0]).toContain('Owner "Cas" is not on the roster');
  });
});

describe('evaluateGate — judge', () => {
  const ARTIFACT =
    'We experienced a service interruption lasting 38 minutes on June 30. ' +
    'Affected customers will receive an automatic service credit.';
  const judgeCheck = { kind: 'judge' as const, file: 'notice.md', rubric: 'calm, factual tone' };
  const failVerdict = (quote: string) =>
    JSON.stringify({ verdict: 'fail', reasons: ['tone drifts'], evidence: [quote] });

  it('advisory fail (the default) approves with an [advisory] detail and telemetry evidence', async () => {
    const res = await evaluateGate([judgeCheck], reader({ 'notice.md': ARTIFACT }), {
      judgeExec: async () => ({
        text: failVerdict('We experienced a service interruption lasting 38 minutes'),
      }),
    });
    expect(res.pass).toBe(true);
    expect(res.checks[0]?.detail).toMatch(
      /^\[advisory\] notice\.md: judge would reject — tone drifts/,
    );
    expect(res.checks[0]?.detail).toContain('Evidence: "We experienced');
    expect(res.checks[0]?.evidence).toMatchObject({
      judge: { verdict: 'fail', advisory: true, reasons: ['tone drifts'] },
    });
  });

  it('enforcing fail (advisory:false) rejects quoting the evidence', async () => {
    const res = await evaluateGate(
      [{ ...judgeCheck, advisory: false }],
      reader({ 'notice.md': ARTIFACT }),
      {
        judgeExec: async () => ({
          text: failVerdict('Affected customers will receive an automatic service credit'),
        }),
      },
    );
    expect(res.pass).toBe(false);
    expect(res.failures[0]).toContain('judge would reject');
    expect(res.checks[0]?.evidence).toMatchObject({ judge: { advisory: false } });
  });

  it('a pass verdict approves with the first reason', async () => {
    const res = await evaluateGate([judgeCheck], reader({ 'notice.md': ARTIFACT }), {
      judgeExec: async () => ({
        text: '{"verdict":"pass","reasons":["consistently factual"],"evidence":[]}',
      }),
    });
    expect(res.pass).toBe(true);
    expect(res.checks[0]?.detail).toContain('judge pass — consistently factual');
  });

  it('fail-open ladder: no executor, unavailable, throw, unparseable, missing artifact', async () => {
    const cases: Array<{
      deps?: Parameters<typeof evaluateGate>[2];
      files: Record<string, string>;
      reason: RegExp;
    }> = [
      { files: { 'notice.md': ARTIFACT }, reason: /no judge executor wired/ },
      {
        files: { 'notice.md': ARTIFACT },
        deps: { judgeExec: async () => ({ unavailable: 'keurmeester not armed' }) },
        reason: /keurmeester not armed/,
      },
      {
        files: { 'notice.md': ARTIFACT },
        deps: {
          judgeExec: async () => {
            throw new Error('one-shot timeout');
          },
        },
        reason: /one-shot timeout/,
      },
      {
        files: { 'notice.md': ARTIFACT },
        deps: { judgeExec: async () => ({ text: 'looks fine to me!' }) },
        reason: /unparseable judge verdict/,
      },
      {
        files: {},
        deps: { judgeExec: async () => ({ text: failVerdict('anything') }) },
        reason: /notice\.md not found/,
      },
    ];
    for (const c of cases) {
      const res = await evaluateGate([judgeCheck], reader(c.files), c.deps);
      expect(res.pass).toBe(true);
      expect(res.checks[0]?.detail).toMatch(/judge unavailable/);
      expect(res.checks[0]?.detail).toMatch(c.reason);
      expect(res.checks[0]?.evidence).toMatchObject({ judge: { verdict: 'fail-open' } });
    }
  });

  it('fail-open on GEZEL_DISABLE_JUDGE_GATES=1', async () => {
    process.env.GEZEL_DISABLE_JUDGE_GATES = '1';
    try {
      const res = await evaluateGate([judgeCheck], reader({ 'notice.md': ARTIFACT }), {
        judgeExec: async () => ({ text: failVerdict('never called anyway') }),
      });
      expect(res.pass).toBe(true);
      expect(res.checks[0]?.detail).toContain('disabled by GEZEL_DISABLE_JUDGE_GATES');
    } finally {
      delete process.env.GEZEL_DISABLE_JUDGE_GATES;
    }
  });

  it('a fail verdict whose quotes all fail the verbatim wall loses the verdict (fail-open)', async () => {
    const res = await evaluateGate([judgeCheck], reader({ 'notice.md': ARTIFACT }), {
      judgeExec: async () => ({
        text: failVerdict('this exact sentence appears nowhere in the artifact today'),
      }),
    });
    expect(res.pass).toBe(true);
    expect(res.checks[0]?.detail).toContain('fail verdict had no verbatim evidence');
  });

  it('mechanical-first: a failed mechanical check skips the judge entirely', async () => {
    let called = 0;
    const res = await evaluateGate(
      [{ kind: 'minBytes', file: 'notice.md', bytes: 10_000 }, judgeCheck],
      reader({ 'notice.md': ARTIFACT }),
      {
        judgeExec: async () => {
          called += 1;
          return { text: failVerdict('x') };
        },
      },
    );
    expect(res.pass).toBe(false);
    expect(called).toBe(0);
    const judgeOutcome = res.checks.find((c) => c.kind === 'judge');
    expect(judgeOutcome?.ok).toBe(true);
    expect(judgeOutcome?.detail).toContain('judge skipped — mechanical checks failed');
    expect(judgeOutcome?.evidence).toMatchObject({ judge: { verdict: 'skipped' } });
  });

  it('threads rubric + sources into the prompt and clamps timeoutMs to 120s', async () => {
    let seenPrompt = '';
    let seenTimeout = 0;
    await evaluateGate(
      [
        {
          ...judgeCheck,
          sourceFiles: ['voice-guide.md', 'missing.md'],
          timeoutMs: 999_999,
        },
      ],
      reader({ 'notice.md': ARTIFACT, 'voice-guide.md': 'Use first person plural.' }),
      {
        judgeExec: async (prompt, timeoutMs) => {
          seenPrompt = prompt;
          seenTimeout = timeoutMs;
          return { text: '{"verdict":"pass","reasons":[],"evidence":[]}' };
        },
      },
    );
    expect(seenPrompt).toContain('Rubric: calm, factual tone');
    expect(seenPrompt).toContain('--- source: voice-guide.md ---');
    expect(seenPrompt).not.toContain('missing.md');
    expect(seenTimeout).toBe(120_000);
  });
});

// L1: the structural gate kinds wired onto the code/ETL/API/refactor
// craftbooks. Each proves the check REJECTS a large-but-wrong deliverable a
// `minBytes` floor would wave through, and PASSES a genuinely-correct one —
// the "large-but-wrong deliverable passes the gate" hole these gates close.
describe('evaluateGate — L1 structural discrimination (large-but-wrong vs minBytes)', () => {
  const PAD = `// ${'pad '.repeat(800)}\n`; // ~3.2 KB of valid filler, clears any minBytes floor

  it('sourceParses: rejects a large syntax-broken JS module, passes a well-formed one', async () => {
    // A server module that clears the byte floor but does not parse (the
    // function body is never closed) — rest-api / graphql-api / etl build gate.
    const brokenJs = `${PAD}export function createServer(req, res) {\n  res.end("ok");\n`;
    expect(brokenJs.length).toBeGreaterThan(2000);
    // minBytes WOULD wave the large-but-broken file through...
    expect(
      (
        await evaluateGate(
          [{ kind: 'minBytes', file: 'src/server.js', bytes: 200 }],
          reader({ 'src/server.js': brokenJs }),
        )
      ).pass,
    ).toBe(true);
    // ...the parse gate the book now carries rejects it.
    const bad = await evaluateGate(
      [{ kind: 'sourceParses', file: 'src/server.js' }],
      reader({ 'src/server.js': brokenJs }),
    );
    expect(bad.pass).toBe(false);
    expect(bad.failures[0]).toMatch(/does not parse/);

    const goodJs = `${PAD}import http from "node:http";\nexport function createServer() {\n  return http.createServer((_req, res) => { res.end("ok"); });\n}\n`;
    const ok = await evaluateGate(
      [{ kind: 'sourceParses', file: 'src/server.js' }],
      reader({ 'src/server.js': goodJs }),
    );
    expect(ok.pass).toBe(true);
  });

  it('sourceParses: rejects a broken .ts client, passes a typed one (sdk-wrapper)', async () => {
    // Unclosed class/method body — clears minBytes, fails the TS transpile.
    const brokenTs = `${PAD}export class Client {\n  constructor(private baseUrl: string) {}\n  async get<T>(path: string): Promise<T> {\n`;
    const bad = await evaluateGate(
      [{ kind: 'sourceParses', file: 'src/client.ts' }],
      reader({ 'src/client.ts': brokenTs }),
    );
    expect(bad.pass).toBe(false);
    expect(bad.failures[0]).toMatch(/does not parse/);

    const goodTs = `${PAD}export class Client {\n  constructor(private baseUrl: string) {}\n  async get<T>(path: string): Promise<T> { return {} as T; }\n}\n`;
    const ok = await evaluateGate(
      [{ kind: 'sourceParses', file: 'src/client.ts' }],
      reader({ 'src/client.ts': goodTs }),
    );
    expect(ok.pass).toBe(true);
  });

  it('nodeRuns: a large contract test that throws on run is rejected though minBytes passes', async () => {
    // ~5 KB test file: clears the byte floor, but exits non-zero when executed
    // (rest-api / bug-fix-tdd / data-pipeline-etl verify gate).
    const bigTest = `import assert from "node:assert";\n${'// pad\n'.repeat(700)}assert.strictEqual(2 + 2, 5);\n`;
    expect(bigTest.length).toBeGreaterThan(4000);
    expect(
      (
        await evaluateGate(
          [{ kind: 'minBytes', file: 'src/bug.test.js', bytes: 200 }],
          reader({ 'src/bug.test.js': bigTest }),
        )
      ).pass,
    ).toBe(true);
    // Red test (exit 1) → gate rejects with the failure tail.
    const red = await evaluateGate(
      [{ kind: 'nodeRuns', file: 'src/bug.test.js' }],
      reader({ 'src/bug.test.js': bigTest }),
      {
        sandboxExec: async () => ({
          exitCode: 1,
          stderrTail: 'AssertionError [ERR_ASSERTION]: 4 == 5',
          timedOut: false,
        }),
      },
    );
    expect(red.pass).toBe(false);
    expect(red.failures[0]).toMatch(/exited with code 1/);
    // Green test (exit 0) → gate approves.
    const green = await evaluateGate(
      [{ kind: 'nodeRuns', file: 'src/bug.test.js' }],
      reader({ 'src/bug.test.js': bigTest }),
      { sandboxExec: async () => ({ exitCode: 0, stderrTail: '', timedOut: false }) },
    );
    expect(green.pass).toBe(true);
  });

  it('csvShape shape-only: rejects a large ragged / header-only CSV, passes a well-formed table', async () => {
    // The exact config wired onto dataset-clean / csv-transformer: a
    // well-formed table with consistent columns and at least one data row.
    // No column names — a different-but-equally-good dataset of any schema passes.
    const check = {
      kind: 'csvShape' as const,
      file: 'data/output.csv',
      consistentColumns: true,
      minRows: 1,
    };
    // Ragged: a dropped delimiter leaves row 4 one column short — clears minBytes.
    const ragged = `id,name,email,amount\n1,Ada,ada@example.com,10\n2,Grace,grace@example.com,20\n3,Kay,kay@example.com\n${'pad0,pad1,pad2,pad3\n'.repeat(6)}`;
    expect(ragged.length).toBeGreaterThan(120);
    expect(
      (
        await evaluateGate(
          [{ kind: 'minBytes', file: 'data/output.csv', bytes: 120 }],
          reader({ 'data/output.csv': ragged }),
        )
      ).pass,
    ).toBe(true);
    const raggedRes = await evaluateGate([check], reader({ 'data/output.csv': ragged }));
    expect(raggedRes.pass).toBe(false);
    expect(raggedRes.failures[0]).toMatch(/column\(s\), expected/);

    // Header-only (zero data rows) — > 120 bytes, but fails the minRows floor.
    const headerOnly = `${Array.from({ length: 20 }, (_, i) => `column_${i}`).join(',')}\n`;
    expect(headerOnly.length).toBeGreaterThan(120);
    const headerRes = await evaluateGate([check], reader({ 'data/output.csv': headerOnly }));
    expect(headerRes.pass).toBe(false);
    expect(headerRes.failures[0]).toMatch(/0 data row/);

    // A well-formed table with consistent columns + rows passes.
    const good = 'id,name,email,amount\n1,Ada,ada@example.com,10\n2,Grace,grace@example.com,20\n';
    expect((await evaluateGate([check], reader({ 'data/output.csv': good }))).pass).toBe(true);
  });

  it('sniff data-table: rejects an empty array and a large non-array blob, passes a record array', async () => {
    // scrape-to-structured output gate: minBytes:2 waved through `[]` (a scrape
    // that found nothing) and any 2-byte JSON; data-table requires real records.
    expect(
      (
        await evaluateGate(
          [{ kind: 'sniff', file: 'data.json', sniff: 'data-table' }],
          reader({ 'data.json': '[]' }),
        )
      ).pass,
    ).toBe(false);
    expect(
      (
        await evaluateGate(
          [{ kind: 'minBytes', file: 'data.json', bytes: 2 }],
          reader({ 'data.json': '[]' }),
        )
      ).pass,
    ).toBe(true);

    // A large JSON object (not a record array) clears minBytes but is not a table.
    const bigObject = JSON.stringify({ note: 'x'.repeat(3000), status: 'ok' });
    expect(
      (
        await evaluateGate(
          [{ kind: 'sniff', file: 'data.json', sniff: 'data-table' }],
          reader({ 'data.json': bigObject }),
        )
      ).pass,
    ).toBe(false);
    expect(
      (
        await evaluateGate(
          [{ kind: 'minBytes', file: 'data.json', bytes: 2 }],
          reader({ 'data.json': bigObject }),
        )
      ).pass,
    ).toBe(true);

    // A non-empty array of records is a valid data table.
    expect(
      (
        await evaluateGate(
          [{ kind: 'sniff', file: 'data.json', sniff: 'data-table' }],
          reader({
            'data.json': '[{"name":"A","url":"https://x"},{"name":"B","url":"https://y"}]',
          }),
        )
      ).pass,
    ).toBe(true);
  });
});

describe('commandEvidence', () => {
  const check = (over: Record<string, unknown> = {}) =>
    ({ kind: 'commandEvidence', script: 'test', expect: 'pass', ...over }) as never;
  const run = (exitCode: number, over: Record<string, unknown> = {}) => ({
    exitCode,
    timedOut: false,
    at: '2026-08-24T00:00:00Z',
    ...over,
  });
  const deps = (runs: unknown[], extra: Record<string, unknown> = {}) => ({
    commandEvidence: async () => ({ observable: true, runs: runs as never, ...extra }),
  });

  it('is misconfigured with neither or both of script/bin', async () => {
    const neither = await evaluateGate([check({ script: undefined })], reader({}), deps([run(0)]));
    expect(neither.pass).toBe(false);
    expect(neither.failures[0]).toMatch(/exactly one of `script`.*or `bin`/);
    const both = await evaluateGate([check({ bin: 'vitest' })], reader({}), deps([run(0)]));
    expect(both.pass).toBe(false);
  });

  it('fails closed without the deps provider or without telemetry', async () => {
    const noDep = await evaluateGate([check()], reader({}));
    expect(noDep.pass).toBe(false);
    expect(noDep.failures[0]).toMatch(/fail-closed/);
    const noTelemetry = await evaluateGate([check()], reader({}), {
      commandEvidence: async () => ({ observable: false, runs: [] }),
    });
    expect(noTelemetry.pass).toBe(false);
    expect(noTelemetry.failures[0]).toMatch(/fail-closed/);
  });

  it('rejects with a prescriptive message when no matching run was observed', async () => {
    const res = await evaluateGate([check()], reader({}), deps([]));
    expect(res.pass).toBe(false);
    expect(res.failures[0]).toMatch(/No `npm run test` run was observed/);
    expect(res.failures[0]).toMatch(/run_package_script/);
  });

  it('expect fail: a passing latest run rejects with the repro-first message', async () => {
    const res = await evaluateGate([check({ expect: 'fail' })], reader({}), deps([run(0)]));
    expect(res.pass).toBe(false);
    expect(res.failures[0]).toMatch(/requires it to FAIL/);
    const ok = await evaluateGate([check({ expect: 'fail' })], reader({}), deps([run(1)]));
    expect(ok.pass).toBe(true);
  });

  it('expect pass: a failing latest run rejects quoting the stderr tail', async () => {
    const res = await evaluateGate(
      [check()],
      reader({}),
      deps([run(1, { stderrTail: 'AssertionError: expected 3 to be 4' })]),
    );
    expect(res.pass).toBe(false);
    expect(res.failures[0]).toMatch(/exit 1/);
    expect(res.failures[0]).toMatch(/AssertionError/);
    const ok = await evaluateGate([check()], reader({}), deps([run(0)]));
    expect(ok.pass).toBe(true);
  });

  it('a timed-out run proves neither outcome', async () => {
    const res = await evaluateGate([check()], reader({}), deps([run(0, { timedOut: true })]));
    expect(res.pass).toBe(false);
    expect(res.failures[0]).toMatch(/timed out/);
  });

  it('minRuns: the latest N runs must ALL match (consecutive-green semantics)', async () => {
    const flaky = await evaluateGate(
      [check({ minRuns: 3 })],
      reader({}),
      deps([run(0), run(1), run(0)]),
    );
    expect(flaky.pass).toBe(false);
    const stable = await evaluateGate(
      [check({ minRuns: 3 })],
      reader({}),
      deps([run(0), run(0), run(0)]),
    );
    expect(stable.pass).toBe(true);
    const tooFew = await evaluateGate([check({ minRuns: 3 })], reader({}), deps([run(0)]));
    expect(tooFew.pass).toBe(false);
    expect(tooFew.failures[0]).toMatch(/Only 1 .*need 3/);
  });

  it('drafting: defers by default with an honest note, hard-blocks under onDraft require', async () => {
    const deferred = await evaluateGate([check()], reader({}), deps([], { drafting: true }));
    expect(deferred.pass).toBe(true);
    expect(deferred.checks?.[0]?.detail).toMatch(/Execution deferred/);
    const required = await evaluateGate(
      [check({ onDraft: 'require' })],
      reader({}),
      deps([], { drafting: true }),
    );
    expect(required.pass).toBe(false);
  });
});

describe('citationsResolve across surfaces', () => {
  it('a drawer-side evidence doc may cite real workspace files', async () => {
    const r = splitReader(
      { 'src/pricing.js': 'export const x = 1;\n' },
      {
        'tasks/7/repro.md':
          'The defect lives in `src/pricing.js` and the evidence sits in `tasks/7/notes.md`.\n',
        'tasks/7/notes.md': 'evidence\n',
      },
    );
    const ok = await evaluateGate(
      [
        {
          kind: 'citationsResolve',
          file: 'tasks/7/repro.md',
          minCitations: 2,
          artifact: true,
        },
      ],
      r,
    );
    expect(ok.pass).toBe(true);

    const phantom = await evaluateGate(
      [
        {
          kind: 'citationsResolve',
          file: 'tasks/7/repro.md',
          minCitations: 1,
          artifact: true,
        },
      ],
      splitReader({}, { 'tasks/7/repro.md': 'See `src/ghost.js` for details.\n' }),
    );
    expect(phantom.pass).toBe(false);
    expect(phantom.failures[0]).toContain('src/ghost.js');
  });

  it('a WORKSPACE deliverable may cite a real drawer-side file', async () => {
    // The inverse of the case above, and the one powerpoint-deck hits: its
    // research step mandates `sources.md` live in the drawer ("do not write
    // this working file to the workspace"), and the workspace `deck.md`
    // then cites it as provenance. Before the surfaces were merged in both
    // directions this read as a fabricated citation and failed a correct run.
    const r = splitReader(
      {
        'powerpoint/eval/deck.md':
          'Figures are drawn from `tasks/eval/sources.md` and `source/brief.md`.\n',
        'source/brief.md': '# brief\n',
      },
      { 'tasks/eval/sources.md': 'the source packet\n' },
    );
    const ok = await evaluateGate(
      [{ kind: 'citationsResolve', file: 'powerpoint/eval/deck.md', minCitations: 1 }],
      r,
    );
    expect(ok.pass).toBe(true);

    // Merging surfaces must not blunt the anti-fabrication verdict.
    const phantom = await evaluateGate(
      [{ kind: 'citationsResolve', file: 'powerpoint/eval/deck.md', minCitations: 1 }],
      splitReader(
        { 'powerpoint/eval/deck.md': 'Drawn from `tasks/eval/ghost.md`.\n' },
        { 'tasks/eval/sources.md': 'unrelated\n' },
      ),
    );
    expect(phantom.pass).toBe(false);
    expect(phantom.failures[0]).toContain('tasks/eval/ghost.md');
  });
});
