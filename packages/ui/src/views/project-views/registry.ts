import type { ProjectViewId } from '@bendyline/gezel';
import { type ComponentType, type LazyExoticComponent, lazy } from 'react';
import type { ProjectViewDefinition, ProjectViewProps } from './types.js';

/**
 * Every view this build can show in the project Views tab, in menu order.
 * Adding one is an entry here plus its folder; which projects it suits is
 * core's `projectViewApplies`, so the rule is the same on every host.
 */
export const PROJECT_VIEWS: readonly ProjectViewDefinition[] = [
  {
    id: 'village',
    label: 'Village',
    hint: 'Your files as a town you come to know',
    icon: 'village',
    load: () => import('./village/index.js'),
  },
  {
    id: 'guide',
    label: 'Guide',
    hint: 'What each folder is for, and what the rest leans on',
    icon: 'guide',
    load: () => import('./guide/index.js'),
  },
  {
    id: 'diagram',
    label: 'Diagram',
    hint: 'Files as boxes, and arrows for what each one uses',
    icon: 'diagram',
    load: () => import('./diagram/index.js'),
  },
  {
    id: 'reports',
    label: 'Reports',
    hint: 'What Gezel has written about this project, read in place',
    icon: 'reports',
    load: () => import('./reports/index.js'),
  },
  {
    id: 'gallery',
    label: 'Gallery',
    hint: 'Your files as shelves to browse, by type, folder or outing',
    icon: 'gallery',
    load: () => import('./gallery/index.js'),
  },
  {
    id: 'timeline',
    label: 'Timeline',
    hint: 'What changed when, week by week',
    icon: 'timeline',
    load: () => import('./timeline/index.js'),
  },
];

/** The ids this build offers, for core's availability rules. */
export const OFFERED_PROJECT_VIEWS: readonly ProjectViewId[] = PROJECT_VIEWS.map((v) => v.id);

export function projectViewDefinition(id: ProjectViewId): ProjectViewDefinition | undefined {
  return PROJECT_VIEWS.find((v) => v.id === id);
}

const lazyViews = new Map<ProjectViewId, LazyExoticComponent<ComponentType<ProjectViewProps>>>();

/** One lazy component per view, so switching back never re-creates it. */
export function lazyProjectView(
  id: ProjectViewId,
): LazyExoticComponent<ComponentType<ProjectViewProps>> | null {
  const definition = projectViewDefinition(id);
  if (!definition) return null;
  let view = lazyViews.get(id);
  if (!view) {
    view = lazy(definition.load);
    lazyViews.set(id, view);
  }
  return view;
}

/** Start loading a view's code before it is chosen (menu hover, tab hover). */
export function preloadProjectView(id: ProjectViewId): void {
  void projectViewDefinition(id)
    ?.load()
    .catch(() => {});
}
