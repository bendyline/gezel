/**
 * Connector data that stays on models that run on this computer.
 *
 * A Google account's records are kept here until the person allows cloud
 * models for that connection (core `connectionKeepsLocal`). This module says
 * what is kept: a connection's own folder, what a removed connection left
 * behind, and what a conversation that read the data wrote. Who is asking is
 * decided by `http/kept-local-gate.ts` for a route and by `ChatManager` for a
 * turn, so a new way to read artifacts must ask one of them
 * (docs/kept-local-data.md lists every one that does).
 */

import { join } from 'node:path';
import {
  type KeptLocalEntry,
  type KeptLocalSource,
  type ProjectConnectorBinding,
  connectionKeepsLocal,
} from '@bendyline/gezel';
import { isPathInside } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import type { Store } from '../fs/store.js';
import { keptMemoryTagNames } from '../memory/daily-markdown.js';
import { artifactKey, canonicalPath, corpusDirFor } from './corpus-path.js';

/** A folder or file whose contents stay here, and whose data it holds. */
export interface KeptLocalArea {
  /** Relative to the project's artifacts. */
  path: string;
  source: KeptLocalSource;
}

type KeptLocalStore = Pick<
  Store,
  | 'getProject'
  | 'listProjects'
  | 'readKeptLocal'
  | 'updateKeptLocal'
  | 'projectArtifactsDir'
  | 'projectQuarantineDir'
>;

/** Past this many entries a project's oldest file entries fold into their folders. */
const MAX_LEDGER_ENTRIES = 2000;

export class KeptLocalData {
  constructor(private readonly store: KeptLocalStore) {}

  /** Everything in this project's artifacts that stays here. Empty for most projects. */
  async areas(projectId: string): Promise<KeptLocalArea[]> {
    const [project, ledger] = await Promise.all([
      this.store.getProject(projectId).catch(() => null),
      this.store.readKeptLocal(projectId).catch(() => [] as KeptLocalEntry[]),
    ]);
    const bindings = project?.connectors ?? [];
    const judge = this.judge();
    const areas: KeptLocalArea[] = bindings
      .filter((b) => connectionKeepsLocal(b))
      .map((b) => ({
        path: corpusDirFor(bindings, b),
        source: keptLocalSource(projectId, b),
      }));
    for (const entry of ledger) {
      // A connection that took the folder again answers for it.
      if (bindings.some((b) => sameFolder(corpusDirFor(bindings, b), entry.path))) continue;
      if (await judge(entry.source)) areas.push(entry);
    }
    return areas;
  }

  /** The sources that still keep their data here. */
  async active(sources: readonly KeptLocalSource[] | undefined): Promise<KeptLocalSource[]> {
    if (!sources || sources.length === 0) return [];
    const judge = this.judge();
    const held: KeptLocalSource[] = [];
    for (const source of sources) if (await judge(source)) held.push(source);
    return held;
  }

  /**
   * Whether a source still keeps its data here, reading each project once. A
   * connection that was removed never allowed cloud models, so what it left
   * does not become readable.
   */
  private judge(): (source: KeptLocalSource) => Promise<boolean> {
    const projects = new Map<string, Promise<ProjectConnectorBinding[]>>();
    return async (source) => {
      let bindings = projects.get(source.projectId);
      if (!bindings) {
        bindings = this.store.getProject(source.projectId).then(
          (p) => p?.connectors ?? [],
          () => [],
        );
        projects.set(source.projectId, bindings);
      }
      const binding = (await bindings).find((b) => b.id === source.bindingId);
      return binding ? connectionKeepsLocal(binding) : true;
    };
  }

  /**
   * The absolute folders and files kept here in every project, and the
   * quarantine beside them. For an agent whose own file tools take absolute
   * paths, so a project boundary means nothing to them.
   */
  async everywhere(): Promise<string[]> {
    const projects = await this.store.listProjects().catch(() => []);
    const paths: string[] = [];
    for (const project of projects) {
      const areas = await this.areas(project.id);
      if (areas.length === 0) continue;
      const artifactsDir = this.store.projectArtifactsDir(project.id);
      paths.push(...areas.map((area) => join(artifactsDir, area.path)));
      paths.push(this.store.projectQuarantineDir(project.id));
    }
    return paths;
  }

  /** The connections a memory's `kept` tags name. One that is gone still holds. */
  async sourcesForTags(tags: readonly string[]): Promise<KeptLocalSource[]> {
    if (tags.length === 0) return [];
    const found = new Map<string, KeptLocalSource>();
    const named = new Set<string>();
    for (const project of await this.store.listProjects().catch(() => [])) {
      for (const binding of project.connectors ?? []) {
        for (const tag of tags) {
          if (!keptMemoryTagNames(tag, binding.id)) continue;
          named.add(tag);
          found.set(binding.id, keptLocalSource(project.id, binding));
        }
      }
    }
    for (const tag of tags) {
      if (!named.has(tag)) {
        found.set(tag, { projectId: '', bindingId: tag, name: 'a connection that was removed' });
      }
    }
    return [...found.values()];
  }

