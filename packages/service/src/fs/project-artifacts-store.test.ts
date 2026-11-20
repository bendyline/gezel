import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpStatusError } from '@bendyline/gezel/runtime';
import { describe, expect, it } from 'vitest';
import {
  ArtifactPathDeniedError,
  ArtifactRootDeniedError,
  ArtifactShortNamePathDeniedError,
  DiffpackPathWriteDeniedError,
  ProjectArtifactsStore,
} from './project-artifacts-store.js';

describe('ProjectArtifactsStore recursive listings', () => {
  it('enumerates connector corpora larger than the generic 500-entry walk cap', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gezel-artifact-walk-test-'));
    try {
      const filesDir = join(home, 'projects', 'large', 'artifacts', 'data', 'pr-1', 'files');
      await mkdir(filesDir, { recursive: true });
      await Promise.all(
        Array.from({ length: 509 }, (_, index) =>
          writeFile(join(filesDir, `${String(index + 1).padStart(3, '0')}--record.md`), 'record'),
        ),
      );

      const artifacts = new ProjectArtifactsStore({
        home,
        touchProject: async () => {},
      });
      const result = await artifacts.listProjectArtifactsRecursiveDetailed('large');

      expect(result.truncated).toBe(false);
      expect(result.entries.filter((entry) => !entry.isDirectory)).toHaveLength(509);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('ProjectArtifactsStore drawer root', () => {
  it('refuses to delete or rename the drawer itself, however the path spells it', async () => {
    // `DELETE …/artifacts/delete?path=.` removed the whole drawer on the RC
    // daemon: task inputs, prompt drafts, proposals.
    const home = await mkdtemp(join(tmpdir(), 'gezel-artifact-root-test-'));
    try {
      const artifacts = new ProjectArtifactsStore({ home, touchProject: async () => {} });
      await artifacts.writeProjectArtifact('p', 'notes/a.md', 'kept');
      await artifacts.writeProjectArtifact('p', 'tasks/1/inputs/brief/x.md', 'input');
      for (const path of [
        '.',
        './',
        'notes/..',
        './notes/../',
        '...',
        'notes/./..',
        'artifacts',
        'Artifacts/',
      ]) {
        for (const initiatedByGezel of [false, true]) {
          await expect(
            artifacts.deleteProjectArtifact('p', path, { initiatedByGezel }),
            `${path} (${initiatedByGezel ? 'gezel' : 'user'})`,
          ).rejects.toBeInstanceOf(ArtifactRootDeniedError);
        }
      }
      await expect(
        artifacts.renameProjectArtifactPath('p', 'notes/..', 'archive'),
      ).rejects.toBeInstanceOf(ArtifactRootDeniedError);
      await expect(
        artifacts.renameProjectArtifactPath('p', 'notes/a.md', '.'),
      ).rejects.toBeInstanceOf(ArtifactRootDeniedError);
      expect(await artifacts.readProjectArtifact('p', 'notes/a.md')).toBe('kept');
      expect(await artifacts.readProjectArtifact('p', 'tasks/1/inputs/brief/x.md')).toBe('input');

      // Ordinary deletes are unaffected.
      await artifacts.deleteProjectArtifact('p', 'notes/a.md');
      expect(await artifacts.readProjectArtifact('p', 'notes/a.md')).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('ProjectArtifactsStore drawer-prefixed paths', () => {
  // A 2B model on the iPhone listed `artifacts` and was told the drawer it had
  // just saved into was empty.
  it('reads a bare `artifacts` as the drawer itself', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gezel-artifact-prefix-test-'));
    try {
      const artifacts = new ProjectArtifactsStore({ home, touchProject: async () => {} });
      await artifacts.writeProjectArtifact('p', 'tasks/1/handover.md', 'Noor opens at 09:30.');
      const paths = async (subpath: string) =>
        (await artifacts.listProjectArtifactsRecursive('p', { subpath }))
          .filter((entry) => !entry.isDirectory)
          .map((entry) => entry.path);
      expect(await paths('artifacts')).toEqual(['tasks/1/handover.md']);
      expect(await paths('artifacts/tasks')).toEqual(['tasks/1/handover.md']);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('ProjectArtifactsStore unresolved-template paths', () => {
  it('refuses a write whose path is a literal {{token}}, on every sink', async () => {
    // The drawer is runtime output space: a `{{…}}` segment here is always an
    // unsubstituted launch parameter, never a filename anyone meant.
    const home = await mkdtemp(join(tmpdir(), 'gezel-artifact-template-test-'));
    try {
      const artifacts = new ProjectArtifactsStore({
        home,
        touchProject: async () => {},
      });
      const bad = '{{task.dir}}/security/review-scope.md';
      await expect(artifacts.writeProjectArtifact('p', bad, 'x')).rejects.toThrow(
        /unresolved template placeholder/,
      );
      await expect(
        artifacts.writeProjectArtifactBinary('p', bad, Buffer.from('x')),
      ).rejects.toThrow(/unresolved template placeholder/);
      await expect(artifacts.createProjectArtifactFolder('p', '{{task.dir}}')).rejects.toThrow(
        /unresolved template placeholder/,
      );

      await artifacts.writeProjectArtifact('p', 'tasks/7/scope.md', 'real');
      await expect(
        artifacts.renameProjectArtifactPath('p', 'tasks/7/scope.md', bad),
      ).rejects.toThrow(/unresolved template placeholder/);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('still writes the resolved path', async () => {
    const home = await mkdtemp(join(tmpdir(), 'gezel-artifact-template-ok-test-'));
    try {
      const artifacts = new ProjectArtifactsStore({
        home,
        touchProject: async () => {},
      });
      await artifacts.writeProjectArtifact('p', 'tasks/7/security/review-scope.md', 'real');
      const read = await artifacts.readProjectArtifact('p', 'tasks/7/security/review-scope.md');
      expect(read).toContain('real');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe('the reserved tabular subtree', () => {
  async function harness() {
    const home = await mkdtemp(join(tmpdir(), 'gezel-tabular-store-'));
    const artifacts = new ProjectArtifactsStore({ home, touchProject: async () => {} });
    const root = join(home, 'projects', 'p1', 'artifacts');
    await mkdir(join(root, 'tabular', 'data', 'sales.csv_tables', 'tables', 'sales'), {
      recursive: true,
    });
    await writeFile(
      join(root, 'tabular', 'data', 'sales.csv_tables', 'tables', 'sales', 'manifest.json'),
      '{}',
    );
    await mkdir(join(root, 'reports'), { recursive: true });
    await writeFile(join(root, 'reports', 'q3.md'), '# Q3');
    return { home, artifacts };
  }

  it('refuses every write, not only gezel-initiated ones', async () => {
    const { home, artifacts } = await harness();
    try {
      // Unlike a connector corpus — which the user may arguably edit — a table
      // here is derived output. A hand edit would be overwritten on the source
      // file's next change, so accepting the write would be a lie.
      await expect(
        artifacts.writeProjectArtifact('p1', 'tabular/data/sales.csv_tables/x.md', 'hi'),
      ).rejects.toMatchObject({ code: 'tabular-readonly' });
      await expect(
        artifacts.writeProjectArtifact('p1', 'tabular/x.md', 'hi', { initiatedByGezel: true }),
      ).rejects.toMatchObject({ code: 'tabular-readonly' });
      await expect(
        artifacts.createProjectArtifactFolder('p1', 'tabular/new'),
      ).rejects.toMatchObject({ code: 'tabular-readonly' });
      await expect(
        artifacts.renameProjectArtifactPath('p1', 'reports/q3.md', 'tabular/q3.md'),
      ).rejects.toMatchObject({ code: 'tabular-readonly' });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('normalizes traversal before deciding, so the guard cannot be walked around', async () => {
    const { home, artifacts } = await harness();
    try {
      await expect(
        artifacts.writeProjectArtifact('p1', 'reports/../tabular/sneak.md', 'hi'),
      ).rejects.toMatchObject({ code: 'tabular-readonly' });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('stays out of default listings but is reachable when asked for', async () => {
    const { home, artifacts } = await harness();
    try {
      const listed = await artifacts.listProjectArtifacts('p1');
      expect(listed.map((e) => e.name)).not.toContain('tabular');
      expect(listed.map((e) => e.name)).toContain('reports');

      const hidden = await artifacts.listProjectArtifacts('p1', '', { includeHidden: true });
      expect(hidden.map((e) => e.name)).toContain('tabular');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('never lets a Parquet part hijack a bare-filename lookup', async () => {
    const { home, artifacts } = await harness();
    try {
      const recursive = await artifacts.listProjectArtifactsRecursiveDetailed('p1');
      expect(recursive.entries.some((e) => e.path.startsWith('tabular/'))).toBe(false);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

// `DIFFPA~1/12/files/01.diff` rewrote a sealed proposal on a volume that keeps
// 8.3 short names, and the rename route had no diffpack or corpus rule at all.
describe('reserved paths, however they are reached', () => {
  const gezel = { initiatedByGezel: true };

  async function drawer() {
    const home = await mkdtemp(join(tmpdir(), 'gezel-artifact-reserved-test-'));
    const artifacts = new ProjectArtifactsStore({ home, touchProject: async () => {} });
    const root = artifacts.projectArtifactsDir('p');
    await mkdir(join(root, 'diffpacks', '12', 'files'), { recursive: true });
    await writeFile(join(root, 'diffpacks', '12', 'files', '01.diff'), 'sealed');
    await mkdir(join(root, 'data', 'mail'), { recursive: true });
    await writeFile(join(root, 'data', 'mail', '_meta.json'), '{}');
    await artifacts.writeProjectArtifact('p', 'scratch/forged/01.diff', 'forged');
    return { home, root, artifacts };
  }

  it("refuses a gezel's rename into or out of a proposal or a connector mirror", async () => {
    const { home, root, artifacts } = await drawer();
    try {
      for (const [from, to] of [
        ['scratch/forged', 'diffpacks/12/files'],
        ['scratch/forged', 'diffpacks/13'],
        ['diffpacks/12/files', 'scratch/old'],
        ['diffpacks/12', 'scratch/pack'],
        ['scratch/forged/01.diff', 'diffpacks/12/deletions.json'],
        ['data/mail/_meta.json', 'scratch/meta.json'],
        ['scratch/forged/01.diff', 'data/mail/inbox/record.md'],
      ] as const) {
        await expect(
          artifacts.renameProjectArtifactPath('p', from, to, gezel),
          `${from} → ${to}`,
        ).rejects.toBeInstanceOf(ArtifactPathDeniedError);
      }
      expect(await readFile(join(root, 'diffpacks', '12', 'files', '01.diff'), 'utf8')).toBe(
        'sealed',
      );
      // Ordinary renames still work.
      await artifacts.renameProjectArtifactPath('p', 'scratch/forged', 'scratch/kept', gezel);
      expect(await artifacts.readProjectArtifact('p', 'scratch/kept/01.diff')).toBe('forged');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refuses a gezel's delete of a proposal's files, and lets the person remove a proposal", async () => {
    const { home, artifacts } = await drawer();
    try {
      for (const path of ['diffpacks/12/files/01.diff', 'diffpacks/12', 'diffpacks']) {
        await expect(
          artifacts.deleteProjectArtifact('p', path, gezel),
          path,
        ).rejects.toBeInstanceOf(DiffpackPathWriteDeniedError);
      }
      await artifacts.deleteProjectArtifact('p', 'diffpacks/12');
      expect(await artifacts.readProjectArtifact('p', 'diffpacks/12/files/01.diff')).toBeNull();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refuses writes to a pack's deletions, operations and manifest, but not its notes", async () => {
    const { home, artifacts } = await drawer();
    try {
      for (const name of ['deletions.json', 'operations.json', 'manifest.json']) {
        await expect(
          artifacts.writeProjectArtifact('p', `diffpacks/12/${name}`, '[]', gezel),
          name,
        ).rejects.toBeInstanceOf(DiffpackPathWriteDeniedError);
      }
      await artifacts.writeProjectArtifact('p', 'diffpacks/12/notes.md', '# Fix', gezel);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('answers 403 with the reason, so an unlisted refusal is not an internal error', async () => {
    const { home, artifacts } = await drawer();
    try {
      const err = await artifacts
        .writeProjectArtifact('p', 'diffpacks/12/files/02.diff', 'x', gezel)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(HttpStatusError);
      expect(err).toMatchObject({ status: 403, body: { code: 'diffpack-readonly' } });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("refuses a gezel's short-name-shaped segment on every platform", async () => {
    const { home, artifacts } = await drawer();
    try {
      for (const path of [
        'DIFFPA~1/12/files/01.diff',
        'data/mail/_META~1.JSO',
        'notes/REPOR~12.MD',
      ]) {
        await expect(
          artifacts.writeProjectArtifact('p', path, 'x', gezel),
          path,
        ).rejects.toBeInstanceOf(ArtifactShortNamePathDeniedError);
      }
      // A tilde that is not a short name is an ordinary name.
      await artifacts.writeProjectArtifact('p', 'notes/draft~old-version.md', 'x', gezel);
      await artifacts.writeProjectArtifact('p', 'notes/~1.md.bak', 'x', gezel);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('judges a link inside the drawer by where it lands', async () => {
    const { home, root, artifacts } = await drawer();
    try {
      // A junction needs no privilege on Windows; elsewhere it is a symlink.
      await symlink(join(root, 'diffpacks', '12', 'files'), join(root, 'shortcut'), 'junction');
      for (const initiatedByGezel of [false, true]) {
        await expect(
          artifacts.writeProjectArtifact('p', 'shortcut/01.diff', 'forged', { initiatedByGezel }),
        ).rejects.toBeInstanceOf(DiffpackPathWriteDeniedError);
      }
      expect(await readFile(join(root, 'diffpacks', '12', 'files', '01.diff'), 'utf8')).toBe(
        'sealed',
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('judges a Windows short name by the long name it opens', async () => {
    const { home, root, artifacts } = await drawer();
    try {
      // Only on a volume that generates 8.3 names (the system drive does by
      // default); elsewhere `DIFFPA~1` is just a new folder.
      if (!existsSync(join(root, 'DIFFPA~1'))) return;
      await expect(
        artifacts.writeProjectArtifact('p', 'DIFFPA~1/12/files/01.diff', 'forged'),
      ).rejects.toBeInstanceOf(DiffpackPathWriteDeniedError);
      await expect(
        artifacts.renameProjectArtifactPath('p', 'scratch/forged', 'DIFFPA~1/13'),
      ).rejects.toBeInstanceOf(DiffpackPathWriteDeniedError);
      expect(await readFile(join(root, 'diffpacks', '12', 'files', '01.diff'), 'utf8')).toBe(
        'sealed',
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
