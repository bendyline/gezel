import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ProjectArtifactsStore } from './project-artifacts-store.js';

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
