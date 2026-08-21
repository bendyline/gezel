import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Behavioral coverage for publishCorpusBatches: the sdk module is mocked with
 * an in-memory artifacts drawer (read throws when missing, a recursive list
 * returns drawer-root-relative file paths exactly as the daemon's scoped walk
 * does), and each run() re-imports the real script so the whole input → output
 * path is exercised.
 */

interface ArtifactEntry {
  path: string;
  size: number;
  modified: string;
}

const h = vi.hoisted(() => {
  const files = new Map<string, string>();
  let input: Record<string, unknown> = {};
  let output: unknown;
  let stamped = false;

  const norm = (p: string | undefined) =>
    String(p ?? '')
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '');

  const artifacts = {
    async read(path: string): Promise<string> {
      const hit = files.get(norm(path));
      if (hit === undefined) throw new Error(`artifact not found: ${path}`);
      return hit;
    },
    async write(path: string, content: string): Promise<void> {
      files.set(norm(path), content);
    },
    async list(prefix?: string, opts?: { recursive?: boolean }): Promise<ArtifactEntry[]> {
      const scope = norm(prefix);
      const out: ArtifactEntry[] = [];
      for (const [key, value] of files) {
        if (scope && !key.startsWith(`${scope}/`)) continue;
        // The non-recursive contract is one level; the script always asks for
        // the subtree, so anything deeper must be filtered out here.
        if (opts?.recursive !== true) {
          const rest = scope ? key.slice(scope.length + 1) : key;
          if (rest.includes('/')) continue;
        }
        out.push({ path: key, size: value.length, modified: '' });
      }
      return out;
    },
  };

  return {
    files,
    begin(next: Record<string, unknown>) {
      input = next;
      output = undefined;
      stamped = false;
    },
    result(): unknown {
      if (!stamped) throw new Error('script finished without stamping an output');
      return output;
    },
    reset() {
      files.clear();
    },
    gezel: {
      get input() {
        return input;
      },
      output(value: unknown) {
        if (stamped) throw new Error('output stamped twice');
        stamped = true;
        output = value;
      },
      log() {},
      artifacts,
    },
  };
});

vi.mock('@bendyline/gezel-sdk', () => ({
  defineScript: <T>(meta: T) => meta,
  gezel: h.gezel,
}));

async function run(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  h.begin(input);
  vi.resetModules();
  await import('./publishCorpusBatches');
  return h.result() as Record<string, unknown>;
}

const CORPUS = 'data/github-pull-requests/pr-33';
const MANIFEST = `${CORPUS}/attachments/001/pr-33-files.json`;
const SIDECAR = `${CORPUS}/files/_flags.json`;

function batch(batchNumber: number, start: number, count: number) {
  return {
    number: batchNumber,
    batchNumber,
    start,
    end: start + count - 1,
    paths: Array.from({ length: count }, (_, index) => `packages/p${start + index}/src/file.ts`),
  };
}

function hashForOrdinal(ordinal: number): string {
  return ordinal.toString(16).padStart(8, '0');
}

function filesForBatches(batches: ReturnType<typeof batch>[]) {
  return batches.flatMap((entry) =>
    entry.paths.map((path, index) => ({
      ordinal: entry.start + index,
      path,
      recordHash: hashForOrdinal(entry.start + index),
    })),
  );
}

function manifest(overrides: Record<string, unknown> = {}) {
  const batches = [batch(1, 1, 25), batch(2, 26, 25), batch(3, 51, 9)];
  return JSON.stringify(
    {
      schemaVersion: 1,
      pullRequest: 33,
      totalFiles: 59,
      batchSize: 25,
      batches,
      files: filesForBatches(batches),
      ...overrides,
    },
    null,
    2,
  );
}

function seedManifest(text = manifest()): void {
  h.files.set(MANIFEST, text);
  const parsed = JSON.parse(text) as { files?: Array<{ ordinal: number; recordHash: string }> };
  const identities = Object.fromEntries(
    (parsed.files ?? []).map((file) => [
      file.recordHash,
      {
        read: false,
        flags: [],
        file: `${String(file.ordinal).padStart(3, '0')}--fixture--${file.recordHash}.md`,
      },
    ]),
  );
  h.files.set(SIDECAR, JSON.stringify(identities));
}

function args(overrides: Record<string, unknown> = {}) {
  return { corpusDir: CORPUS, outFile: 'pr-review/batches.json', ...overrides };
}

beforeEach(() => {
  h.reset();
});

