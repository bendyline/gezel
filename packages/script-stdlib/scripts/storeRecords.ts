import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';

/**
 * Generic CRUD over a small record store in the project workspace, in one
 * of two layouts chosen by the binding:
 *
 *  - `folder-per-record` — each record lives at `<root>/<id>/record.json`
 *    (`{ version: 1, id, ...fields }`), and `<root>/index.json` holds a
 *    regenerated summary (`{ version: 1, records: [{ id, ...scalars }] }`)
 *    so pages and gezels can render a roster without N reads.
 *  - `single-file` — every record lives in `<root>.json` as
 *    `{ version: 1, records: { [id]: fields } }`.
 *
 * Persistence discipline mirrors `@bendyline/gezel-sdk/stores`: files are
 * pretty-printed with a trailing newline, a missing file means "no store
 * yet", and corrupt JSON or an unknown `version` throws — user data is
 * never silently reset. Ids are validated against a strict pattern before
 * any path is built; supplied ids are never laundered into a usable one.
 */

export const meta = defineScript({
  name: 'storeRecords',
  description:
    'Action: generic CRUD (create/update/delete/get/list) over a workspace record store — one folder per record with a regenerated index.json, or a single <root>.json file.',
  kind: 'action',
  inputs: {
    action: {
      type: 'choice',
      description: 'Operation to perform.',
      required: true,
      options: [
        { value: 'create' },
        { value: 'update' },
        { value: 'delete' },
        { value: 'get' },
        { value: 'list' },
      ],
    },
    id: {
      type: 'string',
      description:
        'Record id (lowercase letters, digits, dashes; max 80 chars). Required for get/update/delete. Optional for create — generated from fields.slug, fields.title, or a random suffix when omitted.',
    },
    fields: {
      type: 'json',
      description:
        'Record body for create/update: an object of field values. The id field is immutable and stripped from the body.',
    },
    root: {
      type: 'string',
      description: 'Workspace-relative root directory of the store (bind-provided).',
      required: true,
    },
    mode: {
      type: 'choice',
      description: 'Store layout (bind-provided).',
      required: true,
      options: [{ value: 'folder-per-record' }, { value: 'single-file' }],
    },
  },
  outputs: {
    ok: { type: 'boolean', description: 'True when the operation completed; failures throw.' },
    action: { type: 'string', description: 'The operation that ran.' },
    id: {
      type: 'string',
      description: 'Affected record id (create/get/update/delete).',
      nullable: true,
    },
    record: { type: 'json', description: 'The record, id included (create/get/update).' },
    records: {
      type: 'array',
      description: 'Every record, sorted by id (list).',
      itemType: 'object',
    },
    total: { type: 'number', description: 'Record count (list).', nullable: true },
  },
  requires: ['workspace.read', 'workspace.write'],
} as const);

type Fields = Record<string, unknown>;

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,79}$/;

const input = gezel.input as InferredInput<typeof meta>;

function fail(message: string): never {
  throw new Error(message);
}

const root = String(input.root ?? '')
  .replace(/\\+/g, '/')
  .replace(/\/+$/, '');
if (!root) fail('root must be a non-empty workspace-relative path.');

const mode = input.mode;
const storeFile = `${root}.json`;
const indexFile = `${root}/index.json`;

function recordFile(id: string): string {
  return `${root}/${id}/record.json`;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '');
}

// Supplied ids are validated, never laundered: slugifying '../x' into a
// usable id would silently resolve a hostile input to a real record.
function requireSuppliedId(raw: unknown): string {
  if (typeof raw !== 'string' || !ID_PATTERN.test(raw)) {
    fail(
      `Invalid record id ${JSON.stringify(raw ?? null)}: expected 1-80 chars of lowercase letters, digits, and dashes, starting with a letter or digit (no path separators or dots).`,
    );
  }
  return raw;
}

function generatedId(fields: Fields): string {
  for (const candidate of [fields.slug, fields.title]) {
    if (typeof candidate === 'string') {
      const slug = slugify(candidate);
      if (ID_PATTERN.test(slug)) return slug;
    }
  }
  return `rec-${Math.random().toString(36).slice(2, 8).padEnd(6, '0')}`;
}

