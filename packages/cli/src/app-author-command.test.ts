import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readGezapp, verifyGezapp } from '@bendyline/gezel-service/gezapp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAppNew, runAppPack, runAppSchemas, runAppValidate } from './app-author-command.js';
import { scaffoldGezappSource } from './app-scaffold.js';

let dir: string;
let logged: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gezel-app-author-'));
  logged = [];
  process.exitCode = undefined;
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await rm(dir, { recursive: true, force: true });
});

const output = (): string => logged.join('\n');

describe('gezel app new / validate / pack', () => {
  it('scaffolds an app that validates with zero findings and packs clean', async () => {
    await runAppNew('field-notes', { dir, withPage: true });
    const appDir = join(dir, 'field-notes');
    expect(output()).toContain('Scaffolded field-notes');

    logged = [];
    await runAppValidate(appDir, { json: true });
    const validated = JSON.parse(output()) as {
      ok: boolean;
      entry: { projectType: string; version: string };
      findings: unknown[];
    };
    expect(validated.findings).toEqual([]);
    expect(validated.ok).toBe(true);
    expect(validated.entry).toEqual({ projectType: 'field-notes', version: '1.0.0' });
    expect(process.exitCode).toBeUndefined();

    logged = [];
    const out = join(dir, 'field-notes.gezapp');
    await runAppPack(appDir, { out });
    expect(output()).toContain('Packed Field Notes 1.0.0');
    const parsed = readGezapp(await readFile(out));
    expect(verifyGezapp(parsed)).toEqual({ ok: true, errors: [] });
    // The sidecar script was folded inline and dropped from the archive.
    expect([...parsed.files.keys()].some((path) => path.includes('/scripts/'))).toBe(false);

    // validate accepts the packed file too.
    logged = [];
    await runAppValidate(out, {});
    expect(output()).toContain('OK');
    expect(process.exitCode).toBeUndefined();
  });

  it('reports rule ids and exits nonzero on a broken folder', async () => {
    await runAppNew('field-notes', { dir });
    const appDir = join(dir, 'field-notes');
    const seed = join(appDir, 'items/project-types/fi/field-notes/versions/1.0.0/data.json');
    await rm(seed);

    logged = [];
    await runAppValidate(appDir, {});
    expect(output()).toContain('missing-referenced-file');
    expect(process.exitCode).toBe(1);

    process.exitCode = undefined;
    logged = [];
    await runAppPack(appDir, { out: join(dir, 'broken.gezapp') });
    expect(output()).toContain('Not packed');
    expect(process.exitCode).toBe(1);

    // Fix it and the loop completes.
    process.exitCode = undefined;
    await writeFile(seed, '{"records":[]}\n');
    logged = [];
    await runAppValidate(appDir, { json: true });
    expect((JSON.parse(output()) as { ok: boolean }).ok).toBe(true);
  });

  it('refuses a non-empty target and a bad id', async () => {
    await runAppNew('field-notes', { dir });
    await expect(runAppNew('field-notes', { dir })).rejects.toThrow(/not empty/);
    await expect(runAppNew('Bad_Id!', { dir })).rejects.toThrow(/not a valid app id/);
  });

  it('scaffold stays flag-consistent: no page files without --with-page', () => {
    const base = scaffoldGezappSource('field-notes');
    expect(base.some(([rel]) => rel.includes('/pages/'))).toBe(false);
    const paged = scaffoldGezappSource('field-notes', { withPage: true });
    expect(paged.some(([rel]) => rel.includes('/pages/dashboard/index.html'))).toBe(true);
  });
});

describe('gezel app schemas', () => {
  it('writes parseable schema files including both gezapp manifests', async () => {
    const out = join(dir, 'schemas');
    await runAppSchemas({ out });
    const names = await readdir(out);
    expect(names).toContain('gezapp-manifest.schema.json');
    expect(names).toContain('gezapp-source-manifest.schema.json');
    expect(names).toContain('project-type-version.schema.json');
    for (const name of names) {
      JSON.parse(await readFile(join(out, name), 'utf8'));
    }
  });

  it('prints one combined object with --json', async () => {
    await runAppSchemas({ json: true });
    const combined = JSON.parse(output()) as Record<string, { $id?: string }>;
    expect(combined['gezapp-source-manifest.schema.json']?.$id).toContain('gezapp-source-manifest');
  });
});
