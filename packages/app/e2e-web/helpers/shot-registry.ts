/**
 * The source of truth for screenshot *numbering*. Each area maps to an ordered
 * list of shot names; a frame's `NN` prefix is its 1-based index in that list,
 * zero-padded. Numbering therefore stays stable run-to-run even if a test is
 * skipped or retried — the registry, not call order, decides the number.
 *
 * Adding a frame = add its name here (append to keep existing numbers stable)
 * and call `shot(page, name, { area, ... })` from a spec. `shot()` throws if a
 * name isn't registered, which keeps names predictable and AI-addressable.
 */
export type ShotArea =
  | 'shell'
  | 'home'
  | 'chat'
  | 'terminal'
  | 'projects'
  | 'gezels'
  | 'tasks'
  | 'craftbooks'
  | 'scripts'
  | 'documents'
  | 'history'
  | 'settings'
  | 'dialogs'
  | 'handboek';

export const SHOT_REGISTRY: Record<ShotArea, string[]> = {
  shell: [
    'app-shell',
    'header',
    'sidebar-expanded',
    'sidebar-collapsed',
    'sidebar-meester',
    'engine-pill-ds4',
    'sidebar-project-status-tooltip',
  ],
  home: ['workshop', 'greeting-band', 'meester-chat'],
  chat: [
    'timeline',
    'composer',
    'composer-typed',
    'user-bubble',
    'assistant-bubble',
    'references-pane',
  ],
  terminal: ['wide-output'],
  projects: [
    'ide-chat',
    'ide-tasks',
    'ide-workspace',
    'ide-artifacts',
    'ide-about',
    'ide-compact',
    'ide-overview',
    'ide-approvals',
    'ide-village',
  ],
  gezels: ['list', 'detail', 'growth', 'memories'],
  tasks: ['list', 'detail', 'step-tracker', 'step-panel', 'new-dialog', 'new-dialog-craftbook'],
  craftbooks: ['list', 'editor'],
  scripts: ['list'],
  documents: ['tree', 'detail'],
  history: ['timeline'],
  settings: [
    'general',
    'team',
    'folders',
    'ai-defaults',
    'provider-anthropic',
    'provider-openai',
    'provider-ollama',
    'security',
    'about',
    'provider-ds4',
  ],
  dialogs: ['create-gezel', 'create-project'],
  handboek: ['home'],
};

/** Zero-padded 1-based index of `name` within its area; throws if unregistered. */
export function shotNumber(area: ShotArea, name: string): string {
  const list = SHOT_REGISTRY[area];
  const idx = list?.indexOf(name) ?? -1;
  if (idx < 0) {
    throw new Error(
      `shot "${area}/${name}" is not in shot-registry.ts. Add it to SHOT_REGISTRY.${area} (append to keep numbering stable).`,
    );
  }
  return String(idx + 1).padStart(2, '0');
}
