import { describe, expect, it } from 'vitest';
import {
  PATCH_LINE_LEGEND,
  formatLineRanges,
  generatedBatchObservations,
  generatedFileKind,
  numberUnifiedPatch,
  parsePatchRecord,
  parsePrVerificationCandidates,
  prFindingBlocks,
  prFindingWordingProblem,
} from './pr-review.js';

const PATCH = [
  'diff --git a/ci.yml b/ci.yml',
  'index 313db2d3..fd3bdf08 100644',
  '--- a/ci.yml',
  '+++ b/ci.yml',
  '@@ -6,4 +6,5 @@',
  ' #   - macOS',
  ' #   - iOS',
  '+#   - VS Code',
  ' #',
  ' # These are DIFFERENT',
  '@@ -98,3 +99,3 @@ on:',
  '           - ios',
  '-          - old',
  '+          - vscode',
  '       build_number:',
  '\\ No newline at end of file',
].join('\n');

function record(patch: string, numbered: boolean): string {
  return [
    '---',
    'path: ci.yml',
    '---',
    '',
    '# `ci.yml`',
    '',
    ...(numbered ? [PATCH_LINE_LEGEND, ''] : []),
    '```diff',
    numbered ? numberUnifiedPatch(patch) : patch,
    '```',
  ].join('\n');
}

describe('numberUnifiedPatch', () => {
  it('prints the new-file line beside every added and unchanged line, and none beside a removed one', () => {
    expect(numberUnifiedPatch(PATCH).split('\n')).toEqual([
      'diff --git a/ci.yml b/ci.yml',
      'index 313db2d3..fd3bdf08 100644',
      '--- a/ci.yml',
      '+++ b/ci.yml',
      '@@ -6,4 +6,5 @@',
      '  6  #   - macOS',
      '  7  #   - iOS',
      '  8 +#   - VS Code',
      '  9  #',
      ' 10  # These are DIFFERENT',
      '@@ -98,3 +99,3 @@ on:',
      ' 99            - ios',
      '    -          - old',
      '100 +          - vscode',
      '101        build_number:',
      '    \\ No newline at end of file',
    ]);
  });

  it('leaves a patch with no new-file lines as it is', () => {
    const deleted = ['@@ -1,2 +0,0 @@', '-one', '-two'].join('\n');
    expect(numberUnifiedPatch(deleted)).toBe(deleted);
  });

  it('numbers a patch that starts at its first hunk, as the list-files API returns it', () => {
    expect(numberUnifiedPatch('@@ -1 +1,2 @@\n one\n+two')).toBe('@@ -1 +1,2 @@\n1  one\n2 +two');
  });
});

describe('parsePatchRecord', () => {
  it('reads the same lines from a numbered record and from one written before numbering', () => {
    const numbered = parsePatchRecord(record(PATCH, true));
    const legacy = parsePatchRecord(record(PATCH, false));
    expect(numbered).not.toBeNull();
    expect(numbered).toEqual(legacy);
    expect([...numbered!.newLines]).toEqual([6, 7, 8, 9, 10, 99, 100, 101]);
    expect(numbered!.lines.filter((line) => line.kind === 'add')).toEqual([
      { kind: 'add', newLine: 8, text: '#   - VS Code' },
      { kind: 'add', newLine: 100, text: '          - vscode' },
    ]);
    expect(numbered!.lines.filter((line) => line.kind === 'remove')).toEqual([
      { kind: 'remove', text: '          - old' },
    ]);
  });

  it('keeps a fence inside the changed file from ending the patch', () => {
    const patch = ['@@ -1,2 +1,3 @@', ' intro', '+```', ' ```'].join('\n');
    expect([...parsePatchRecord(record(patch, true))!.newLines]).toEqual([1, 2, 3]);
  });

  it('answers null for a record with no patch', () => {
    expect(parsePatchRecord('# `logo.png`\n\n_No patch available._')).toBeNull();
  });
});

describe('formatLineRanges', () => {
  it('folds runs and bounds the list', () => {
    expect(formatLineRanges(new Set([6, 7, 8, 12, 20, 21]))).toBe('6-8, 12, 20-21');
    expect(formatLineRanges(new Set([1, 3, 5, 7]), 2)).toBe('1, 3 and 2 more range(s)');
  });
});

