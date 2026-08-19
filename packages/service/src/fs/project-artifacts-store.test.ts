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
