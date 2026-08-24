import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import AdmZip from 'adm-zip';
import { afterEach, describe, expect, it } from 'vitest';
import {
  GezappSourceError,
  isGezappSourceDir,
  packGezappFromSource,
  renderGezappAuthoringSchemaFiles,
  validateGezappSource,
} from './gezapp-source.js';
import { readGezapp, verifyGezapp } from './gezapp.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gezel-gezapp-source-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function writeTree(root: string, files: Record<string, string>): Promise<string> {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return root;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const SOURCE_MANIFEST = json({
  format: 'gezel-ai-app-source',
  schemaVersion: 1,
  publisher: { name: 'Test Publisher' },
});

const TYPE_DIR = 'items/project-types/de/demo-notes';
const ROLE_DIR = 'items/gezel-templates/de/demo-notes-lead';

function minimalApp(): Record<string, string> {
  return {
    'gezapp.json': SOURCE_MANIFEST,
    [`${TYPE_DIR}/manifest.json`]: json({
      schemaVersion: 1,
      kind: 'project-type',
      id: 'demo-notes',
      name: 'Demo Notes',
      description: 'A demo notes workspace.',
      maintainer: { name: 'Test Publisher' },
    }),
    [`${TYPE_DIR}/versions/1.0.0/manifest.json`]: json({
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-01-01T00:00:00Z',
    }),
  };
}

const STORE_SCRIPT = `import { type InferredInput, defineScript, gezel } from '@bendyline/gezel-sdk';

export const meta = defineScript({
  name: 'notes-store',
  description: 'Store notes records in the workspace.',
  kind: 'action',
  inputs: {
    action: { type: 'string', description: 'Operation to run.', default: 'add' },
    title: { type: 'string', description: 'Note title.', default: '' },
  },
  outputs: {
    ok: { type: 'boolean', description: 'Whether the operation succeeded.' },
  },
  requires: ['workspace.read', 'workspace.write'],
} as const);

const input = gezel.input as InferredInput<typeof meta>;
gezel.output({ ok: input.action.length > 0 });
`;

const DASHBOARD_HTML = `<!doctype html>
<html>
<head>
<style>
  :root { color-scheme: light dark; --bg: #faf7f2; }
  body { background: var(--bg); }
  @media (prefers-color-scheme: dark) { :root { --bg: #201d1a; } }
</style>
</head>
<body>
<main id="notes"></main>
<script>
  async function render() {
    const notes = await gezel.data.read('notes.json', { as: 'json' });
    document.querySelector('#notes').textContent = String(notes.items.length);
  }
  render();
</script>
</body>
</html>
`;