describe('prFindingWordingProblem', () => {
  const PIPEFAIL = [
    '**B1-1** — `.github/workflows/store-release.yml:935` — severity: **major**',
    '',
    'The step pipes `vsce publish` output through `tee` without `pipefail`:',
    '',
    '```bash',
    'npm exec -- vsce publish 2>&1 | tee "$RUNNER_TEMP/vsce-publish.log"  # may fail',
    '```',
    '',
    "The step's exit status is the last command in the pipeline (`tee`), which exits 0 whether or not `vsce publish` succeeded. If `vsce` fails for any reason (network error, OIDC token rejected), the step still exits 0 and the job is reported green.",
    '',
    '**Fix:** add `set -o pipefail` at the top of the `run:` block.',
  ].join('\n');

  it('accepts the finding a conditional used to get rejected three times', () => {
    expect(prFindingWordingProblem(PIPEFAIL)).toBeNull();
  });

  it('accepts a finding about a comment, a doc file, or a missing check', () => {
    expect(
      prFindingWordingProblem(
        'B2-1 `docs/api.md:12` minor: the documentation names the old flag; the comment above it was not updated.',
      ),
    ).toBeNull();
    expect(
      prFindingWordingProblem(
        'B2-2 `src/hook.ts:40` major: the handler does not verify the signature before parsing the body.',
      ),
    ).toBeNull();
  });

  it('names the words that say a finding is not a defect', () => {
    expect(
      prFindingWordingProblem('B1-2 `a.ts:4` minor: intentional limitation;  no action   needed.'),
    ).toEqual({ kind: 'not-a-defect', phrase: 'intentional limitation' });
    expect(prFindingWordingProblem('B1-3 `a.ts:4` nit: fine. No action\nneeded here.')).toEqual({
      kind: 'not-a-defect',
      phrase: 'No action needed',
    });
  });

  it('names a hedge, but not one that is only in quoted code', () => {
    expect(prFindingWordingProblem('B1-4 `a.ts:9` major: the guard could be bypassed.')).toEqual({
      kind: 'hedge',
      phrase: 'could',
    });
    expect(
      prFindingWordingProblem('B1-5 `a.ts:9` major: `if (may) retry()` retries without a limit.'),
    ).toBeNull();
  });
});

describe('prFindingBlocks', () => {
  it('finds plain, bold, heading, bullet and table-row findings and stops at the next heading', () => {
    const blocks = prFindingBlocks(
      [
        '### Findings',
        '**B1-1** — `a.ts:1` — major',
        'mechanism',
        '- B1-2: `a.ts:2` minor',
        '#### B1-3 `a.ts:3` nit',
        'B1-4 | a.ts:4 | minor | text',
        '### Checks',
        'B-numbers are not used here.',
      ].join('\n'),
    );
    expect(blocks.map((block) => block.id)).toEqual(['B1-1', 'B1-2', 'B1-3', 'B1-4']);
    expect(blocks[0]!.text).toBe('**B1-1** — `a.ts:1` — major\nmechanism');
    expect(blocks[3]!.text).toBe('B1-4 | a.ts:4 | minor | text');
  });
});

describe('parsePrVerificationCandidates', () => {
  const wrap = (candidates: unknown) =>
    `## Verification candidates\n\n\`\`\`json\n${JSON.stringify({ verificationCandidates: candidates })}\n\`\`\`\n`;
  const valid = {
    id: 'V3-1',
    path: 'e2e/journey.ts',
    line: 276,
    severity: 'minor',
    claim: 'The skip condition also skips a visible dialog nested under an inert ancestor.',
    verify: 'Inspect the dialog components for an inert or aria-hidden ancestor.',
  };

  it('accepts a claim a little over the length asked for, since a model cannot count it', () => {
    const result = parsePrVerificationCandidates(wrap([{ ...valid, claim: 'x'.repeat(409) }]), 3, [
      'e2e/journey.ts',
    ]);
    expect(result.problems).toEqual([]);
    expect(result.candidates).toHaveLength(1);
  });

  it('states the count and the limit when a claim is far too long', () => {
    const result = parsePrVerificationCandidates(wrap([{ ...valid, claim: 'x'.repeat(650) }]), 3, [
      'e2e/journey.ts',
    ]);
    expect(result.problems).toEqual(['V3-1: claim is 650 characters; cut it to 400 or fewer']);
  });

  it('names every wrong field of every entry', () => {
    const result = parsePrVerificationCandidates(
      wrap([
        valid,
        { ...valid, id: 'V3-9', path: 'other.ts', line: '12', severity: 'medium', note: 'x' },
      ]),
      3,
      ['e2e/journey.ts'],
    );
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(['V3-1']);
    expect(result.problems).toEqual([
      'V3-2: id is "V3-9"; entry 2 must be "V3-2" (number them in order); path "other.ts" is not one of this batch\'s changed paths; line must be a whole number above 0, not "12"; severity "medium" must be critical, major, minor, or nit; has extra key(s) note; keep only id, path, line, severity, claim, verify',
    ]);
  });

  it('asks for the section when it is missing or doubled', () => {
    expect(parsePrVerificationCandidates('# Batch 1', 1, ['a.ts']).problems[0]).toContain(
      'add a "Verification candidates" heading',
    );
    expect(
      parsePrVerificationCandidates(`${wrap([])}\`\`\`json\n{}\n\`\`\`\n`, 1, ['a.ts']).problems[0],
    ).toContain('exactly one fenced JSON block');
  });
});

