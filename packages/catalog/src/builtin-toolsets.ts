import type {
  CatalogItemDetail,
  CatalogItemSummary,
  CatalogItemVersionInfo,
  CatalogKind,
  ToolsetManifest,
} from '@bendyline/gezel';
import { sanitizePresentationSvg } from '@bendyline/gezel/svg';
import { BUILTIN_TOOLSET_ICONS } from './builtin-toolset-icons.js';
import type { CatalogSource } from './source.js';

const BUILTIN_VERSION = '1.0.0';
const BUILTIN_RELEASED_AT = '2026-04-25T00:00:00Z';

function builtinIconSvg(id: string): string | undefined {
  const raw = BUILTIN_TOOLSET_ICONS[id];
  return raw ? (sanitizePresentationSvg(raw) ?? undefined) : undefined;
}

import { BUILTIN_TOOLSETS, type BuiltinToolsetGroup } from '@bendyline/gezel';
export { BUILTIN_TOOLSETS, type BuiltinToolsetGroup } from '@bendyline/gezel';

const BUILTIN_BY_ID = new Map(BUILTIN_TOOLSETS.map((g) => [g.id, g]));

/** Resolve a group by its `id` (e.g. `'workspace-fs-read'`). */
export function getBuiltinToolset(id: string): BuiltinToolsetGroup | undefined {
  return BUILTIN_BY_ID.get(id);
}

/**
 * Inverse map: tool name → group it belongs to. Built once at module
 * load (~60 entries). Used by the auto-injected `## Tools available
 * this turn` block in the system prompt to bucket tool names into
 * named groups so the model sees a structured listing rather than a
 * flat alphabet soup. Tools not in any group (third-party MCP servers
 * the user installed) get classified as "other" by the consumer.
 *
 * If two groups ever name the same tool, the FIRST group in
 * `BUILTIN_TOOLSETS` wins (matches the Map insertion-order iteration).
 * Deliberate subset groups such as `tasks-readonly` may duplicate a
 * strict slice of their base group; other duplication is a manifest bug
 * worth surfacing rather than silently resolving here.
 */
export const BUILTIN_TOOL_TO_GROUP = new Map<string, BuiltinToolsetGroup>(
  BUILTIN_TOOLSETS.flatMap((g) => g.tools.map((toolName) => [toolName, g] as const)),
);

/** Catalog id format: `builtin.<group-id>`. */
export function builtinCatalogId(groupId: string): string {
  return `builtin.${groupId}`;
}

const SOURCE_ID = 'builtin';

function manifestForGroup(g: BuiltinToolsetGroup): ToolsetManifest {
  return {
    schemaVersion: 1,
    kind: 'toolset',
    id: builtinCatalogId(g.id),
    name: g.name,
    description: g.description,
    tags: ['built-in'],
    maintainer: { name: 'Gezel' },
    version: BUILTIN_VERSION,
    releasedAt: BUILTIN_RELEASED_AT,
    logo: 'icon.svg',
    tools: g.tools.map((name) => ({ name, description: '' })),
    runtime: { kind: 'builtin', toolsetGroupId: g.id },
    config: [],
    availableVersions: [BUILTIN_VERSION],
  };
}

/**
 * Catalog source that exposes the BUILTIN_TOOLSETS as installable
 * toolsets. Composed alongside `BundledSource` in `CatalogService`.
 */
export class BuiltinToolsetsSource implements CatalogSource {
  readonly id = SOURCE_ID;
  readonly label = 'Built-in';

  async listKinds(): Promise<CatalogKind[]> {
    return ['toolset'];
  }

  async list(kind: CatalogKind): Promise<CatalogItemSummary[]> {
    if (kind !== 'toolset') return [];
    return BUILTIN_TOOLSETS.map((g) => {
      const manifest = manifestForGroup(g);
      const iconSvg = builtinIconSvg(g.id);
      return {
        sourceId: this.id,
        kind,
        manifest,
        ...(iconSvg ? { iconSvg } : {}),
      };
    });
  }

  async get(kind: CatalogKind, id: string, version?: string): Promise<CatalogItemDetail | null> {
    if (kind !== 'toolset') return null;
    if (version !== undefined && version !== BUILTIN_VERSION) return null;
    const groupId = id.startsWith('builtin.') ? id.slice('builtin.'.length) : null;
    if (!groupId) return null;
    const g = BUILTIN_BY_ID.get(groupId);
    if (!g) return null;
    const manifest = manifestForGroup(g);
    const iconSvg = builtinIconSvg(g.id);
    return {
      sourceId: this.id,
      kind,
      manifest,
      ...(iconSvg ? { iconSvg } : {}),
    };
  }

  async listVersions(kind: CatalogKind, id: string): Promise<CatalogItemVersionInfo[]> {
    if (kind !== 'toolset') return [];
    const groupId = id.startsWith('builtin.') ? id.slice('builtin.'.length) : null;
    if (!groupId || !BUILTIN_BY_ID.has(groupId)) return [];
    return [{ version: BUILTIN_VERSION, releasedAt: BUILTIN_RELEASED_AT, yanked: false }];
  }

  async readItemFile(
    kind: CatalogKind,
    id: string,
    relPath: string,
    _version?: string,
  ): Promise<Buffer | null> {
    if (kind !== 'toolset' || relPath !== 'icon.svg') return null;
    if (!id.startsWith('builtin.')) return null;
    const groupId = id.slice('builtin.'.length);
    const svg = BUILTIN_TOOLSET_ICONS[groupId];
    if (!svg) return null;
    return Buffer.from(svg, 'utf8');
  }
}
