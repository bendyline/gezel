import type { CraftbookToolsetNeed } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { describe, expect, it, vi } from 'vitest';
import { autoAllowedToolsForToolsets, buildAutoAllowHook } from './auto-allow.js';

/** Minimal fake catalog: maps toolset id → tool names. */
function fakeCatalog(byId: Record<string, string[]>): CatalogService {
  return {
    get: vi.fn(async (kind: string, id: string) => {
      if (kind !== 'toolset' || !(id in byId)) return null;
      return {
        manifest: {
          kind: 'toolset',
          id,
          tools: byId[id]!.map((name) => ({ name, description: '' })),
        },
      };
    }),
  } as unknown as CatalogService;
}

describe('autoAllowedToolsForToolsets', () => {
  it('returns empty for no toolsets', async () => {
    const set = await autoAllowedToolsForToolsets(fakeCatalog({}), undefined);
    expect(set.size).toBe(0);
  });

  it('unions tool names only from autoAllow toolsets', async () => {
    const catalog = fakeCatalog({
      'usb-camera': ['camera_snapshot', 'camera_list'],
      github: ['get_pull_request'],
    });
    const needs: CraftbookToolsetNeed[] = [
      { toolsetId: 'usb-camera', autoAllow: true },
      { toolsetId: 'github' }, // no autoAllow → excluded
    ];
    const set = await autoAllowedToolsForToolsets(catalog, needs);
    expect([...set].sort()).toEqual(['camera_list', 'camera_snapshot']);
  });

  it('ignores toolsets missing from the catalog', async () => {
    const set = await autoAllowedToolsForToolsets(fakeCatalog({}), [
      { toolsetId: 'ghost', autoAllow: true },
    ]);
    expect(set.size).toBe(0);
  });
});

describe('buildAutoAllowHook', () => {
  it('returns null for an empty tool set', () => {
    expect(buildAutoAllowHook(new Set(), 'cb')).toBeNull();
  });

  it('builds an anchored static-allow PreToolUse hook', () => {
    const hook = buildAutoAllowHook(new Set(['a', 'b']), 'home-monitoring');
    expect(hook).not.toBeNull();
    expect(hook?.phase).toBe('PreToolUse');
    expect(hook?.decision).toBe('allow');
    expect(hook?.script).toBeUndefined();
    expect(hook?.label).toContain('home-monitoring');
    const re = new RegExp(hook!.matcher);
    expect(re.test('a')).toBe(true);
    expect(re.test('b')).toBe(true);
    expect(re.test('ab')).toBe(false);
    expect(re.test('c')).toBe(false);
  });

  it('escapes regex-special characters in tool names', () => {
    const hook = buildAutoAllowHook(new Set(['a.b', 'c+d']), 'cb');
    const re = new RegExp(hook!.matcher);
    expect(re.test('a.b')).toBe(true);
    expect(re.test('axb')).toBe(false); // '.' must be literal
    expect(re.test('c+d')).toBe(true);
  });
});
