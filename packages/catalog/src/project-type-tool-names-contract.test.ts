/**
 * Contract test: no bundled project type names a tool with a spelling the
 * built-in tool surface reserves. gezel-mcp skips such a tool with only a log
 * line, so the app quietly loses an action its prompts and pages rely on
 * (Client Delivery's `list_projects` vanished this way before it shipped).
 * Runs over every published version, since a project keeps the version it was
 * created from.
 */
import { ProjectTypeManifestSchema } from '@bendyline/gezel';
import { RESERVED_TOOL_NAMES, normalizeToolNameSpelling } from '@bendyline/gezel/local-loop';
import { describe, expect, it } from 'vitest';
import { gildeDataDir } from './gilde-data.js';
import { BundledSource } from './source.js';

describe('project type tool names', () => {
  it('never claim a spelling the built-in tools reserve', async () => {
    const reserved = new Set(RESERVED_TOOL_NAMES.map(normalizeToolNameSpelling));
    const source = new BundledSource({ dataDir: gildeDataDir() });
    const collisions: string[] = [];
    let checked = 0;
    for (const item of await source.list('project-type')) {
      const versions = item.manifest.availableVersions ?? [item.manifest.version];
      for (const version of versions) {
        const detail = await source.get('project-type', item.manifest.id, version);
        const parsed = ProjectTypeManifestSchema.safeParse(detail?.manifest);
        if (!parsed.success) continue;
        checked += 1;
        for (const tool of parsed.data.tools)
          if (reserved.has(normalizeToolNameSpelling(tool.name)))
            collisions.push(`${item.manifest.id}@${version}: ${tool.name}`);
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(collisions).toEqual([]);
  });
});