function fullApp(): Record<string, string> {
  return {
    'gezapp.json': SOURCE_MANIFEST,
    [`${TYPE_DIR}/manifest.json`]: json({
      schemaVersion: 1,
      kind: 'project-type',
      id: 'demo-notes',
      name: 'Demo Notes',
      description: 'A demo notes workspace.',
      maintainer: { name: 'Test Publisher' },
    }),
    [`${TYPE_DIR}/versions/1.0.0/manifest.json`]: json({
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-01-01T00:00:00Z',
      aboutTemplate: 'about.md',
      gezels: [{ templateId: 'demo-notes-lead', voorman: true }],
      craftbooks: ['tidy-notes'],
      tools: [
        {
          name: 'add_note',
          description: 'Add one note.',
          script: 'notes-store',
          inputs: {
            type: 'object',
            properties: { title: { type: 'string' } },
            required: ['title'],
          },
          bind: { action: 'add' },
        },
      ],
      pages: {
        entry: 'dashboard/index.html',
        api: 1,
        reads: [{ source: 'workspace', path: 'notes.json' }],
        tools: ['add_note'],
      },
      workspaceSeed: ['notes.json'],
    }),
    [`${TYPE_DIR}/versions/1.0.0/about.md`]: 'A notes workspace for demos.\n',
    [`${TYPE_DIR}/versions/1.0.0/notes.json`]: json({ items: [] }),
    [`${TYPE_DIR}/versions/1.0.0/scripts/notes-store.ts`]: STORE_SCRIPT,
    [`${TYPE_DIR}/versions/1.0.0/craftbooks/tidy-notes.json`]: json({
      id: 'tidy-notes',
      name: 'Tidy notes',
      description: 'Review and tidy the notes file.',
      steps: [
        {
          id: 'tidy',
          name: 'Tidy',
          prompt: 'Read notes.json and tidy duplicate entries.',
          terminal: true,
        },
      ],
    }),
    [`${TYPE_DIR}/versions/1.0.0/pages/dashboard/index.html`]: DASHBOARD_HTML,
    [`${ROLE_DIR}/manifest.json`]: json({
      schemaVersion: 1,
      kind: 'gezel-template',
      id: 'demo-notes-lead',
      name: 'Demo Notes Lead',
      description: 'Keeps the notes tidy.',
      role: 'Notekeeper',
      maintainer: { name: 'Test Publisher' },
    }),
    [`${ROLE_DIR}/versions/1.0.0/manifest.json`]: json({
      schemaVersion: 1,
      version: '1.0.0',
      releasedAt: '2026-01-01T00:00:00Z',
      about: 'about.md',
    }),
    [`${ROLE_DIR}/versions/1.0.0/about.md`]: 'You keep notes tidy and short.\n',
  };
}

function rules(findings: Array<{ rule: string; severity: string }>): string[] {
  return findings.map((finding) => finding.rule);
}

function errorRules(findings: Array<{ rule: string; severity: string }>): string[] {
  return findings.filter((finding) => finding.severity === 'error').map((finding) => finding.rule);
}

