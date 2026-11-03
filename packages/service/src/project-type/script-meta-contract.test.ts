import { BundledSource } from '@bendyline/gezel-catalog';
import { describe, expect, it } from 'vitest';
import { bundledGildeDataDir } from '../gilde-updates/bundled-gilde.js';
import { parseScriptMeta } from '../scripts/meta.js';

/**
 * Contract test: every inline script a bundled project type ships has meta
 * the daemon accepts. Gilde's own validation does not parse script meta, and
 * a rejected meta fails every tool call on that script with a 422: Event
 * Desk's array output declared `items` instead of `itemType`, and every page
 * action broke (2026-11-02). Runs over every published version, since a
 * project keeps the version it was created from.
 */
describe('project type scripts', () => {
  it('declare meta the script runtime accepts', async () => {
    const source = new BundledSource({ dataDir: bundledGildeDataDir() });
    const problems: string[] = [];
    let checked = 0;
    for (const item of await source.list('project-type')) {
      const versions = item.manifest.availableVersions ?? [item.manifest.version];
      for (const version of versions) {
        const detail = await source.get('project-type', item.manifest.id, version);
        const scripts = (detail?.manifest as { scripts?: Record<string, unknown> } | undefined)
          ?.scripts;
        for (const [name, script] of Object.entries(scripts ?? {})) {
          if (typeof script !== 'string') continue;
          checked += 1;
          try {
            parseScriptMeta(script, `${name}.ts`);
          } catch (err) {
            problems.push(
              `${item.manifest.id}@${version} ${name}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });
});
