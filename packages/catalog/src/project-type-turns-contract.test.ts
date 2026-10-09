/**
 * Contract test: every bundled project type's turn declarations (a tool's
 * `turn` and `state`, a reaction's `turn`) name tools the model actually
 * calls. A reaction naming a missing or page-only tool would never be
 * required, and the runtime would say nothing: the move just stops being
 * forced. Runs over every published version, since a project keeps the
 * version it was created from.
 */
import { ProjectTypeManifestSchema, projectTypeTurnProblems } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import { gildeDataDir } from './gilde-data.js';
import { BundledSource } from './source.js';

describe('project type turn declarations', () => {
  it('name tools the model calls', async () => {
    const source = new BundledSource({ dataDir: gildeDataDir() });
    const problems: string[] = [];
    let checked = 0;
    for (const item of await source.list('project-type')) {
      const versions = item.manifest.availableVersions ?? [item.manifest.version];
      for (const version of versions) {
        const detail = await source.get('project-type', item.manifest.id, version);
        const parsed = ProjectTypeManifestSchema.safeParse(detail?.manifest);
        if (!parsed.success) continue;
        checked += 1;
        for (const problem of projectTypeTurnProblems(parsed.data))
          problems.push(`${item.manifest.id}@${version}: ${problem}`);
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });
});
