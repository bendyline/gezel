import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Behavioral coverage for storeRecords: the sdk module is mocked with an
 * in-memory workspace (mirroring the daemon's fs contracts — read throws
 * when missing, list of a missing dir is empty, rm refuses directories),
 * and each run() re-imports the real script so the whole input → output
 * path is exercised, not just extracted helpers.
 */

interface FsEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  modified: string;
}

const h = vi.hoisted(() => {
  const files = new Map<string, string>();
  let input: Record<string, unknown> = {};
  let output: unknown;
  let stamped = false;

  const norm = (p: string) =>
    String(p)
      .replace(/\\/g, '/')
      .replace(/^\/+|\/+$/g, '');

  const fs = {
    async read(path: string): Promise<string> {
      const hit = files.get(norm(path));
      if (hit === undefined) throw new Error(`file not found: ${path}`);
      return hit;
    },
    async write(path: string, content: string): Promise<void> {
      files.set(norm(path), content);
    },
    async list(path: string): Promise<FsEntry[]> {
      const prefix = norm(path);
      const seen = new Map<string, FsEntry>();
      for (const key of files.keys()) {
        if (!key.startsWith(`${prefix}/`)) continue;
        const [head = '', ...rest] = key.slice(prefix.length + 1).split('/');
        if (!seen.has(head)) {
          seen.set(head, { name: head, isDirectory: rest.length > 0, size: 0, modified: '' });
        }
      }
      return [...seen.values()];
    },
    async rm(path: string): Promise<void> {
      const key = norm(path);
      const isDir = [...files.keys()].some((k) => k.startsWith(`${key}/`));
      if (isDir) throw new Error(`EISDIR: path is a directory: ${path}`);
      files.delete(key);
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
      fs,
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
  await import('./storeRecords');
  return h.result() as Record<string, unknown>;
}

function folder(input: Record<string, unknown>): Record<string, unknown> {
  return { root: 'crm/members', mode: 'folder-per-record', ...input };
}

function single(input: Record<string, unknown>): Record<string, unknown> {
  return { root: 'crm/members', mode: 'single-file', ...input };
}

beforeEach(() => {
  h.reset();
});

describe.each([
  ['folder-per-record', folder],
  ['single-file', single],
] as const)('storeRecords crud (%s)', (_mode, scoped) => {
  it('creates, gets, updates, deletes, and lists records', async () => {
    const created = await run(
      scoped({ action: 'create', fields: { slug: 'Ada Lovelace', role: 'engineer' } }),
    );
    expect(created).toEqual({
      ok: true,
      action: 'create',
      id: 'ada-lovelace',
      record: { id: 'ada-lovelace', slug: 'Ada Lovelace', role: 'engineer' },
    });

    expect(await run(scoped({ action: 'get', id: 'ada-lovelace' }))).toEqual({
      ok: true,
      action: 'get',
      id: 'ada-lovelace',
      record: { id: 'ada-lovelace', slug: 'Ada Lovelace', role: 'engineer' },
    });

    const updated = await run(
      scoped({ action: 'update', id: 'ada-lovelace', fields: { role: 'chief', level: 3 } }),
    );
    expect(updated).toEqual({
      ok: true,
      action: 'update',
      id: 'ada-lovelace',
      record: { id: 'ada-lovelace', slug: 'Ada Lovelace', role: 'chief', level: 3 },
    });

    await run(scoped({ action: 'create', fields: { title: 'Zeb' } }));
    const listed = await run(scoped({ action: 'list' }));
    expect(listed.total).toBe(2);
    expect((listed.records as Array<{ id: string }>).map((r) => r.id)).toEqual([
      'ada-lovelace',
      'zeb',
    ]);

    expect(await run(scoped({ action: 'delete', id: 'zeb' }))).toEqual({
      ok: true,
      action: 'delete',
      id: 'zeb',
    });
    await expect(run(scoped({ action: 'get', id: 'zeb' }))).rejects.toThrow(/No record 'zeb'/);
    expect((await run(scoped({ action: 'list' }))).total).toBe(1);
  });

  it('update shallow-merges and keeps id immutable', async () => {
    await run(scoped({ action: 'create', id: 'kit', fields: { a: 1, b: 1 } }));
    const updated = await run(
      scoped({ action: 'update', id: 'kit', fields: { b: 2, id: 'smuggled', version: 9 } }),
    );
    expect(updated.record).toEqual({ id: 'kit', a: 1, b: 2 });
    expect((await run(scoped({ action: 'get', id: 'kit' }))).record).toEqual({
      id: 'kit',
      a: 1,
      b: 2,
    });
  });

  it('generates ids from slug, then title, then a random suffix', async () => {
    expect((await run(scoped({ action: 'create', fields: { slug: 'A -- B!' } }))).id).toBe('a-b');
    expect((await run(scoped({ action: 'create', fields: { title: 'Mr. X' } }))).id).toBe('mr-x');
    const random = await run(scoped({ action: 'create', fields: { note: 'no name' } }));
    expect(random.id).toMatch(/^rec-[a-z0-9]{6}$/);
  });

  it('rejects creating an id that already exists', async () => {
    await run(scoped({ action: 'create', id: 'dup', fields: {} }));
    await expect(run(scoped({ action: 'create', id: 'dup', fields: {} }))).rejects.toThrow(
      /already exists/,
    );
  });

  it.each(['../x', 'a/b', '.', '', 'a\\b', 'UPPER'])('rejects hostile id %j', async (id) => {
    await expect(run(scoped({ action: 'get', id }))).rejects.toThrow(/Invalid record id/);
    await expect(run(scoped({ action: 'update', id, fields: {} }))).rejects.toThrow(
      /Invalid record id/,
    );
    await expect(run(scoped({ action: 'delete', id }))).rejects.toThrow(/Invalid record id/);
    await expect(run(scoped({ action: 'create', id, fields: {} }))).rejects.toThrow(
      /Invalid record id/,
    );
    expect(h.files.size).toBe(0);
  });

  it('rejects a non-object fields payload', async () => {
    await expect(run(scoped({ action: 'create', fields: [1, 2] }))).rejects.toThrow(
      /fields must be a JSON object/,
    );
  });

  it('names missing records with the known ids', async () => {
    await run(scoped({ action: 'create', id: 'only', fields: {} }));
    await expect(run(scoped({ action: 'get', id: 'ghost' }))).rejects.toThrow(
      /No record 'ghost'.*Known ids: only/,
    );
  });
});

describe('storeRecords folder-per-record layout', () => {
  it('writes version-1 record files, pretty-printed with a trailing newline', async () => {
    await run(folder({ action: 'create', id: 'ada', fields: { name: 'Ada' } }));
    const raw = h.files.get('crm/members/ada/record.json');
    expect(raw).toBe(`${JSON.stringify({ version: 1, id: 'ada', name: 'Ada' }, null, 2)}\n`);
  });

  it('regenerates index.json with scalar summary fields on every mutation', async () => {
    await run(
      folder({
        action: 'create',
        id: 'ada',
        fields: { name: 'Ada', age: 36, active: true, tags: ['x'], profile: { deep: 1 } },
      }),
    );
    const afterCreate = JSON.parse(h.files.get('crm/members/index.json') ?? '');
    expect(afterCreate).toEqual({
      version: 1,
      records: [{ id: 'ada', name: 'Ada', age: 36, active: true }],
    });

    await run(folder({ action: 'update', id: 'ada', fields: { age: 37 } }));
    const afterUpdate = JSON.parse(h.files.get('crm/members/index.json') ?? '');
    expect(afterUpdate.records).toEqual([{ id: 'ada', name: 'Ada', age: 37, active: true }]);

    await run(folder({ action: 'delete', id: 'ada' }));
    const afterDelete = JSON.parse(h.files.get('crm/members/index.json') ?? '');
    expect(afterDelete).toEqual({ version: 1, records: [] });
    expect(h.files.has('crm/members/ada/record.json')).toBe(false);
  });

  it('throws on an unknown record file version instead of resetting it', async () => {
    h.files.set(
      'crm/members/old/record.json',
      `${JSON.stringify({ version: 2, id: 'old' }, null, 2)}\n`,
    );
    await expect(run(folder({ action: 'get', id: 'old' }))).rejects.toThrow(
      /unsupported version 2 \(expected 1\)/,
    );
    await expect(run(folder({ action: 'list' }))).rejects.toThrow(/unsupported version 2/);
    expect(h.files.get('crm/members/old/record.json')).toContain('"version": 2');
  });

  it('lists an empty or missing root as zero records', async () => {
    expect(await run(folder({ action: 'list' }))).toEqual({
      ok: true,
      action: 'list',
      records: [],
      total: 0,
    });
  });
});

describe('storeRecords single-file layout', () => {
  it('keeps every record in <root>.json, pretty-printed with a trailing newline', async () => {
    await run(single({ action: 'create', id: 'ada', fields: { name: 'Ada' } }));
    const raw = h.files.get('crm/members.json');
    expect(raw).toBe(
      `${JSON.stringify({ version: 1, records: { ada: { name: 'Ada' } } }, null, 2)}\n`,
    );
    expect(h.files.has('crm/members/index.json')).toBe(false);
  });

  it('throws on an unknown store file version instead of resetting it', async () => {
    const seeded = `${JSON.stringify({ version: 2, records: {} })}\n`;
    h.files.set('crm/members.json', seeded);
    for (const action of ['create', 'get', 'update', 'delete', 'list']) {
      await expect(run(single({ action, id: 'x', fields: {} }))).rejects.toThrow(
        /unsupported version 2 \(expected 1\)/,
      );
    }
    expect(h.files.get('crm/members.json')).toBe(seeded);
  });

  it('throws on corrupt JSON instead of resetting it', async () => {
    h.files.set('crm/members.json', '{ not json');
    await expect(run(single({ action: 'list' }))).rejects.toThrow(/is not valid JSON/);
    expect(h.files.get('crm/members.json')).toBe('{ not json');
  });

  it('does not treat inherited object keys as records', async () => {
    await expect(run(single({ action: 'get', id: 'constructor' }))).rejects.toThrow(
      /No record 'constructor'/,
    );
  });
});

describe('storeRecords input validation', () => {
  it('rejects an empty root', async () => {
    await expect(run({ action: 'list', root: '', mode: 'single-file' })).rejects.toThrow(
      /root must be a non-empty/,
    );
  });
});
