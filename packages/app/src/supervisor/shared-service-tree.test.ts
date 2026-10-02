import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegQuery } from './machine-service-state.js';
import { type WriteProbe, resolveSharedServiceTree } from './shared-service-tree.js';

const SHIPPED_SHA = createHash('sha256').update('shipped bundle').digest('hex');
const OTHER_SHA = createHash('sha256').update('some other bundle').digest('hex');

/** Mode checks are the whole basis for trusting the tree, and Windows has none. */
const posixOnly = process.platform === 'win32' ? it.skip : it;

describe('resolveSharedServiceTree', () => {
  let root: string;
  let serviceHome: string;
  let treeDir: string;
  let metaPath: string;

  async function seedMeta(sha = SHIPPED_SHA): Promise<void> {
    await writeFile(
      metaPath,
      JSON.stringify({ version: '1.2.3', sha256: sha, sizeBytes: 10, fileCount: 2 }),
    );
  }

  async function seedTree(sha: string | null): Promise<void> {
    // Explicit modes: the adoption checks refuse group-writable entries, and a
    // umask-002 shell (Ubuntu's default) would otherwise seed 664/775 fixtures.
    await mkdir(join(treeDir, 'dist', 'bin'), { recursive: true, mode: 0o755 });
    await mkdir(join(treeDir, 'node_modules'), { recursive: true, mode: 0o755 });
    await writeFile(join(treeDir, 'package.json'), '{"version":"1.2.3"}\n', { mode: 0o644 });
    await writeFile(join(treeDir, 'dist', 'bin', 'gezeld.js'), '#!/usr/bin/env node\n', {
      mode: 0o644,
    });
    if (sha) await writeFile(join(treeDir, '.gezel-bundle.sha256'), `${sha}\n`, { mode: 0o644 });
    // What the installer hooks leave behind: readable, not writable by anyone
    // but the installer that owns it.
    await chmod(serviceHome, 0o711);
    await chmod(treeDir, 0o755);
  }

  /**
   * The fixture is necessarily owned by the account running Vitest. Model the
   * production relationship instead: that account stands in for the installer
   * (root), and the desktop user asking is a different account.
   */
  async function resolveAsDesktop(
    overrides: Partial<Parameters<typeof resolveSharedServiceTree>[0]> = {},
  ): Promise<{ adopted: string | null; warnings: string[] }> {
    const fixtureOwnerUid = process.getuid?.();
    if (fixtureOwnerUid === undefined) throw new Error('POSIX test requires process.getuid');
    const desktopUid = fixtureOwnerUid === 1 ? 2 : 1;
    const getuid = vi.spyOn(process, 'getuid').mockReturnValue(desktopUid);
    const warnings: string[] = [];
    try {
      const adopted = await resolveSharedServiceTree({
        metaPath,
        serviceHome,
        platform: 'linux',
        publisherUid: fixtureOwnerUid,
        logger: { warn: (m) => warnings.push(m) },
        ...overrides,
      });
      return { adopted, warnings };
    } finally {
      getuid.mockRestore();
    }
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'gezel-shared-tree-'));
    serviceHome = join(root, 'system-home');
    treeDir = join(serviceHome, 'service');
    metaPath = join(root, 'service-bundle.meta.json');
    await mkdir(serviceHome, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  posixOnly('adopts an installer-owned tree carrying the shipped bundle sha', async () => {
    await seedMeta();
    await seedTree(SHIPPED_SHA);

    expect(await resolveAsDesktop()).toEqual({ adopted: treeDir, warnings: [] });
  });

  posixOnly('declines a tree owned by any account other than the installer', async () => {
    // The service account owned the published tree before, and it parses
    // untrusted model files: a tree it owns is one it could rewrite under every
    // account's daemon. Only root's publication is adoptable.
    await seedMeta();
    await seedTree(SHIPPED_SHA);

    const serviceAccountUid = process.getuid?.() ?? 0;
    const { adopted, warnings } = await resolveAsDesktop({ publisherUid: serviceAccountUid + 1 });

    expect(adopted).toBeNull();
    expect(warnings.join('\n')).toMatch(
      new RegExp(`belongs to uid ${serviceAccountUid}, not the installer`),
    );
  });

  posixOnly('declines when a directory holding the entry point is writable by others', async () => {
    // Owning `dist` is what stops anyone renaming `dist/bin` out from under the
    // entry point, so it is checked, not just the entry point itself.
    await seedMeta();
    await seedTree(SHIPPED_SHA);
    await chmod(join(treeDir, 'dist'), 0o777);

    const { adopted, warnings } = await resolveAsDesktop();

    expect(adopted).toBeNull();
    expect(warnings.join('\n')).toMatch(/dist is group- or world-writable/);
  });

  posixOnly('declines when a checked entry inside the tree is a symlink', async () => {
    await seedMeta();
    await seedTree(SHIPPED_SHA);
    const elsewhere = join(root, 'elsewhere-modules');
    await mkdir(elsewhere);
    await rm(join(treeDir, 'node_modules'), { recursive: true });
    await symlink(elsewhere, join(treeDir, 'node_modules'));

    const { adopted, warnings } = await resolveAsDesktop();

    expect(adopted).toBeNull();
    expect(warnings.join('\n')).toMatch(/node_modules is a symlink/);
  });

  posixOnly('declines a tree built from a different bundle', async () => {
    // The app-only-update case: electron-updater replaced the shell but cannot
    // rewrite the root-owned tree, so the machine copy is a release behind.
    // Adopting it would silently run last release's daemon code.
    await seedMeta();
    await seedTree(OTHER_SHA);

    expect(await resolveSharedServiceTree({ metaPath, serviceHome, platform: 'linux' })).toBeNull();
  });

  posixOnly('declines a tree with no sentinel at all', async () => {
    await seedMeta();
    await seedTree(null);

    expect(await resolveSharedServiceTree({ metaPath, serviceHome, platform: 'linux' })).toBeNull();
  });

  posixOnly('declines when the daemon entry point is missing', async () => {
    await seedMeta();
    await seedTree(SHIPPED_SHA);
    await rm(join(treeDir, 'dist', 'bin', 'gezeld.js'));

    expect(await resolveSharedServiceTree({ metaPath, serviceHome, platform: 'linux' })).toBeNull();
  });

  posixOnly('declines a world-writable tree even when the sha matches', async () => {
    // A tree this account could rewrite carries no more trust than a local
    // extraction, and the sentinel proves nothing when whoever planted the
    // bytes could plant the sentinel too.
    await seedMeta();
    await seedTree(SHIPPED_SHA);
    await chmod(treeDir, 0o777);

    const { adopted, warnings } = await resolveAsDesktop();

    expect(adopted).toBeNull();
    expect(warnings.join('\n')).toMatch(/service is group- or world-writable/);
  });

  posixOnly('declines when the tree parent is world-writable', async () => {
    // Write access to the parent is rename access to the tree.
    await seedMeta();
    await seedTree(SHIPPED_SHA);
    await chmod(serviceHome, 0o777);

    const { adopted, warnings } = await resolveAsDesktop();

    expect(adopted).toBeNull();
    expect(warnings.join('\n')).toMatch(/system-home is group- or world-writable/);
  });

  posixOnly('declines when there is no machine service home', async () => {
    await seedMeta();
    await seedTree(SHIPPED_SHA);

    expect(
      await resolveSharedServiceTree({ metaPath, serviceHome: null, platform: 'linux' }),
    ).toBeNull();
  });

  posixOnly('declines when the shipped meta is unreadable', async () => {
    await seedTree(SHIPPED_SHA);

    expect(await resolveSharedServiceTree({ metaPath, serviceHome, platform: 'linux' })).toBeNull();
  });

  describe('on Windows', () => {
    // The mode/uid evidence the POSIX branch reads does not exist here, and
    // the DACL that carries the real answer is not readable by the account
    // asking. These exercise the substitute: an elevated attestation in HKLM
    // plus an empirical write probe. Both seams are injected, so the suite
    // runs on every platform and needs no real registry or ACL.
    const REG_KEY = 'HKLM\\Software\\Bendyline\\Gezel';
    const REG_VALUE = 'SharedServiceTreeSha';

    /** `reg query` output shape, padding and CRLF included. */
    function published(sha: string | null): RegQuery {
      return async () => {
        if (sha === null) throw new Error('ERROR: The system was unable to find the value.');
        return `\r\n${REG_KEY}\r\n    ${REG_VALUE}    REG_SZ    ${sha}\r\n\r\n`;
      };
    }

    const denied: WriteProbe = async () => 'denied';
    /** Every path denied except `target`, which reports `verdict`. */
    function probeExcept(target: () => string, verdict: 'writable' | 'unknown'): WriteProbe {
      return async (path) => (path === target() ? verdict : 'denied');
    }

    async function seedWindowsTree(sha: string = SHIPPED_SHA): Promise<void> {
      await mkdir(join(treeDir, 'dist', 'bin'), { recursive: true, mode: 0o755 });
      await writeFile(join(treeDir, 'dist', 'bin', 'gezeld.js'), '#!/usr/bin/env node\n', {
        mode: 0o644,
      });
      await writeFile(join(treeDir, '.gezel-bundle.sha256'), `${sha}\n`, { mode: 0o644 });
    }

    function resolve(overrides: Partial<Parameters<typeof resolveSharedServiceTree>[0]> = {}) {
      return resolveSharedServiceTree({
        metaPath,
        serviceHome,
        platform: 'win32',
        regQuery: published(SHIPPED_SHA),
        writeProbe: denied,
        ...overrides,
      });
    }

    it('adopts a published tree the installer attested and we cannot write', async () => {
      await seedMeta();
      await seedWindowsTree();

      expect(await resolve()).toBe(treeDir);
    });

    it('declines when no elevated installer published the tree', async () => {
      // The ordinary state on any machine whose installer predates publishing:
      // reg.exe exits non-zero and execFile surfaces that as a rejection.
      await seedMeta();
      await seedWindowsTree();

      expect(await resolve({ regQuery: published(null) })).toBeNull();
    });

    it('declines when the attestation names a different bundle', async () => {
      // An app-only update: the shell moved on, the root-owned tree did not.
      await seedMeta();
      await seedWindowsTree();

      expect(await resolve({ regQuery: published(OTHER_SHA) })).toBeNull();
    });

    it('declines when the tree itself accepts writes from this account', async () => {
      await seedMeta();
      await seedWindowsTree();

      expect(await resolve({ writeProbe: probeExcept(() => treeDir, 'writable') })).toBeNull();
    });

    it('declines when the tree parent accepts writes', async () => {
      // Write access to the parent is rename access to the tree.
      await seedMeta();
      await seedWindowsTree();

      expect(await resolve({ writeProbe: probeExcept(() => serviceHome, 'writable') })).toBeNull();
    });

    it('declines when the daemon entry point accepts writes', async () => {
      await seedMeta();
      await seedWindowsTree();
      const entry = () => join(treeDir, 'dist', 'bin', 'gezeld.js');

      expect(await resolve({ writeProbe: probeExcept(entry, 'writable') })).toBeNull();
    });

    it('declines when a probe is inconclusive rather than denied', async () => {
      // `unknown` must not read as `safe`: a probe that failed for a reason
      // other than permissions has told us nothing.
      await seedMeta();
      await seedWindowsTree();

      expect(await resolve({ writeProbe: probeExcept(() => treeDir, 'unknown') })).toBeNull();
    });

    it('still requires the in-tree sentinel to match the shipped bundle', async () => {
      // The registry attests what the installer published; the sentinel
      // attests what is on disk now. A green attestation must not excuse a
      // tree whose contents disagree with it.
      await seedMeta();
      await seedWindowsTree(OTHER_SHA);

      expect(await resolve()).toBeNull();
    });
  });
});