function normalizedFields(): Fields {
  const raw: unknown = input.fields;
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    fail('fields must be a JSON object of field values.');
  }
  const body: Fields = {};
  for (const [key, value] of Object.entries(raw as Fields)) {
    // id is immutable identity and version is the file-format stamp;
    // neither may be smuggled in through the body.
    if (key === 'id' || key === 'version') continue;
    body[key] = value;
  }
  return body;
}

function parseVersioned(path: string, raw: string): Fields {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(
      `Store file ${path} is not valid JSON (${err instanceof Error ? err.message : String(err)}). Fix or remove the file; it will not be overwritten automatically.`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail(`Store file ${path} must contain a JSON object.`);
  }
  const version = (parsed as { version?: unknown }).version;
  if (version !== 1) {
    fail(`Store file ${path} has unsupported version ${String(version)} (expected 1).`);
  }
  return parsed as Fields;
}

// The structural fs interface throws on both missing and unreadable, so a
// failed read means "no record/store yet" (same rule as the sdk stores).
async function readJsonIfPresent(path: string): Promise<Fields | null> {
  let raw: string;
  try {
    raw = await gezel.fs.read(path);
  } catch {
    return null;
  }
  return parseVersioned(path, raw);
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await gezel.fs.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function recordFromFile(id: string, file: Fields): Fields {
  // The folder name is the authoritative id — a hand-renamed folder must
  // not surface a record whose id cannot be fetched back.
  const record: Fields = { id };
  for (const [key, value] of Object.entries(file)) {
    if (key === 'version' || key === 'id') continue;
    record[key] = value;
  }
  return record;
}

async function folderEntries(): Promise<Array<{ name: string; isDirectory: boolean }>> {
  try {
    return await gezel.fs.list(root);
  } catch {
    return [];
  }
}

async function folderIds(): Promise<string[]> {
  return (await folderEntries())
    .filter((entry) => entry.isDirectory)
    .map((entry) => entry.name)
    .sort();
}

async function folderList(): Promise<Fields[]> {
  const records: Fields[] = [];
  for (const id of await folderIds()) {
    const file = await readJsonIfPresent(recordFile(id));
    // A folder without a record.json is not a record (e.g. a leftover
    // emptied folder — see remove()).
    if (file === null) continue;
    records.push(recordFromFile(id, file));
  }
  return records;
}

async function regenerateFolderIndex(): Promise<void> {
  const records = await folderList();
  const index = {
    version: 1,
    records: records.map((record) => {
      const summary: Fields = { id: record.id };
      for (const [key, value] of Object.entries(record)) {
        if (key === 'id') continue;
        const kind = typeof value;
        if (kind === 'string' || kind === 'number' || kind === 'boolean') summary[key] = value;
      }
      return summary;
    }),
  };
  await writeJson(indexFile, index);
}

// Object.hasOwn everywhere: 'constructor' is a valid id but an inherited
// key on every parsed object — a plain `records[id]` check would resolve it.
function loadedRecords(file: Fields | null): Record<string, unknown> {
  if (file === null) return {};
  const records = file.records;
  if (records === undefined) return {};
  if (typeof records !== 'object' || records === null || Array.isArray(records)) {
    fail(
      `Store file ${storeFile} has a malformed records map. Fix or remove the file; it will not be overwritten automatically.`,
    );
  }
  return records as Record<string, unknown>;
}

function bodyOf(records: Record<string, unknown>, id: string): Fields {
  const body = records[id];
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail(
      `Store file ${storeFile} record '${id}' is not an object. Fix or remove the file; it will not be overwritten automatically.`,
    );
  }
  return body as Fields;
}

async function loadSingleFile(): Promise<Record<string, unknown>> {
  return loadedRecords(await readJsonIfPresent(storeFile));
}

async function saveSingleFile(records: Record<string, unknown>): Promise<void> {
  await writeJson(storeFile, { version: 1, records });
}

