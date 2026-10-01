import { describe, expect, it } from 'vitest';
import type { GateCheck } from '../schemas/gate.js';
import {
  type GateWorkspaceReader,
  evaluateDeclarativeCheck,
  gateCheckLabel,
  isSharedGateCheck,
  locateMissingGateFiles,
} from './gate-checks.js';

function reader(
  files: Record<string, string>,
  artifacts: Record<string, string> = {},
): GateWorkspaceReader {
  return {
    read: async (file) => files[file] ?? null,
    list: async () => Object.keys(files),
    readArtifact: async (file) => artifacts[file] ?? null,
    listArtifacts: async () => Object.keys(artifacts),
  };
}

const ws = reader(
  {
    'index.html':
      '<!doctype html><html><head><style>body{margin:0}</style></head><body><script>console.log(1)</script></body></html>',
    'data.csv': 'name,age\nAda,36\nBob,41\n',
    'config.json': '{"mode":"prod","items":[1,2]}',
    'notes.md': 'Some notes\n',
    'a.png': 'x',
  },
  { 'report.md': '# Report\n\nA real report with content.\n' },
);

describe('evaluateDeclarativeCheck', () => {
  it.each<[GateCheck, boolean]>([
    [{ kind: 'minBytes', file: 'notes.md', bytes: 5 }, true],
    [{ kind: 'minBytes', file: 'missing.md', bytes: 1 }, false],
    [{ kind: 'totalMinBytes', files: ['notes.md', 'data.csv'], bytes: 10 }, true],
    [{ kind: 'fileCount', ext: ['png'], min: 1 }, true],
    [{ kind: 'fileCount', ext: ['jpg'], min: 1 }, false],
    [{ kind: 'cssMinBytes', bytes: 5, file: 'index.html' }, true],
    [{ kind: 'sniff', file: 'notes.md', sniff: 'nonempty' }, true],
    [{ kind: 'sniff', file: 'config.json', sniff: 'json-valid' }, true],
    [{ kind: 'jsonPathEquals', file: 'config.json', path: 'mode', value: 'prod' }, true],
    [{ kind: 'jsonPathEquals', file: 'config.json', path: 'mode', value: 'dev' }, false],
    [{ kind: 'csvShape', file: 'data.csv', requiredColumns: ['name', 'age'], minRows: 2 }, true],
    [{ kind: 'csvShape', file: 'data.csv', requiredColumns: ['name', 'city'] }, false],
  ])('%j -> %s', async (check, ok) => {
    const outcome = await evaluateDeclarativeCheck(check as never, ws);
    expect(outcome.ok).toBe(ok);
    expect(outcome.detail.length).toBeGreaterThan(0);
  });

  it('reads the artifacts drawer when a check is flagged, and fails closed without one', async () => {
    const flagged = {
      kind: 'minBytes',
      file: 'report.md',
      bytes: 5,
      artifact: true,
    } as GateCheck as never;
    expect((await evaluateDeclarativeCheck(flagged, ws)).ok).toBe(true);
    const plain: GateWorkspaceReader = { read: async () => 'x', list: async () => [] };
    // Without a drawer the flagged file is unreadable, so the check cannot pass.
    expect((await evaluateDeclarativeCheck(flagged, plain)).ok).toBe(false);
  });

  it('names the gap when a sniff fails and the file when one is missing', async () => {
    const failed = await evaluateDeclarativeCheck(
      { kind: 'sniff', file: 'notes.md', sniff: 'json-valid' } as never,
      ws,
    );
    expect(failed.ok).toBe(false);
    expect(failed.detail).toMatch(/^notes\.md failed the json-valid check: /);
    const missing = await evaluateDeclarativeCheck(
      { kind: 'sniff', file: 'nope.md', sniff: 'nonempty' } as never,
      ws,
    );
    expect(missing.detail).toBe('nope.md not found (needed for the nonempty check)');
  });

  // The review's draft targeted Instagram, shipped no Instagram variant, and
  // its size-only gate passed.
  it('requires a file for every value a deliverable lists', async () => {
    const check = {
      kind: 'listedFiles',
      file: 'posts/_drafting/post.md',
      key: 'platforms',
      pathTemplate: 'posts/_drafting/variants/{value}.md',
    } as GateCheck as never;
    const post = (platforms: string) =>
      `---\nstatus: in-review\n${platforms}\ntitle: Pumpkin loaf\n---\n\nBase copy.\n`;
    const variants = {
      'posts/_drafting/variants/bluesky.md': 'Bluesky copy',
      'posts/_drafting/variants/instagram.md': 'Instagram copy',
    };

    const inline = reader({
      'posts/_drafting/post.md': post('platforms: [Bluesky, Instagram]'),
      ...variants,
    });
    expect((await evaluateDeclarativeCheck(check, inline)).ok).toBe(true);

    const block = reader({
      'posts/_drafting/post.md': post('platforms:\n  - bluesky\n  - instagram\n  - LinkedIn'),
      ...variants,
    });
    const missing = await evaluateDeclarativeCheck(check, block);
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain('posts/_drafting/variants/linkedin.md');
    expect(missing.evidence).toEqual({ missing: ['posts/_drafting/variants/linkedin.md'] });

    const unlisted = reader({ 'posts/_drafting/post.md': post('title2: none'), ...variants });
    expect((await evaluateDeclarativeCheck(check, unlisted)).ok).toBe(false);
  });

  // A quote said $297 for items adding up to $197, and nothing checked it.
  it('fails a deliverable whose figures do not hold up', async () => {
    const check = { kind: 'figures', file: 'quote.md', artifact: true } as GateCheck as never;
    const quote = (total: string) =>
      `## Option 2\n\n- Fruit platter: $85\n- Coffee: $45\n- Pastries: $42\n- Delivery: $25\n\n**Subtotal: ${total}**\n`;

    const wrong = await evaluateDeclarativeCheck(check, reader({}, { 'quote.md': quote('$297') }));
    expect(wrong.ok).toBe(false);
    expect(wrong.detail).toContain('says $297.00, but the items above it add up to $197.00');

    const right = await evaluateDeclarativeCheck(check, reader({}, { 'quote.md': quote('$197') }));
    expect(right.ok).toBe(true);
    expect(isSharedGateCheck(check)).toBe(true);
  });

  it('labels a check by its configuration, never its observed values', () => {
    expect(gateCheckLabel({ kind: 'minBytes', file: 'a.md', bytes: 9 } as GateCheck)).toBe(
      'minBytes a.md',
    );
    expect(gateCheckLabel({ kind: 'sniff', file: 'a.md', sniff: 'nonempty' } as GateCheck)).toBe(
      'sniff a.md nonempty',
    );
    expect(isSharedGateCheck({ kind: 'contains', file: 'a', pattern: 'x' } as GateCheck)).toBe(
      false,
    );
  });
});