  /** Remember artifacts that now hold this data, so later reads are judged by it. */
  async remember(
    projectId: string,
    paths: readonly string[],
    sources: readonly KeptLocalSource[],
  ): Promise<void> {
    const source = sources[0];
    const added = paths.map((p) => artifactKey(p)).filter(Boolean);
    if (!source || added.length === 0) return;
    await this.store.updateKeptLocal(projectId, (entries) => {
      const held = new Set(entries.map((e) => artifactKey(e.path)));
      const fresh = added.filter((path) => !held.has(path) && !coveredBy(entries, path));
      if (fresh.length === 0) return entries;
      return foldLedger([...entries, ...fresh.map((path) => ({ path, source }))]);
    });
  }

  /** The kept area an artifact path is in, judged by the path alone. */
  areaForPath(areas: readonly KeptLocalArea[], artifactPath: string): KeptLocalArea | undefined {
    if (areas.length === 0) return undefined;
    const path = artifactKey(artifactPath);
    return areas.find((area) => {
      const key = artifactKey(area.path);
      return path === key || path.startsWith(`${key}/`);
    });
  }

  /** The kept areas a path is in, or that are in it: an input can name a parent folder. */
  areasTouching(areas: readonly KeptLocalArea[], artifactPath: string): KeptLocalArea[] {
    const path = artifactKey(artifactPath);
    return areas.filter((area) => {
      const key = artifactKey(area.path);
      return key === path || path.startsWith(`${key}/`) || key.startsWith(`${path}/`);
    });
  }

  /**
   * The kept area that holds `file`, an absolute path a reader is about to
   * open. Real paths resolve case, `.`/`..`, links and short names the way
   * the read itself will.
   */
  async areaForFile(
    projectId: string,
    areas: readonly KeptLocalArea[],
    file: string,
  ): Promise<KeptLocalArea | undefined> {
    if (areas.length === 0) return undefined;
    const target = await canonicalPath(file);
    const artifactsDir = this.store.projectArtifactsDir(projectId);
    for (const area of areas) {
      const root = await canonicalPath(join(artifactsDir, area.path));
      if (target === root || isPathInside(target, root)) return area;
    }
    return undefined;
  }
}

/** A task's folder in its project's artifacts. */
export function taskArtifactFolder(num: number): string {
  return `tasks/${num}`;
}

export function keptLocalSource(
  projectId: string,
  binding: Pick<ProjectConnectorBinding, 'id' | 'type' | 'displayName'>,
): KeptLocalSource {
  return { projectId, bindingId: binding.id, name: binding.displayName ?? binding.type };
}

function sameFolder(a: string, b: string): boolean {
  return artifactKey(a) === artifactKey(b);
}

function coveredBy(entries: readonly KeptLocalEntry[], path: string): boolean {
  return entries.some((e) => path.startsWith(`${artifactKey(e.path)}/`));
}

/** Over the cap, the oldest files become their folder: wider, never narrower. */
function foldLedger(entries: KeptLocalEntry[]): KeptLocalEntry[] {
  if (entries.length <= MAX_LEDGER_ENTRIES) return entries;
  const folded = new Map<string, KeptLocalEntry>();
  entries.forEach((entry, i) => {
    const key = artifactKey(entry.path);
    const folder = i < entries.length / 2 && key.includes('/') ? key.replace(/\/[^/]*$/, '') : key;
    if (!folded.has(folder)) folded.set(folder, { ...entry, path: folder });
  });
  return [...folded.values()];
}

/** The distinct sources in a list. */
export function uniqueSources(sources: readonly KeptLocalSource[]): KeptLocalSource[] {
  return [...new Map(sources.map((s) => [`${s.projectId}\0${s.bindingId}`, s])).values()];
}

/** "Google Calendar", "Google Calendar and Gmail", for a sentence. */
export function sourceNames(sources: readonly KeptLocalSource[]): string {
  return new Intl.ListFormat('en', { type: 'conjunction' }).format([
    ...new Set(sources.map((s) => s.name)),
  ]);
}

/** Read by the model, so it names the move that works. */
export function keptLocalRefusal(sources: readonly KeptLocalSource[]): string {
  const names = sourceNames(sources);
  return `${names} stays on this computer: only gezels on a model that runs here can read it, and you run on a cloud model. Don't look for another way to it. If the person asks for it, tell them they can turn on "Let cloud AI read this" for ${names} under the project's Connections, or ask a gezel on a local model.`;
}

/** What a gezel on a local model hears when it passes such a conversation on. */
export function keptLocalPassOnRefusal(sources: readonly KeptLocalSource[], to: string): string {
  return `This conversation read ${sourceNames(sources)}, which stays on this computer, and ${to} runs on a cloud model, so nothing from here can be sent to ${to}. Answer the person yourself, or ask a gezel on a local model. The person can allow it under the project's Connections.`;
}

/** The person's own sentence when a conversation cannot run where it was sent. */
export function keptLocalTurnMessage(sources: readonly KeptLocalSource[]): string {
  const names = sourceNames(sources);
  return `This conversation uses ${names}, which stays on this computer, so it can't run on a cloud AI. Choose a model on this computer, or turn on “Let cloud AI read this” for ${names} under the project's Connections.`;
}

export const KEPT_LOCAL_CODE = 'kept-local-data';

/** A turn or one-shot that would have sent kept-local data off this computer. */
export class KeptLocalDataError extends Error {
  readonly code = KEPT_LOCAL_CODE;
  readonly isActionable = true;
  constructor(readonly sources: readonly KeptLocalSource[]) {
    super(keptLocalTurnMessage(sources));
    this.name = 'KeptLocalDataError';
  }
}