describe('publishCorpusBatches', () => {
  it('publishes every batch verbatim, in the fanout entry shape', async () => {
    seedManifest();
    h.files.set(`${CORPUS}/001--pr-33-overview--abc.md`, '# PR');
    h.files.set(`${CORPUS}/files/001--a.md`, '# a');

    const out = await run(args());
    expect(out).toEqual({
      ok: true,
      manifest: MANIFEST,
      outFile: 'pr-review/batches.json',
      batches: 3,
      paths: 59,
      records: 59,
      bytes: expect.any(Number),
    });

    const published = JSON.parse(h.files.get('pr-review/batches.json') ?? '');
    // The file IS the array — no wrapper object — and every entry carries
    // the path slice plus the exact artifact records the child must read.
    expect(Array.isArray(published)).toBe(true);
    expect(published).toHaveLength(3);
    expect(Object.keys(published[0])).toEqual(['batchNumber', 'start', 'end', 'paths', 'records']);
    expect(published[2]).toEqual({
      batchNumber: 3,
      start: 51,
      end: 59,
      paths: Array.from({ length: 9 }, (_, i) => `packages/p${51 + i}/src/file.ts`),
      records: Array.from(
        { length: 9 },
        (_, i) =>
          `${CORPUS}/files/${String(51 + i).padStart(3, '0')}--fixture--${hashForOrdinal(51 + i)}.md`,
      ),
    });
    // Complete by construction: this is the failure the whole script exists
    // to remove — a truncated batch file that still parses as valid JSON.
    expect(published.flatMap((entry: { paths: string[] }) => entry.paths)).toHaveLength(59);
  });

  it('tolerates the redundant artifacts/ prefix craftbook params carry', async () => {
    seedManifest();
    const out = await run({
      // Exactly the shape of the `corpusScope` launch param.
      corpusDir: `artifacts/${CORPUS}/`,
      outFile: 'artifacts/pr-review/batches.json',
    });
    expect(out).toMatchObject({ ok: true, manifest: MANIFEST, outFile: 'pr-review/batches.json' });
    expect(h.files.has('pr-review/batches.json')).toBe(true);
  });

  it('fails when the corpus holds no manifest', async () => {
    h.files.set(`${CORPUS}/001--pr-33-overview--abc.md`, '# PR');
    await expect(run(args())).rejects.toThrow(/No '\*-files\.json' manifest/);
  });

  it('refuses to guess between two manifests', async () => {
    h.files.set(MANIFEST, manifest());
    h.files.set(`${CORPUS}/attachments/002/pr-34-files.json`, manifest());
    await expect(run(args())).rejects.toThrow(/Found 2 .* manifests/);
  });

  it('rejects a manifest whose batches do not cover its own file total', async () => {
    // The exact shape of the incident, but caught mechanically: the batches
    // account for fewer paths than the PR changed.
    h.files.set(MANIFEST, manifest({ totalFiles: 509 }));
    await expect(run(args())).rejects.toThrow(/declares totalFiles=509 but its batches cover 59/);
  });

  it('rejects a duplicated path across batches', async () => {
    const batches = [batch(1, 1, 25), batch(2, 26, 25), batch(3, 51, 9)];
    batches[2]!.paths[0] = batches[0]!.paths[0]!;
    h.files.set(MANIFEST, JSON.stringify({ totalFiles: 59, batches }));
    await expect(run(args())).rejects.toThrow(/repeats 'packages\/p1\/src\/file\.ts'/);
  });

  it('rejects out-of-order batch numbers the fanout would misaddress', async () => {
    const batches = [batch(2, 1, 25), batch(1, 26, 25)];
    h.files.set(MANIFEST, JSON.stringify({ totalFiles: 50, batches }));
    await expect(run(args())).rejects.toThrow(/batchNumber 2 at position 1/);
  });

  it('rejects a batch whose path count disagrees with its ordinal range', async () => {
    const batches = [{ batchNumber: 1, start: 1, end: 25, paths: ['only/one.ts'] }];
    h.files.set(MANIFEST, JSON.stringify({ totalFiles: 1, batches }));
    await expect(run(args())).rejects.toThrow(
      /spans ordinals 1-25 \(25 files\) but carries 1 path/,
    );
  });

  it('fails closed when the total field is missing', async () => {
    h.files.set(MANIFEST, JSON.stringify({ batches: [batch(1, 1, 2)] }));
    await expect(run(args())).rejects.toThrow(/no positive integer 'totalFiles'/);
  });

  it('can skip the total cross-check when explicitly disabled', async () => {
    const batches = [batch(1, 1, 2)];
    seedManifest(JSON.stringify({ batches, files: filesForBatches(batches) }));
    const out = await run(args({ totalField: '' }));
    expect(out).toMatchObject({ ok: true, batches: 1, paths: 2, records: 2 });
  });

  it('publishes all exact record paths beyond the 500-entry artifact walk boundary', async () => {
    const total = 510;
    const batches = Array.from({ length: Math.ceil(total / 25) }, (_, index) => {
      const start = index * 25 + 1;
      return batch(index + 1, start, Math.min(25, total - start + 1));
    });
    seedManifest(
      JSON.stringify({
        schemaVersion: 1,
        totalFiles: total,
        batches,
        files: filesForBatches(batches),
      }),
    );

    const out = await run(args());
    expect(out).toMatchObject({ batches: 21, paths: 510, records: 510 });
    const published = JSON.parse(h.files.get('pr-review/batches.json') ?? '[]');
    expect(published.at(-1)?.records.at(-1)).toBe(
      `${CORPUS}/files/510--fixture--${hashForOrdinal(510)}.md`,
    );
  });

  it('fails loudly when the compact writer identity sidecar is unavailable', async () => {
    h.files.set(MANIFEST, manifest());
    await expect(run(args())).rejects.toThrow(/files\/_flags\.json is missing/);
  });

  it('rejects a corpusDir that tries to climb out of the drawer', async () => {
    await expect(run(args({ corpusDir: '../../etc' }))).rejects.toThrow(/must not contain '\.\.'/);
  });

  it('rejects invalid manifest JSON rather than writing a partial file', async () => {
    h.files.set(MANIFEST, '{"batches": [');
    await expect(run(args())).rejects.toThrow(/is not valid JSON/);
    expect(h.files.has('pr-review/batches.json')).toBe(false);
  });
});
