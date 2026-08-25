import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogService, InstalledAiAppsSource } from '@bendyline/gezel-catalog';
import { aiAppItemsDir, aiAppReceiptFile, aiAppsRegistryFile } from '@bendyline/gezel/paths';
import AdmZip from 'adm-zip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { applyProjectType } from './apply.js';
import {
  importGezapp,
  listGezapps,
  packGezapp,
  readGezapp,
  removeGezapp,
  setGezappEnabled,
  verifyGezapp,
} from './gezapp.js';

let home: string;
let bundled: CatalogService;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezapp-'));
  bundled = new CatalogService();
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('.gezapp package round-trip', () => {
  it('packs one exact project-type version plus its referenced role', async () => {
    const { buffer, manifest } = await packGezapp(
      { catalog: bundled },
      { typeId: 'language-trainer' },
    );
    expect(manifest.format).toBe('gezel-ai-app');
    expect(manifest.signature).toEqual({ status: 'unsigned' });
    expect(manifest.entry.projectType).toBe('language-trainer');
    expect(manifest.items.map((item) => `${item.kind}:${item.id}`).sort()).toEqual([
      'gezel-template:language-trainer',
      'project-type:language-trainer',
    ]);

    const parsed = readGezapp(buffer);
    expect(verifyGezapp(parsed)).toEqual({ ok: true, errors: [] });
    const typeItem = manifest.items.find((item) => item.kind === 'project-type')!;
    const typeVersionPrefix = `items/project-types/la/language-trainer/versions/${typeItem.version}/`;
    const typeVersionFiles = [...parsed.files.keys()].filter((path) =>
      path.startsWith('items/project-types/la/language-trainer/versions/'),
    );
    expect(typeVersionFiles.length).toBeGreaterThan(1);
    expect(typeVersionFiles.every((path) => path.startsWith(typeVersionPrefix))).toBe(true);
    expect(typeVersionFiles.some((path) => path.endsWith('/pages/dashboard/index.html'))).toBe(
      true,
    );
  });

  it('embeds referenced standalone craftbook templates', async () => {
    const { manifest } = await packGezapp({ catalog: bundled }, { typeId: 'caregiving-binder' });
    expect(
      manifest.items.some((item) => item.kind === 'craftbook-template' && item.id === 'visit-prep'),
    ).toBe(true);
  });

  it('previews without installing, then atomically mounts a usable app with a receipt', async () => {
    const { buffer, manifest } = await packGezapp(
      { catalog: bundled },
      { typeId: 'language-trainer' },
    );
    const review = await importGezapp({ home, catalog: bundled }, buffer);
    expect(review.installed).toBeUndefined();
    expect(review.missingDependencies).toEqual([]);
    expect(existsSync(aiAppsRegistryFile(home))).toBe(false);

    const done = await importGezapp({ home, catalog: bundled }, buffer, { confirm: true });
    expect(done.installed).toMatchObject({
      appId: 'language-trainer',
      version: manifest.entry.version,
      alreadyPresent: false,
    });
    expect(existsSync(aiAppItemsDir(home, 'language-trainer', manifest.entry.version))).toBe(true);
    expect(existsSync(aiAppReceiptFile(home, 'language-trainer', manifest.entry.version))).toBe(
      true,
    );

    const registry = JSON.parse(await readFile(aiAppsRegistryFile(home), 'utf8')) as {
      apps: Array<{ appId: string; version: string }>;
    };
    expect(registry.apps).toContainEqual({
      appId: 'language-trainer',
      version: manifest.entry.version,
      packageSha256: done.packageSha256,
      installedAt: expect.any(String),
      enabled: true,
    });

    const installedOnly = new CatalogService([new InstalledAiAppsSource(home)]);
    const installed = await installedOnly.get('project-type', 'language-trainer');
    expect(installed?.manifest.version).toBe(manifest.entry.version);

    const store = new Store({ home });
    await store.ensureLayout();
    const project = await store.createProject({ name: 'Imported Spanish' });
    const applied = await applyProjectType(
      { store, catalog: installedOnly, home },
      { projectId: project.id, typeId: 'language-trainer', params: { language: 'Spanish' } },
    );
    expect(applied.gezelsCreated[0]?.templateId).toBe('language-trainer');
    expect(applied.scriptsInstalled).toContain('progress-store');

    const again = await importGezapp({ home, catalog: bundled }, buffer, { confirm: true });
    expect(again.installed?.alreadyPresent).toBe(true);
  });

  it('serializes concurrent installs so the active registry keeps both apps', async () => {
    const language = await packGezapp({ catalog: bundled }, { typeId: 'language-trainer' });
    const chat = await packGezapp({ catalog: bundled }, { typeId: 'just-chat' });
    await Promise.all([
      importGezapp({ home, catalog: bundled }, language.buffer, { confirm: true }),
      importGezapp({ home, catalog: bundled }, chat.buffer, { confirm: true }),
    ]);
    const registry = JSON.parse(await readFile(aiAppsRegistryFile(home), 'utf8')) as {
      apps: Array<{ appId: string }>;
    };
    expect(registry.apps.map((entry) => entry.appId).sort()).toEqual([
      'just-chat',
      'language-trainer',
    ]);
  });

  it('rejects content tampering', async () => {
    const { buffer } = await packGezapp({ catalog: bundled }, { typeId: 'language-trainer' });
    const parsed = readGezapp(buffer);
    const key = [...parsed.files.keys()].find((path) => path.endsWith('about.md'))!;
    parsed.files.set(key, Buffer.from('tampered'));
    const verification = verifyGezapp(parsed);
    expect(verification.ok).toBe(false);
    expect(verification.errors.join(' ')).toMatch(/sha256 mismatch/);
  });

  it('does not let a rehashed unsigned package shadow different catalog content', async () => {
    const { buffer } = await packGezapp({ catalog: bundled }, { typeId: 'language-trainer' });
    const parsed = readGezapp(buffer);
    const roleItem = parsed.manifest.items.find((item) => item.kind === 'gezel-template')!;
    const rolePrefix = `items/gezel-templates/la/${roleItem.id}/`;
    const aboutPath = [...parsed.files.keys()].find(
      (path) => path.startsWith(rolePrefix) && path.endsWith('/about.md'),
    )!;
    parsed.files.set(aboutPath, Buffer.from('Different instructions from an unsigned package.'));

    const hash = createHash('sha256');
    const roleFiles = [...parsed.files.entries()]
      .filter(([path]) => path.startsWith(rolePrefix))
      .map(([path, content]) => ({ rel: path.slice(rolePrefix.length), content }))
      .sort((a, b) => a.rel.localeCompare(b.rel));
    for (const file of roleFiles) {
      hash.update(file.rel);
      hash.update('\0');
      hash.update(file.content);
    }
    roleItem.sha256 = hash.digest('hex');

    const zip = new AdmZip();
    for (const [path, content] of parsed.files) zip.addFile(path, content);
    zip.addFile('manifest.json', Buffer.from(`${JSON.stringify(parsed.manifest, null, 2)}\n`));
    await expect(
      importGezapp({ home, catalog: bundled }, zip.toBuffer(), { confirm: true }),
    ).rejects.toThrow(/conflicts with .* content/);
  });

  it('derives item paths and rejects files placed under a manifest-selected decoy path', async () => {
    const { buffer } = await packGezapp({ catalog: bundled }, { typeId: 'language-trainer' });
    const parsed = readGezapp(buffer);
    const [key, content] = [...parsed.files.entries()].find(([path]) =>
      path.endsWith('project-types/la/language-trainer/manifest.json'),
    )!;
    parsed.files.delete(key);
    parsed.files.set('items/project-types/de/decoy/manifest.json', content);
    const verification = verifyGezapp(parsed);
    expect(verification.ok).toBe(false);
    expect(verification.errors.join(' ')).toMatch(
      /sha256 mismatch|unclaimed file|identity is missing/,
    );
  });

  it('enforces the package minGezelVersion before install', async () => {
    const { buffer } = await packGezapp({ catalog: bundled }, { typeId: 'language-trainer' });
    const zip = new AdmZip(buffer);
    const manifest = JSON.parse(zip.readAsText('manifest.json')) as Record<string, unknown>;
    manifest.minGezelVersion = '1.99999';
    zip.deleteFile('manifest.json');
    zip.addFile('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    await expect(
      importGezapp({ home, catalog: bundled, gezelVersion: '1.26001' }, zip.toBuffer()),
    ).rejects.toThrow(/requires Gezel 1\.99999/);
  });

  it('reports missing dependencies in preview and blocks required ones on confirm', async () => {
    const { buffer } = await packGezapp({ catalog: bundled }, { typeId: 'language-trainer' });
    const zip = new AdmZip(buffer);
    const manifest = JSON.parse(zip.readAsText('manifest.json')) as Record<string, unknown>;
    manifest.dependencies = [
      {
        kind: 'toolset',
        id: 'not-installed-for-test',
        version: '1.0.0',
        required: true,
      },
    ];
    zip.deleteFile('manifest.json');
    zip.addFile('manifest.json', Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    const packageBuffer = zip.toBuffer();

    const preview = await importGezapp({ home, catalog: bundled }, packageBuffer);
    expect(preview.missingDependencies).toMatchObject([
      { kind: 'toolset', id: 'not-installed-for-test', version: '1.0.0', required: true },
    ]);
    await expect(
      importGezapp({ home, catalog: bundled }, packageBuffer, { confirm: true }),
    ).rejects.toThrow(/required dependencies are unavailable/);
    expect(existsSync(aiAppsRegistryFile(home))).toBe(false);
  });

  it('does not accept the legacy generic-bundle manifest shape', () => {
    const zip = new AdmZip();
    zip.addFile(
      'manifest.json',
      Buffer.from(JSON.stringify({ schemaVersion: 1, name: 'legacy', items: [] })),
    );
    expect(() => readGezapp(zip.toBuffer())).toThrow(/invalid \.gezapp manifest/);
  });
});

describe('install-level management', () => {
  it('lists installed apps with receipts and on-disk versions', async () => {
    const { buffer, manifest } = await packGezapp(
      { catalog: bundled },
      { typeId: 'language-trainer' },
    );
    await importGezapp({ home, catalog: bundled }, buffer, { confirm: true });
    const apps = await listGezapps(home);
    expect(apps).toHaveLength(1);
    expect(apps[0]?.entry).toMatchObject({
      appId: 'language-trainer',
      version: manifest.entry.version,
      enabled: true,
    });
    expect(apps[0]?.receipt?.manifest.name).toBe(manifest.name);
    expect(apps[0]?.versionsOnDisk).toEqual([manifest.entry.version]);
  });

  it('lists nothing on a fresh home', async () => {
    expect(await listGezapps(home)).toEqual([]);
  });

  it('disable hides the app from the catalog; enable restores it', async () => {
    const { buffer } = await packGezapp({ catalog: bundled }, { typeId: 'language-trainer' });
    await importGezapp({ home, catalog: bundled }, buffer, { confirm: true });
    const installedOnly = new CatalogService([new InstalledAiAppsSource(home)]);
    expect(await installedOnly.get('project-type', 'language-trainer')).not.toBeNull();

    const disabled = await setGezappEnabled(home, 'language-trainer', false);
    expect(disabled?.enabled).toBe(false);
    expect(await installedOnly.get('project-type', 'language-trainer')).toBeNull();

    const enabled = await setGezappEnabled(home, 'language-trainer', true);
    expect(enabled?.enabled).toBe(true);
    expect(await installedOnly.get('project-type', 'language-trainer')).not.toBeNull();
  });

  it('setGezappEnabled returns null for an unknown app', async () => {
    expect(await setGezappEnabled(home, 'no-such-app', false)).toBeNull();
  });

  it('remove drops the registry entry and deletes the version dirs', async () => {
    const { buffer, manifest } = await packGezapp(
      { catalog: bundled },
      { typeId: 'language-trainer' },
    );
    await importGezapp({ home, catalog: bundled }, buffer, { confirm: true });
    const removed = await removeGezapp(home, 'language-trainer');
    expect(removed).toEqual({
      appId: 'language-trainer',
      removedVersions: [manifest.entry.version],
      keptVersions: [],
    });
    expect(await listGezapps(home)).toEqual([]);
    expect(existsSync(aiAppItemsDir(home, 'language-trainer', manifest.entry.version))).toBe(false);
    const installedOnly = new CatalogService([new InstalledAiAppsSource(home)]);
    expect(await installedOnly.get('project-type', 'language-trainer')).toBeNull();
  });

  it('remove returns null for an unknown app', async () => {
    expect(await removeGezapp(home, 'no-such-app')).toBeNull();
  });

  it('keepFiles leaves the bytes, and a re-import re-adopts them untouched', async () => {
    const { buffer, manifest } = await packGezapp(
      { catalog: bundled },
      { typeId: 'language-trainer' },
    );
    await importGezapp({ home, catalog: bundled }, buffer, { confirm: true });
    const removed = await removeGezapp(home, 'language-trainer', { keepFiles: true });
    expect(removed?.keptVersions).toEqual([manifest.entry.version]);
    expect(await listGezapps(home)).toEqual([]);
    expect(existsSync(aiAppReceiptFile(home, 'language-trainer', manifest.entry.version))).toBe(
      true,
    );

    const again = await importGezapp({ home, catalog: bundled }, buffer, { confirm: true });
    expect(again.installed).toMatchObject({ appId: 'language-trainer', alreadyPresent: true });
    const apps = await listGezapps(home);
    expect(apps[0]?.entry.enabled).toBe(true);
  });

  it('serializes a remove racing an install — no lost registry update', async () => {
    const language = await packGezapp({ catalog: bundled }, { typeId: 'language-trainer' });
    const chat = await packGezapp({ catalog: bundled }, { typeId: 'just-chat' });
    await importGezapp({ home, catalog: bundled }, language.buffer, { confirm: true });
    await Promise.all([
      removeGezapp(home, 'language-trainer'),
      importGezapp({ home, catalog: bundled }, chat.buffer, { confirm: true }),
    ]);
    const apps = await listGezapps(home);
    expect(apps.map((app) => app.entry.appId)).toEqual(['just-chat']);
  });

  it('re-importing installed bytes re-enables a disabled app', async () => {
    const { buffer } = await packGezapp({ catalog: bundled }, { typeId: 'language-trainer' });
    await importGezapp({ home, catalog: bundled }, buffer, { confirm: true });
    await setGezappEnabled(home, 'language-trainer', false);
    const again = await importGezapp({ home, catalog: bundled }, buffer, { confirm: true });
    expect(again.installed?.alreadyPresent).toBe(true);
    const apps = await listGezapps(home);
    expect(apps[0]?.entry.enabled).toBe(true);
  });
});