describe('locateMissingGateFiles', () => {
  const handover: GateCheck[] = [
    { kind: 'minBytes', file: 'handover.md', artifact: true, bytes: 40 },
    { kind: 'sniff', file: 'handover.md', artifact: true, sniff: 'nonempty' },
  ];

  // The iPhone case: the model saved the deliverable one folder down and was
  // told only "handover.md not found".
  it('names where the check looked and the copy saved somewhere else', async () => {
    const lines = await locateMissingGateFiles(
      handover,
      reader({}, { '1/handover.md': '# Repair Handover' }),
    );
    expect(lines).toEqual([
      'The checks read `handover.md` at exactly that path in the artifacts drawer; it was saved as `1/handover.md` instead. Save it at `handover.md`.',
    ]);
  });

  it('says nothing is there yet when no copy exists, and names the tree it read', async () => {
    expect(
      await locateMissingGateFiles(
        [{ kind: 'minBytes', file: 'out/result.json', bytes: 1 }],
        reader({}),
      ),
    ).toEqual([
      'The checks read `out/result.json` at exactly that path in the project workspace, and nothing is saved there yet.',
    ]);
  });

  it('stays quiet about files that exist', async () => {
    expect(await locateMissingGateFiles(handover, reader({}, { 'handover.md': 'x' }))).toEqual([]);
  });
});