function noRecord(id: string, knownIds: string[]): never {
  const where = mode === 'single-file' ? storeFile : root;
  fail(`No record '${id}' in ${where}. Known ids: ${knownIds.join(', ') || '(none)'}`);
}

async function create(): Promise<Fields> {
  const fields = normalizedFields();
  const id = input.id !== undefined ? requireSuppliedId(input.id) : generatedId(fields);
  if (mode === 'folder-per-record') {
    if ((await readJsonIfPresent(recordFile(id))) !== null) {
      fail(`Record '${id}' already exists in ${root}.`);
    }
    await writeJson(recordFile(id), { version: 1, id, ...fields });
    await regenerateFolderIndex();
  } else {
    const records = await loadSingleFile();
    if (Object.hasOwn(records, id)) fail(`Record '${id}' already exists in ${storeFile}.`);
    records[id] = fields;
    await saveSingleFile(records);
  }
  return { ok: true, action: 'create', id, record: { id, ...fields } };
}

async function get(): Promise<Fields> {
  const id = requireSuppliedId(input.id);
  if (mode === 'folder-per-record') {
    const file = await readJsonIfPresent(recordFile(id));
    if (file === null) noRecord(id, await folderIds());
    return { ok: true, action: 'get', id, record: recordFromFile(id, file) };
  }
  const records = await loadSingleFile();
  if (!Object.hasOwn(records, id)) noRecord(id, Object.keys(records).sort());
  return { ok: true, action: 'get', id, record: { id, ...bodyOf(records, id) } };
}

async function update(): Promise<Fields> {
  const id = requireSuppliedId(input.id);
  const patch = normalizedFields();
  if (mode === 'folder-per-record') {
    const file = await readJsonIfPresent(recordFile(id));
    if (file === null) noRecord(id, await folderIds());
    const merged = { ...recordFromFile(id, file), ...patch, id };
    await writeJson(recordFile(id), { version: 1, ...merged });
    await regenerateFolderIndex();
    return { ok: true, action: 'update', id, record: merged };
  }
  const records = await loadSingleFile();
  if (!Object.hasOwn(records, id)) noRecord(id, Object.keys(records).sort());
  const merged = { ...bodyOf(records, id), ...patch };
  records[id] = merged;
  await saveSingleFile(records);
  return { ok: true, action: 'update', id, record: { id, ...merged } };
}

async function remove(): Promise<Fields> {
  const id = requireSuppliedId(input.id);
  if (mode === 'folder-per-record') {
    if ((await readJsonIfPresent(recordFile(id))) === null) noRecord(id, await folderIds());
    const dir = `${root}/${id}`;
    let entries: Array<{ name: string; isDirectory: boolean }> = [];
    try {
      entries = await gezel.fs.list(dir);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!entry.isDirectory) await gezel.fs.rm(`${dir}/${entry.name}`);
    }
    // The sdk fs surface has no directory removal; record.json going away
    // is what unregisters the record (get/list key off it), so a runtime
    // that refuses to remove the emptied folder is tolerated.
    try {
      await gezel.fs.rm(dir);
    } catch {
      // inert emptied folder left behind
    }
    await regenerateFolderIndex();
    return { ok: true, action: 'delete', id };
  }
  const records = await loadSingleFile();
  if (!Object.hasOwn(records, id)) noRecord(id, Object.keys(records).sort());
  delete records[id];
  await saveSingleFile(records);
  return { ok: true, action: 'delete', id };
}

async function list(): Promise<Fields> {
  if (mode === 'folder-per-record') {
    const records = await folderList();
    return { ok: true, action: 'list', records, total: records.length };
  }
  const records = await loadSingleFile();
  const out = Object.keys(records)
    .sort()
    .map((id) => ({ id, ...bodyOf(records, id) }));
  return { ok: true, action: 'list', records: out, total: out.length };
}

async function run(): Promise<Fields> {
  switch (input.action) {
    case 'create':
      return create();
    case 'get':
      return get();
    case 'update':
      return update();
    case 'delete':
      return remove();
    case 'list':
      return list();
    default:
      return fail(`Unknown action '${String(input.action)}'.`);
  }
}

gezel.output(await run());