describe('validateGezappSource', () => {
  it('accepts a minimal single-item app with no findings', async () => {
    const dir = await writeTree(await tempDir(), minimalApp());
    const result = await validateGezappSource(dir);
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.manifest?.entry).toEqual({ projectType: 'demo-notes', version: '1.0.0' });
    expect(result.manifest?.publisher).toEqual({ name: 'Test Publisher' });
  });

  it('accepts the full fixture (sidecar script, page, role, embedded craftbook)', async () => {
    const dir = await writeTree(await tempDir(), fullApp());
    const result = await validateGezappSource(dir);
    expect(errorRules(result.findings)).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('rejects a script defined both inline and as a sidecar', async () => {
    const files = fullApp();
    const manifest = JSON.parse(files[`${TYPE_DIR}/versions/1.0.0/manifest.json`]!);
    manifest.scripts = { 'notes-store': STORE_SCRIPT };
    files[`${TYPE_DIR}/versions/1.0.0/manifest.json`] = json(manifest);
    const dir = await writeTree(await tempDir(), files);
    const result = await validateGezappSource(dir);
    expect(errorRules(result.findings)).toContain('script-name-collision');
  });

  it('flags a sidecar whose meta.name differs from its filename', async () => {
    const files = fullApp();
    files[`${TYPE_DIR}/versions/1.0.0/scripts/notes-store.ts`] = STORE_SCRIPT.replace(
      "name: 'notes-store'",
      "name: 'other-name'",
    );
    const dir = await writeTree(await tempDir(), files);
    const result = await validateGezappSource(dir);
    const scriptErrors = result.findings.filter(
      (finding) => finding.rule === 'script-diagnostic' && finding.severity === 'error',
    );
    expect(scriptErrors.some((finding) => finding.message.includes('meta.name'))).toBe(true);
    expect(scriptErrors[0]?.file).toBe(`${TYPE_DIR}/versions/1.0.0/scripts/notes-store.ts`);
  });

  it('flags missing referenced files', async () => {
    const files = fullApp();
    delete files[`${TYPE_DIR}/versions/1.0.0/notes.json`];
    const dir = await writeTree(await tempDir(), files);
    const result = await validateGezappSource(dir);
    const missing = result.findings.filter((finding) => finding.rule === 'missing-referenced-file');
    expect(missing.map((finding) => finding.pointer)).toContain('/workspaceSeed/0');
  });

  it('flags an embedded craftbook with a broken step graph', async () => {
    const files = fullApp();
    const doc = JSON.parse(files[`${TYPE_DIR}/versions/1.0.0/craftbooks/tidy-notes.json`]!);
    doc.steps[0].terminal = false;
    doc.steps[0].next = 'does-not-exist';
    files[`${TYPE_DIR}/versions/1.0.0/craftbooks/tidy-notes.json`] = json(doc);
    const dir = await writeTree(await tempDir(), files);
    const result = await validateGezappSource(dir);
    expect(errorRules(result.findings)).toContain('invalid-craftbook');
  });

  it('flags a required toolset that no catalog resolves', async () => {
    const files = minimalApp();
    const manifest = JSON.parse(files[`${TYPE_DIR}/versions/1.0.0/manifest.json`]!);
    manifest.toolsets = [{ id: 'definitely-not-a-real-toolset', need: 'required' }];
    files[`${TYPE_DIR}/versions/1.0.0/manifest.json`] = json(manifest);
    const dir = await writeTree(await tempDir(), files);
    const result = await validateGezappSource(dir);
    expect(errorRules(result.findings)).toContain('dependency-lock');
  });

  it('resolves a bundled required toolset into the dependency lock', async () => {
    const files = minimalApp();
    const manifest = JSON.parse(files[`${TYPE_DIR}/versions/1.0.0/manifest.json`]!);
    manifest.toolsets = [{ id: 'web-search', need: 'required' }];
    files[`${TYPE_DIR}/versions/1.0.0/manifest.json`] = json(manifest);
    const dir = await writeTree(await tempDir(), files);
    const result = await validateGezappSource(dir);
    expect(errorRules(result.findings)).toEqual([]);
    expect(result.manifest?.dependencies.map((dependency) => dependency.id)).toEqual([
      'web-search',
    ]);
  });

  it('flags a shard mismatch', async () => {
    const files = minimalApp();
    for (const [rel, content] of Object.entries(files)) {
      if (!rel.startsWith(TYPE_DIR)) continue;
      files[rel.replace('/de/', '/xx/')] = content;
      delete files[rel];
    }
    const dir = await writeTree(await tempDir(), files);
    const result = await validateGezappSource(dir);
    expect(errorRules(result.findings)).toContain('shard-mismatch');
  });

  it('rejects derived fields pasted into gezapp.json', async () => {
    const files = minimalApp();
    files['gezapp.json'] = json({
      format: 'gezel-ai-app-source',
      schemaVersion: 1,
      items: [],
      createdAt: '2026-01-01T00:00:00Z',
    });
    const dir = await writeTree(await tempDir(), files);
    const result = await validateGezappSource(dir);
    expect(errorRules(result.findings)).toContain('source-manifest-derived-field');
  });

  it('warns (not errors) when gezapp.json is absent', async () => {
    const files = minimalApp();
    delete files['gezapp.json'];
    const dir = await writeTree(await tempDir(), files);
    const result = await validateGezappSource(dir);
    expect(result.ok).toBe(true);
    expect(rules(result.findings)).toContain('missing-source-manifest');
    // Publisher falls back to the identity maintainer.
    expect(result.manifest?.publisher).toEqual({ name: 'Test Publisher' });
  });

  it('honors an entry version pin and defaults to the highest semver', async () => {
    const files = minimalApp();
    files[`${TYPE_DIR}/versions/1.1.0/manifest.json`] = json({
      schemaVersion: 1,
      version: '1.1.0',
      releasedAt: '2026-02-01T00:00:00Z',
    });
    const dir = await writeTree(await tempDir(), files);
    const highest = await validateGezappSource(dir);
    expect(highest.manifest?.entry.version).toBe('1.1.0');

    files['gezapp.json'] = json({
      format: 'gezel-ai-app-source',
      schemaVersion: 1,
      entry: { projectType: 'demo-notes', version: '1.0.0' },
      publisher: { name: 'Test Publisher' },
    });
    const pinnedDir = await writeTree(await tempDir(), files);
    const pinned = await validateGezappSource(pinnedDir);
    expect(pinned.manifest?.entry.version).toBe('1.0.0');
  });
});

describe('packGezappFromSource', () => {
  it('packs, folds sidecars inline, drops the files, and verifies clean', async () => {
    const dir = await writeTree(await tempDir(), fullApp());
    const packed = await packGezappFromSource(dir, { createdAt: '2026-03-01T00:00:00.000Z' });
    const parsed = readGezapp(packed.buffer);
    expect(verifyGezapp(parsed)).toEqual({ ok: true, errors: [] });

    const paths = [...parsed.files.keys()];
    expect(paths.some((path) => path.includes('/scripts/'))).toBe(false);
    const versionManifest = JSON.parse(
      parsed.files.get(`${TYPE_DIR}/versions/1.0.0/manifest.json`)!.toString('utf8'),
    );
    expect(versionManifest.scripts['notes-store']).toContain("name: 'notes-store'");
    expect(parsed.manifest.entry).toEqual({ projectType: 'demo-notes', version: '1.0.0' });
  });

  it('is deterministic for a fixed createdAt', async () => {
    const files = fullApp();
    const first = await packGezappFromSource(await writeTree(await tempDir(), files), {
      createdAt: '2026-03-01T00:00:00.000Z',
    });
    const second = await packGezappFromSource(await writeTree(await tempDir(), files), {
      createdAt: '2026-03-01T00:00:00.000Z',
    });
    expect(second.manifest).toEqual(first.manifest);
  });

  it('round-trips an unzipped package as a valid source folder', async () => {
    const dir = await writeTree(await tempDir(), fullApp());
    const packed = await packGezappFromSource(dir, { createdAt: '2026-03-01T00:00:00.000Z' });

    const unzipped = await tempDir();
    new AdmZip(packed.buffer).extractAllTo(unzipped, true);
    const result = await validateGezappSource(unzipped);
    expect(errorRules(result.findings)).toEqual([]);
    expect(rules(result.findings)).toContain('stale-packed-manifest');

    const repacked = await packGezappFromSource(unzipped, {
      createdAt: '2026-03-01T00:00:00.000Z',
    });
    expect(repacked.manifest.items).toEqual(packed.manifest.items);
  });

  it('refuses to pack a folder with errors, carrying the findings', async () => {
    const files = fullApp();
    delete files[`${TYPE_DIR}/versions/1.0.0/notes.json`];
    const dir = await writeTree(await tempDir(), files);
    await expect(packGezappFromSource(dir)).rejects.toThrow(GezappSourceError);
    await packGezappFromSource(dir).catch((err: GezappSourceError) => {
      expect(errorRules(err.findings)).toContain('missing-referenced-file');
    });
  });
});

describe('isGezappSourceDir', () => {
  it('detects source folders by gezapp.json or items/', async () => {
    const withManifest = await writeTree(await tempDir(), { 'gezapp.json': SOURCE_MANIFEST });
    expect(await isGezappSourceDir(withManifest)).toBe(true);
    const withItems = await writeTree(await tempDir(), { 'items/.gitkeep': '' });
    expect(await isGezappSourceDir(withItems)).toBe(true);
    const empty = await tempDir();
    expect(await isGezappSourceDir(empty)).toBe(false);
  });
});

describe('renderGezappAuthoringSchemaFiles', () => {
  it('serves every catalog schema plus both gezapp manifests', async () => {
    const files = renderGezappAuthoringSchemaFiles();
    const names = files.map(([filename]) => filename);
    expect(names).toContain('project-type-version.schema.json');
    expect(names).toContain('gezapp-manifest.schema.json');
    expect(names).toContain('gezapp-source-manifest.schema.json');
    for (const [, content] of files) {
      expect(() => JSON.parse(content)).not.toThrow();
    }
  });
});