describe('generatedFileKind', () => {
  it('names lockfiles and third-party notices, and nothing a person edits', () => {
    expect(generatedFileKind('package-lock.json')).toBe('lockfile');
    expect(generatedFileKind('apps/web/pnpm-lock.yaml')).toBe('lockfile');
    expect(generatedFileKind('Cargo.lock')).toBe('lockfile');
    expect(generatedFileKind('packages/cli/THIRD_PARTY_NOTICES.txt')).toBe('third-party-notices');
    expect(generatedFileKind('ThirdPartyLicenses.md')).toBe('third-party-notices');
    expect(generatedFileKind('NOTICE.md')).toBeNull();
    expect(generatedFileKind('package.json')).toBeNull();
    expect(generatedFileKind('src/lockfile.ts')).toBeNull();
  });
});

describe('generatedBatchObservations', () => {
  const lockPatch = [
    '@@ -10,6 +10,8 @@',
    '     "node_modules/left-pad": {',
    '-      "version": "1.0.0",',
    '-      "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.0.0.tgz",',
    '+      "version": "1.3.0",',
    '+      "resolved": "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",',
    '     },',
    '+    "node_modules/@acme/widget-2go": {',
    '+      "resolved": "https://npm.acme.example/api/npm/all/@acme/widget-2go/-/widget-2go-2.1.0.tgz",',
    '+    },',
    '     "node_modules/gone": {',
    '-      "resolved": "https://registry.npmjs.org/gone/-/gone-0.4.1.tgz",',
  ].join('\n');

  const text = generatedBatchObservations({
    batchNumber: 5,
    start: 10,
    end: 12,
    files: [
      { path: 'package-lock.json', kind: 'lockfile', record: record(lockPatch, true) },
      {
        path: 'packages/cli/THIRD_PARTY_NOTICES.txt',
        kind: 'third-party-notices',
        record: record('@@ -1,2 +1,3 @@\n MIT\n+Apache-2.0\n ISC', true),
      },
      { path: 'yarn.lock', kind: 'lockfile', record: null },
    ],
  });

  it('gives every file its own heading under the batch title', () => {
    expect(text.startsWith('# Batch 5 — files 10–12\n')).toBe(true);
    for (const path of ['package-lock.json', 'packages/cli/THIRD_PARTY_NOTICES.txt', 'yarn.lock']) {
      expect(text).toContain(`\n## ${path}\n`);
    }
    expect(text).toContain('Third-party notices: +1 / -0 lines.');
    expect(text).toContain('Dependency lockfile. No patch available.');
  });

  it('lists package changes read from the tarball addresses', () => {
    expect(text).toContain('Dependency lockfile: +5 / -3 lines.');
    expect(text).toContain('- @acme/widget-2go 2.1.0 added');
    expect(text).toContain('- gone 0.4.1 removed');
    expect(text).toContain('- left-pad 1.0.0 to 1.3.0');
  });

  it('asks the final reviewer about a package resolved from outside the public registry', () => {
    const { candidates, problems } = parsePrVerificationCandidates(text, 5, ['package-lock.json']);
    expect(problems).toEqual([]);
    expect(candidates).toEqual([
      expect.objectContaining({
        id: 'V5-1',
        path: 'package-lock.json',
        line: 15,
        severity: 'minor',
        claim:
          'The lockfile resolves 1 package(s) from npm.acme.example, not the public npm registry.',
      }),
    ]);
    expect(prFindingBlocks(text)).toEqual([]);
  });
});
