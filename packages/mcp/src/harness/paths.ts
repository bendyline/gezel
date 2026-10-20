import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { UnifiedSearchResult } from '@bendyline/gezel';
import type { HarnessBinding } from './session.js';

/**
 * An outside app names files by absolute path (or relative to the folder it
 * works in); Gezel's routes take paths relative to a root it owns. These
 * convert between the two, and refuse anything outside those roots rather
 * than guess.
 */

/** `child` relative to `root`, forward-slashed, or null when it lies outside. */
export function relativeInside(root: string, child: string): string | null {
  const rel = relative(root, child);
  if (rel === '') return '';
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/** An app's path made absolute: relative paths are read from the folder it works in. */
export function absoluteFromApp(binding: HarnessBinding, path: string): string {
  if (isAbsolute(path)) return resolve(path);
  const base = binding.folder ?? binding.info?.project?.workingDir;
  return base ? resolve(base, path) : resolve(path);
}

export type RootedPath =
  | { root: 'workspace'; rel: string; abs: string }
  | { root: 'library'; rel: string; abs: string }
  | { root: 'artifacts'; rel: string; abs: string };

/** Which Gezel root an app's path is in: the bound project's folder, the library, or the artifacts. */
export function rootedPath(binding: HarnessBinding, path: string): RootedPath | null {
  const abs = absoluteFromApp(binding, path);
  const workingDir = binding.info?.project?.workingDir;
  if (workingDir) {
    const rel = relativeInside(workingDir, abs);
    if (rel !== null && rel !== '') return { root: 'workspace', rel, abs };
  }
  const libraryDir = binding.info?.libraryDir;
  if (libraryDir) {
    const rel = relativeInside(libraryDir, abs);
    if (rel !== null && rel !== '') return { root: 'library', rel, abs };
  }
  const artifactsDir = binding.info?.artifactsDir;
  if (artifactsDir) {
    const rel = relativeInside(artifactsDir, abs);
    if (rel !== null && rel !== '') return { root: 'artifacts', rel, abs };
  }
  return null;
}

/** Plain words for where an app may name files, for an "outside" refusal. */
export function whereFilesMayBe(binding: HarnessBinding): string {
  const places: string[] = [];
  const project = binding.info?.project;
  if (project?.workingDir)
    places.push(`the folder Gezel knows as "${project.name}" (${project.workingDir})`);
  if (binding.info?.libraryDir) places.push(`the shared library (${binding.info.libraryDir})`);
  return places.length > 0 ? places.join(' or ') : 'the shared library';
}

/** The absolute path a search hit points at, when its root is known on this computer. */
export function absoluteForHit(binding: HarnessBinding, hit: UnifiedSearchResult): string | null {
  if (!hit.path) return null;
  const project = binding.info?.project;
  const ownProject = !hit.projectId || hit.projectId === project?.id;
  if (hit.retrievalSource === 'shared' && binding.info?.libraryDir) {
    return join(binding.info.libraryDir, hit.path);
  }
  if (!ownProject) return null;
  if (
    (hit.retrievalSource === 'artifacts' || hit.source === 'artifacts') &&
    binding.info?.artifactsDir
  ) {
    return join(binding.info.artifactsDir, hit.path);
  }
  if (project?.workingDir && (hit.retrievalSource === 'workspace' || hit.source === 'workspace')) {
    return join(project.workingDir, hit.path);
  }
  return null;
}
