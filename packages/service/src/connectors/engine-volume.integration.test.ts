import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { syncWithAdapter } from './manager.js';
import {
  type ConnectorTestEnv,
  assertCorpusInvariants,
  createConnectorTestEnv,
} from './testing/harness.js';
import type { ChangeBatch, ConnectorAdapter, NormalizedRecord, RecordRef } from './types.js';
import { RECORD_FILE_RE, contentHash, sha8, writeRecord } from './writer.js';

const CORPUS = 'data/volume';

function record(id: string, body = `body of ${id}`): NormalizedRecord {
  return {
    recordId: id,
    dirSegments: [],
    fileStem: id,
    frontmatter: { title: id, direction: 'inbound' },
    bodyMarkdown: body,
    scanOrigin: 'test',
    quarantineNamespace: 'volume',
    quarantineLabel: id,
  };
}

/**
 * Lay down `count` records the way the writer would, without paying for
 * `count` writes (each rewrites the whole sidecar). Ordinals start at 001.
 */
async function seed(dirAbs: string, count: number): Promise<void> {
  await mkdir(dirAbs, { recursive: true });
  const sidecar: Record<string, unknown> = {};
  for (let i = 1; i <= count; i++) {
    const rec = record(`r${i}`);
    const hash8 = sha8(rec.recordId);
    const name = `${String(i).padStart(3, '0')}--${rec.fileStem}--${hash8}.md`;
    await writeFile(
      join(dirAbs, name),
      `---\ntitle: ${rec.recordId}\ndirection: inbound\ntrust: untrusted-external\nscan_action: pass\n---\n\n${rec.bodyMarkdown}`,
    );
    sidecar[hash8] = { read: false, flags: [], contentHash: contentHash(rec), file: name };
  }
  await writeFile(join(dirAbs, '_flags.json'), JSON.stringify(sidecar));
}

/** Lists whatever the test sets, newest first; one scope. */
class ListedAdapter implements ConnectorAdapter {
  readonly typeId = 'volume';
  records = new Map<string, NormalizedRecord>();
  removed: string[] = [];
  async ensureAuth() {}
  async listScopes() {
    return [''];
  }
  async listChangesSince(_scope: string, cursor: unknown): Promise<ChangeBatch<unknown>> {
    const refs: RecordRef[] = [...this.records.keys()].map((id, i) => ({ id, ordinalKey: i }));
    const batch = { records: refs, cursor: Number(cursor ?? 0) + 1, removed: this.removed };
    this.removed = [];
    return batch;
  }
  async fetchRecord(_scope: string, ref: RecordRef) {
    return this.records.get(ref.id)!;
  }
  async close() {}
}

describe('a corpus directory past 999 records', () => {
  let env: ConnectorTestEnv;
  beforeEach(async () => {
    env = await createConnectorTestEnv();
  });
  afterEach(async () => {
    await env.dispose();
  });

  const pass = (adapter: ConnectorAdapter, cursor?: unknown) =>
    syncWithAdapter(adapter, {
      storageDir: env.artifactsDir,
      quarantineDir: env.quarantineDir,
      corpusDir: CORPUS,
      backfillLimit: 50,
      cursor,
    });

  it('keeps refresh, idempotence and tombstones working on the 1000th record and after', async () => {
    const dirAbs = join(env.artifactsDir, CORPUS);
    await seed(dirAbs, 998);
    const adapter = new ListedAdapter();
    for (let i = 999; i <= 1005; i++) adapter.records.set(`r${i}`, record(`r${i}`));

    const first = await pass(adapter);
    expect(first.errors).toBe(0);
    expect(first.written).toBe(7);

    const names = (await readdir(dirAbs)).filter((n) => RECORD_FILE_RE.test(n));
    expect(names).toHaveLength(1005);
    const ordinals = names.map((n) => RECORD_FILE_RE.exec(n)![1]);
    expect(new Set(ordinals).size).toBe(1005);
    expect(ordinals).toContain('1005');

    // An unchanged source writes nothing, including the four-digit records.
    const quiet = await pass(adapter, first.cursor);
    expect(quiet.written).toBe(0);

    // An edit refreshes in place; a tombstone removes; nothing duplicates.
    adapter.records.set('r1003', record('r1003', 'edited'));
    adapter.records.delete('r1004');
    adapter.removed = ['r1004'];
    const third = await pass(adapter, quiet.cursor);
    expect(third.written).toBe(1);
    expect(third.pruned).toBe(1);
    const after = (await readdir(dirAbs)).filter((n) => RECORD_FILE_RE.test(n));
    expect(after).toHaveLength(1004);
    expect(after.filter((n) => n.includes(sha8('r1003')))).toHaveLength(1);
    expect(after.some((n) => n.includes(sha8('r1004')))).toBe(false);

    await assertCorpusInvariants(env.artifactsDir, CORPUS);
  }, 120_000);

  it('heals a directory where several records were given ordinal 1000', async () => {
    const dirAbs = join(env.artifactsDir, CORPUS);
    await mkdir(join(dirAbs, 'attachments', '1000'), { recursive: true });
    const a = record('a');
    const b = record('b');
    const nameA = `1000--a--${sha8('a')}.md`;
    const nameB = `1000--b--${sha8('b')}.md`;
    const header =
      '---\ntitle: x\ndirection: inbound\ntrust: untrusted-external\nscan_action: pass\n---\n\n';
    await writeFile(join(dirAbs, nameA), `${header}${a.bodyMarkdown}`);
    await writeFile(join(dirAbs, nameB), `${header}${b.bodyMarkdown}`);
    await writeFile(join(dirAbs, 'attachments', '1000', 'shared.txt'), 'mixed');
    await writeFile(
      join(dirAbs, '_flags.json'),
      JSON.stringify({
        [sha8('a')]: { read: false, flags: [], contentHash: contentHash(a), file: nameA },
        [sha8('b')]: { read: false, flags: [], contentHash: contentHash(b), file: nameB },
      }),
    );
    const write = (rec: NormalizedRecord) =>
      writeRecord({
        storageDir: env.artifactsDir,
        quarantineDir: env.quarantineDir,
        corpusDir: CORPUS,
        record: rec,
      });

    // b is unchanged upstream, but it shares its ordinal, so it moves.
    expect((await write(b)).status).toBe('refreshed');
    let names = (await readdir(dirAbs)).filter((n) => RECORD_FILE_RE.test(n)).sort();
    expect(names).toEqual([nameA, `1001--b--${sha8('b')}.md`]);
    const sidecar = JSON.parse(await readFile(join(dirAbs, '_flags.json'), 'utf8'));
    expect(sidecar[sha8('a')].contentHash).toBeUndefined();
    // The shared folder stays: it may hold the only copy of a's attachments.
    expect(await readdir(join(dirAbs, 'attachments', '1000'))).toEqual(['shared.txt']);

    // a now has the ordinal to itself and is rewritten once, in place.
    expect((await write(a)).status).toBe('refreshed');
    expect((await write(a)).status).toBe('exists');
    names = (await readdir(dirAbs)).filter((n) => RECORD_FILE_RE.test(n)).sort();
    expect(names).toEqual([nameA, `1001--b--${sha8('b')}.md`]);
    await assertCorpusInvariants(env.artifactsDir, CORPUS);
  });
});
