import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { retainNewestVersions } from './retention.js';

describe('retainNewestVersions', () => {
  let root: string;

  interface SeedOptions {
    versions: string[];
    yankedVersions?: string[];
    minSupportedVersion?: string;
    /** Omit the identity manifest entirely. */
    noIdentity?: boolean;
    /** Write an identity manifest that isn't valid JSON. */
    brokenIdentity?: boolean;
  }

  async function seed(slug: string, opts: SeedOptions): Promise<string> {
    const dir = join(root, 'toolsets', slug.slice(0, 2), slug);
    for (const v of opts.versions) {
      await mkdir(join(dir, 'versions', v), { recursive: true });
      await writeFile(join(dir, 'versions', v, 'manifest.json'), JSON.stringify({ version: v }));
    }
    await mkdir(dir, { recursive: true });
    if (opts.brokenIdentity) {
      await writeFile(join(dir, 'manifest.json'), '{ not json', 'utf8');
    } else if (!opts.noIdentity) {
      await writeFile(
        join(dir, 'manifest.json'),
        JSON.stringify({
          id: slug,
          ...(opts.yankedVersions ? { yankedVersions: opts.yankedVersions } : {}),
          ...(opts.minSupportedVersion ? { minSupportedVersion: opts.minSupportedVersion } : {}),
        }),
        'utf8',
      );
    }
    return dir;
  }

  const map = (slug: string) => ({ [`io.github.who/${slug}`]: slug });

  async function versionsOf(dir: string): Promise<string[]> {
    return (await readdir(join(dir, 'versions'))).sort();
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gezel-retention-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('keeps the newest N and drops the rest', async () => {
    const dir = await seed('chatty-mcp', {
      versions: ['0.9.0', '0.10.0', '0.11.0', '0.11.1', '1.0.0'],
    });
    const out = await retainNewestVersions({ root, keep: 2, slugMap: map('chatty-mcp') });

    expect(await versionsOf(dir)).toEqual(['0.11.1', '1.0.0']);
    expect(out.removed.map((r) => r.version).sort()).toEqual(['0.10.0', '0.11.0', '0.9.0']);
    expect(out.versionsBefore).toBe(5);
  });

  // Folder names sort as text, not numbers: "0.9.0" > "0.11.0" lexically.
  // Retention has to order the way the loaders do or it deletes the
  // version build-index is about to pick.
  it('orders by semver, not lexically', async () => {
    const dir = await seed('semver-mcp', { versions: ['0.9.0', '0.10.0', '0.11.10', '0.11.2'] });
    await retainNewestVersions({ root, keep: 1, slugMap: map('semver-mcp') });

    expect(await versionsOf(dir)).toEqual(['0.11.10']);
  });

  it('keeps N eligible versions, skipping past yanked ones', async () => {
    const dir = await seed('yanked-mcp', {
      versions: ['1.0.0', '1.1.0', '1.2.0'],
      yankedVersions: ['1.2.0'],
    });
    await retainNewestVersions({ root, keep: 2, slugMap: map('yanked-mcp') });

    // 1.2.0 is yanked so it is not eligible and not retained; the two
    // newest *eligible* survive.
    expect(await versionsOf(dir)).toEqual(['1.0.0', '1.1.0']);
  });

  it('never drops below minSupportedVersion into the keep set', async () => {
    const dir = await seed('minsup-mcp', {
      versions: ['0.1.0', '0.2.0', '1.0.0'],
      minSupportedVersion: '1.0.0',
    });
    await retainNewestVersions({ root, keep: 3, slugMap: map('minsup-mcp') });

    expect(await versionsOf(dir)).toEqual(['1.0.0']);
  });

  // Every folder yanked is a deliberate tombstone. The loaders report
  // that as `tombstoned`; emptying versions/ would turn it into
  // `no-eligible-versions` and lose the distinction.
  it('leaves a fully-tombstoned toolset completely alone', async () => {
    const dir = await seed('dead-mcp', {
      versions: ['1.0.0', '1.1.0'],
      yankedVersions: ['1.0.0', '1.1.0'],
    });
    const out = await retainNewestVersions({ root, keep: 1, slugMap: map('dead-mcp') });

    expect(await versionsOf(dir)).toEqual(['1.0.0', '1.1.0']);
    expect(out.skipped).toEqual([{ slug: 'dead-mcp', reason: 'no-eligible-versions' }]);
  });

  it('skips a toolset whose identity manifest is missing or unreadable', async () => {
    const gone = await seed('noident-mcp', { versions: ['1.0.0', '2.0.0'], noIdentity: true });
    const broken = await seed('broken-mcp', { versions: ['1.0.0', '2.0.0'], brokenIdentity: true });
    const out = await retainNewestVersions({
      root,
      keep: 1,
      slugMap: { ...map('noident-mcp'), ...map('broken-mcp') },
    });

    expect(await versionsOf(gone)).toEqual(['1.0.0', '2.0.0']);
    expect(await versionsOf(broken)).toEqual(['1.0.0', '2.0.0']);
    expect(out.skipped.map((s) => s.reason)).toEqual([
      'unreadable-identity',
      'unreadable-identity',
    ]);
    expect(out.removed).toEqual([]);
  });

  it('never touches a directory with no slug-map record', async () => {
    const dir = await seed('handmade-mcp', { versions: ['1.0.0', '2.0.0', '3.0.0'] });
    const out = await retainNewestVersions({ root, keep: 1, slugMap: {} });

    expect(out.unmapped).toEqual(['handmade-mcp']);
    expect(await versionsOf(dir)).toEqual(['1.0.0', '2.0.0', '3.0.0']);
  });

  // The loaders ignore non-semver folder names, so they cost nothing —
  // and we can't order what we can't parse.
  it('leaves non-semver folders in place', async () => {
    const dir = await seed('odd-mcp', { versions: ['1.0.0', '2.0.0'] });
    await mkdir(join(dir, 'versions', 'nightly'), { recursive: true });
    await retainNewestVersions({ root, keep: 1, slugMap: map('odd-mcp') });

    expect(await versionsOf(dir)).toEqual(['2.0.0', 'nightly']);
  });

  it('is a no-op when a toolset already holds at most N versions', async () => {
    await seed('lean-mcp', { versions: ['1.0.0'] });
    const out = await retainNewestVersions({ root, keep: 3, slugMap: map('lean-mcp') });

    expect(out.candidates).toEqual([]);
    expect(out.toolsetsScanned).toBe(1);
  });

  it('dryRun reports candidates without touching disk', async () => {
    const dir = await seed('chatty-mcp', { versions: ['1.0.0', '2.0.0', '3.0.0'] });
    const out = await retainNewestVersions({
      root,
      keep: 1,
      slugMap: map('chatty-mcp'),
      dryRun: true,
    });

    expect(out.candidates).toHaveLength(2);
    expect(out.removed).toEqual([]);
    expect(await versionsOf(dir)).toEqual(['1.0.0', '2.0.0', '3.0.0']);
  });

  it('refuses a keep count below 1', async () => {
    await expect(retainNewestVersions({ root, keep: 0, slugMap: {} })).rejects.toThrow(/>= 1/);
  });
});
