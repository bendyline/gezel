import type { RecentTab, RecentTabArea } from '@bendyline/gezel';

/**
 * The navigation selection model. A single entity (or top-level area) is
 * shown at a time, driven by the left sidebar — there's no longer an MRU
 * tab list. `RecentTabInput` mirrors the `gezel:open-tab` event payload;
 * `RecentTab` is the persisted shape `TabContent` routes on.
 */
export type RecentTabInput =
  | { kind: 'project'; id: string }
  | { kind: 'gezel'; id: string }
  | { kind: 'document'; path: string }
  | { kind: 'task'; ref: string }
  | { kind: 'script'; projectId: string; name: string; scope?: 'standard' | 'user' }
  | { kind: 'craftbook'; id: string; source?: 'bundled' | 'local' | 'project' }
  | { kind: 'craftbook-script'; craftbookId: string; name: string }
  | { kind: 'area'; area: RecentTabArea };

/**
 * Stable identity for a selection — used for active-item highlighting in
 * the sidebar and as the React remount key for the content pane.
 */
export function tabKey(t: RecentTab | RecentTabInput): string {
  switch (t.kind) {
    case 'project':
    case 'gezel':
      return `${t.kind}:${t.id}`;
    case 'document':
      return `document:${t.path}`;
    case 'task':
      return `task:${t.ref}`;
    case 'script':
      return `script:${'scope' in t && t.scope ? `${t.scope}:` : ''}${t.projectId}/${t.name}`;
    case 'craftbook':
      return `craftbook:${t.id}`;
    case 'craftbook-script':
      return `craftbook-script:${t.craftbookId}/${t.name}`;
    case 'area':
      return `area:${t.area}`;
  }
}

/**
 * Build a full `RecentTab` from the lighter `RecentTabInput`. The `at` /
 * `order` fields are vestigial (they powered the old MRU) but remain in
 * the schema, so we stamp benign values to satisfy the type.
 */
export function toRecentTab(input: RecentTabInput): RecentTab {
  const at = Date.now();
  switch (input.kind) {
    case 'project':
      return { kind: 'project', id: input.id, at, order: 0 };
    case 'gezel':
      return { kind: 'gezel', id: input.id, at, order: 0 };
    case 'document':
      return { kind: 'document', path: input.path, at, order: 0 };
    case 'task':
      return { kind: 'task', ref: input.ref, at, order: 0 };
    case 'script':
      return {
        kind: 'script',
        projectId: input.projectId,
        name: input.name,
        ...(input.scope ? { scope: input.scope } : {}),
        at,
        order: 0,
      };
    case 'craftbook':
      return {
        kind: 'craftbook',
        id: input.id,
        ...(input.source ? { source: input.source } : {}),
        at,
        order: 0,
      };
    case 'craftbook-script':
      return {
        kind: 'craftbook-script',
        craftbookId: input.craftbookId,
        name: input.name,
        at,
        order: 0,
      };
    case 'area':
      return { kind: 'area', area: input.area, at, order: 0 };
  }
}
