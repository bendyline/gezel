/**
 * App updates: move a project that already runs a project type to another
 * version of it (normally the newest of the same major), or refresh the one it
 * runs. See docs/project-types.md ("Upgrades").
 *
 * The program moves together; the person's things stay:
 * - Page, tool declarations and page reads follow the stamp (referenced).
 * - Scripts the app installed are replaced. One the person edited is saved to
 *   the artifacts drawer first, and only with their OK.
 * - Data seeds are kept once changed (`preserve`); new seeds are written.
 * - About and mission are replaced only while they hold what the app rendered.
 * - Craftbooks: the app's untouched copies are updated; edited, own and
 *   deleted books are left alone.
 * - App-managed settings move only while the project holds the old version's
 *   value (core `upgradeProjectTypeSettings`).
 * - Crew, tool services and self-starting schedules a new version adds wait
 *   for the person's OK; anything the person removed stays removed.
 *
 * The provenance stamp is the last write, so an update interrupted part way
 * leaves the old stamp and the next run converges: every step first checks
 * whether its file already holds the target.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type AppliedProjectType,
  type AppliedScriptRecord,
  type AppliedSeedRecord,
  type InstalledToolset,
  type ProjectDetail,
  type ProjectTypeDocChange,
  type ProjectTypeManifest,
  type ProjectTypeOverlay,
  type ProjectTypeProvenance,
  type ProjectTypeScriptChange,
  type ProjectTypeSettings,
  type ProjectTypeUpgradeNeedsOkKind,
  type ProjectTypeUpgradePlan,
  type SeedPlanState,
  createLogger,
  gezelNamesInUse,
  pickProjectTypeUpgradeTarget,
  projectTypeCrewMatch,
  projectTypeCurrentSettings,
  projectTypeDeclaredSettings,
  projectTypeIcon,
  projectTypeParamsWithoutValue,
  projectTypeScriptHeader,
  projectTypeScriptProvenance,
  renderProjectTypeTemplate,
  seedParamDefaults,
  upgradeProjectTypeSettings,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { writeFileAtomic } from '@bendyline/gezel-inference/internal/fs/atomic';
import { safeJoin } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import { projectScriptFile } from '@bendyline/gezel/paths';
import { parseScriptMeta } from '../scripts/meta.js';
import {
  type AppliedCrewMember,
  type ApplyProjectTypeDeps,
  classifySeed,
  crewPool,
  docFingerprint,
  fillCrewSlot,
  materializeProjectTypeSchedules,
  projectTypeScheduleKeys,
  rosterGezels,
  sha256Hex,
  withProjectTypeApplyLock,
} from './apply-common.js';
import {
  type PlannedProjectTypeCraftbook,
  planProjectTypeCraftbooks,
  writeProjectTypeCraftbook,
} from './craftbooks.js';

const log = createLogger('project-type');

/** Gilde, Gezel's own catalog: the only source whose updates run on their own. */
export const AUTOMATIC_UPDATE_SOURCE = 'bundled';

export interface ProjectTypeUpdateInput {
  projectId: string;
  /** Exact target version. Default: the newest of the same major, else a refresh. */
  version?: string;
  /** Param values over the stored ones. */
  params?: Record<string, unknown>;
  /** Default `preserve`: a seed the person changed is kept. */
  seedPolicy?: 'overwrite' | 'preserve';
  /** See `ApplyProjectTypeInput.personApproved`. */
  personApproved?: boolean;
  /** True pins, false unpins; unset keeps the pin on a refresh and clears it on a move. */
  pin?: boolean;
}

/** An update that must wait for the person: `plan.needsOk` says why. */
export class ProjectTypeUpgradeNeedsOkError extends Error {
  readonly code = 'project_type_update_needs_ok' as const;
  constructor(readonly plan: ProjectTypeUpgradePlan) {
    super(
      `Updating ${plan.typeName} to version ${plan.toVersion} needs the person's OK in Gezel (${plan.needsOk
        .map((reason) => describeNeedsOk(reason.kind))
        .join('; ')}). Ask them to update it from the project.`,
    );
    this.name = 'ProjectTypeUpgradeNeedsOkError';
  }
}

function describeNeedsOk(kind: ProjectTypeUpgradeNeedsOkKind): string {
  switch (kind) {
    case 'edited-script':
      return 'it replaces a script that was edited here';
    case 'new-crew':
      return 'it adds a crew member';
    case 'new-toolset':
      return 'it connects a new tool service';
    case 'new-schedule':
      return 'it adds a recurring run that starts on its own';
    case 'folder-write':
      return "it writes into a folder Gezel doesn't have permission to change";
    case 'network-access':
      return 'a script now asks for network access or a credential';
    case 'other-source':
      return "the app isn't from Gezel's own catalog";
    case 'pinned':
      return 'the project was set up on this version on purpose';
  }
}

interface UpdateTarget {
  previous: ProjectTypeManifest | null;
  next: ProjectTypeManifest;
}

async function getType(
  catalog: CatalogService,
  id: string,
  source: string,
  version?: string,
): Promise<ProjectTypeManifest | null> {
  const detail = await catalog.get('project-type', id, source, version).catch(() => null);
  return detail?.manifest.kind === 'project-type' ? detail.manifest : null;
}

/**
 * The version an update moves to, inside the project's own source. Without an
 * explicit `version`, the newest of the same major, unless a param it added
 * would render as `{{placeholder}}`. `allowRefresh` turns "nothing newer" into
 * the version the project runs (an explicit re-apply) instead of null.
 */
async function resolveUpdateTarget(
  catalog: CatalogService,
  provenance: ProjectTypeProvenance,
  version: string | undefined,
  allowRefresh: boolean,
): Promise<UpdateTarget | null> {
  const previous = await getType(catalog, provenance.id, provenance.source, provenance.version);
  if (version !== undefined) {
    if (version === provenance.version && !allowRefresh) return null;
    const next =
      version === provenance.version && previous
        ? previous
        : await getType(catalog, provenance.id, provenance.source, version);
    if (!next) throw new Error(`project type ${provenance.id}@${version} not found`);
    return { previous, next };
  }
  const refresh = allowRefresh && previous ? { previous, next: previous } : null;
  const latest = await getType(catalog, provenance.id, provenance.source);
  if (!latest) return refresh;
  const target = pickProjectTypeUpgradeTarget({
    stamp: provenance.version,
    available: [...new Set([latest.version, ...latest.availableVersions])],
    stampResolves: previous !== null,
  });
  if (!target) return refresh;
  const next =
    target === latest.version
      ? latest
      : await getType(catalog, provenance.id, provenance.source, target);
  if (!next) return refresh;
  const missing = projectTypeParamsWithoutValue({
    previousSchema: previous?.params,
    nextSchema: next.params,
    params: provenance.params,
  });
  if (missing.length > 0) {
    log.info(
      `[upgrade] ${provenance.id} ${next.version} needs ${missing.join(', ')} that projects made with ${provenance.version} never gave; not offered`,
    );
    return refresh;
  }
  return { previous, next };
}

interface ScriptStep {
  name: string;
  change: ProjectTypeScriptChange;
  content: string;
  existing: string | null;
}

interface SeedStep {
  rel: string;
  recordPath: string;
  area: 'workspace' | 'artifacts';
  rendered: string;
  state: SeedPlanState;
  prior?: AppliedSeedRecord;
}

interface DocStep {
  change: ProjectTypeDocChange;
  rendered?: string;
  /** What the overlay records as the app's last rendering after this update. */
  record?: { sha256: string };
}

interface UpdateAnalysis {
  plan: ProjectTypeUpgradePlan;
  project: ProjectDetail;
  provenance: ProjectTypeProvenance;
  previous: ProjectTypeManifest | null;
  next: ProjectTypeManifest;
  moving: boolean;
  params: Record<string, unknown>;
  overlay: ProjectTypeOverlay | null;
  seedPolicy: 'overwrite' | 'preserve';
  scripts: ScriptStep[];
  seeds: SeedStep[];
  about: DocStep;
  mission: DocStep;
  craftbooks: PlannedProjectTypeCraftbook[];
  keptCrew: AppliedCrewMember[];
  newCrew: ProjectTypeManifest['gezels'];
  newToolsets: InstalledToolset[];
  deferredToolsets: string[];
  scheduleKeys: Set<string>;
  settings: { values: ProjectTypeSettings; changed: string[] };
}

function scriptRequirements(body: string | undefined, name: string): string[] {
  if (body === undefined) return [];
  try {
    return parseScriptMeta(body, `${name}.ts`).requires ?? [];
  } catch {
    return [];
  }
}

const OUTWARD = (requirement: string) =>
  requirement === 'network' || requirement.startsWith('credential:');

async function readText(
  catalog: CatalogService,
  m: ProjectTypeManifest,
  source: string,
  rel: string,
) {
  const buf = await catalog
    .readItemFile('project-type', m.id, rel, source, m.version)
    .catch(() => null);
  return buf ? buf.toString('utf8') : null;
}

/** Did the app's page or tool declarations change between the two versions? */
async function pageChanged(
  catalog: CatalogService,
  source: string,
  previous: ProjectTypeManifest | null,
  next: ProjectTypeManifest,
): Promise<boolean> {
  if (!previous) return true;
  if (previous.version === next.version) return false;
  if (JSON.stringify(previous.pages) !== JSON.stringify(next.pages)) return true;
  if (JSON.stringify(previous.tools) !== JSON.stringify(next.tools)) return true;
  if (!next.pages) return false;
  const files = await catalog.listItemFiles('project-type', next.id, source).catch(() => []);
  const pagesOf = (version: string) => {
    const prefix = `versions/${version}/pages/`;
    return files.filter((f) => f.startsWith(prefix)).map((f) => f.slice(prefix.length));
  };
  const before = pagesOf(previous.version);
  const after = pagesOf(next.version);
  if (before.length !== after.length || before.some((f, i) => f !== after[i])) return true;
  for (const rel of after) {
    const [a, b] = await Promise.all([
      catalog.readItemFile('project-type', next.id, `pages/${rel}`, source, previous.version),
      catalog.readItemFile('project-type', next.id, `pages/${rel}`, source, next.version),
    ]);
    if (!a || !b || !a.equals(b)) return true;
  }
  return false;
}

async function planDoc(args: {
  catalog: CatalogService;
  source: string;
  previous: ProjectTypeManifest | null;
  next: ProjectTypeManifest;
  template: 'aboutTemplate' | 'missionTemplate';
  current: string | null | undefined;
  record: { sha256: string } | undefined;
  params: Record<string, unknown>;
  oldParams: Record<string, unknown>;
}): Promise<DocStep> {
  const { catalog, source, previous, next } = args;
  const template = next[args.template];
  const keep: DocStep = { change: 'unchanged', ...(args.record ? { record: args.record } : {}) };
  if (!template) return keep;
  const text = await readText(catalog, next, source, template);
  if (text === null) return keep;
  const rendered = renderProjectTypeTemplate(text, args.params);
  const renderedRecord = { sha256: docFingerprint(rendered) };
  const current = docFingerprint(args.current);
  if (current === renderedRecord.sha256) return { change: 'unchanged', record: renderedRecord };

  let appWritten: boolean;
  let lastRendered = args.record;
  if (args.record) {
    appWritten = current === args.record.sha256;
  } else {
    const prevTemplate = previous?.[args.template];
    const prevText =
      previous && prevTemplate ? await readText(catalog, previous, source, prevTemplate) : null;
    if (prevText !== null) {
      lastRendered = {
        sha256: docFingerprint(renderProjectTypeTemplate(prevText, args.oldParams)),
      };
      appWritten = current === lastRendered.sha256;
    } else {
      // No older rendering to compare with: only an empty document is ours to fill.
      appWritten = !(args.current ?? '').trim();
    }
  }
  if (appWritten) return { change: 'replace', rendered, record: renderedRecord };
  return { change: 'keep-edited', ...(lastRendered ? { record: lastRendered } : {}) };
}

/**
 * Everything an update would do, computed without writing. The plan the UI
 * shows and the writes `applyProjectTypeUpdateUnlocked` makes both come from
 * this one pass, so they cannot disagree.
 */
async function analyzeUpdate(
  deps: ApplyProjectTypeDeps,
  project: ProjectDetail,
  provenance: ProjectTypeProvenance,
  target: UpdateTarget,
  input: Pick<ProjectTypeUpdateInput, 'params' | 'seedPolicy'>,
): Promise<UpdateAnalysis> {
  const { store, catalog, home } = deps;
  const { previous, next } = target;
  const source = provenance.source;
  const typeId = provenance.id;
  const projectId = project.id;
  const moving = next.version !== provenance.version;
  const needsOk = new Map<ProjectTypeUpgradeNeedsOkKind, string[]>();
  const flag = (kind: ProjectTypeUpgradeNeedsOkKind, item: string) => {
    const items = needsOk.get(kind) ?? [];
    if (!items.includes(item)) items.push(item);
    needsOk.set(kind, items);
  };

  if (moving && source !== AUTOMATIC_UPDATE_SOURCE) flag('other-source', source);
  if (moving && provenance.pinned) flag('pinned', provenance.version);

  const oldParams = { ...seedParamDefaults(previous?.params), ...(provenance.params ?? {}) };
  const params = {
    ...seedParamDefaults(next.params),
    ...(provenance.params ?? {}),
    ...(input.params ?? {}),
  };
  const overlay = await store.readProjectTypeOverlay(projectId);

  // Scripts.
  const shipped = new Map<string, ProjectTypeManifest | null>();
  const shippedContent = async (name: string, existing: string): Promise<boolean> => {
    const stamp = projectTypeScriptProvenance(existing);
    const at = stamp?.lastIndexOf('@') ?? -1;
    if (!stamp || at <= 0 || stamp.slice(0, at) !== typeId) return false;
    const version = stamp.slice(at + 1);
    if (!shipped.has(version))
      shipped.set(version, await getType(catalog, typeId, source, version));
    const body = shipped.get(version)?.scripts?.[name];
    return body !== undefined && existing === `${projectTypeScriptHeader(typeId, version)}${body}`;
  };
  const scriptRecords = new Map((overlay?.scripts ?? []).map((r) => [r.name, r] as const));
  const scripts: ScriptStep[] = [];
  for (const [name, body] of Object.entries(next.scripts ?? {})) {
    const content = `${projectTypeScriptHeader(typeId, next.version)}${body}`;
    const existing = await readFile(projectScriptFile(home, projectId, name), 'utf8').catch(
      () => null,
    );
    let change: ProjectTypeScriptChange;
    if (existing === null) change = 'add';
    else if (existing === content) change = 'unchanged';
    else if (scriptRecords.get(name)?.sha256 === sha256Hex(existing)) change = 'replace';
    else if (await shippedContent(name, existing)) change = 'replace';
    else change = 'replace-edited';
    if (change === 'replace-edited') flag('edited-script', name);
    if (change !== 'unchanged') {
      const before = new Set(scriptRequirements(previous?.scripts?.[name], name));
      const added = scriptRequirements(body, name).filter((r) => OUTWARD(r) && !before.has(r));
      if (added.length > 0) flag('network-access', `${name}: ${added.join(', ')}`);
    }
    scripts.push({ name, change, content, existing });
  }

  // About and mission.
  const about = await planDoc({
    catalog,
    source,
    previous,
    next,
    template: 'aboutTemplate',
    current: project.about,
    record: overlay?.docs?.about,
    params,
    oldParams,
  });
  const mission = await planDoc({
    catalog,
    source,
    previous,
    next,
    template: 'missionTemplate',
    current: project.missionObjectives,
    record: overlay?.docs?.mission,
    params,
    oldParams,
  });

  // Seeds.
  const seedPolicy = input.seedPolicy ?? 'preserve';
  const priorSeeds = new Map((overlay?.seeds ?? []).map((seed) => [seed.path, seed] as const));
  const declaredBefore = new Set([
    ...(previous?.workspaceSeed ?? []),
    ...(previous?.artifactsSeed ?? []).map((rel) => `artifacts/${rel}`),
  ]);
  const workspaceDir = await store.projectWorkspaceDir(projectId);
  const artifactsDir = store.projectArtifactsDir(projectId);
  const seeds: SeedStep[] = [];
  const planSeed = async (rel: string, area: SeedStep['area']) => {
    const recordPath = area === 'artifacts' ? `artifacts/${rel}` : rel;
    const text = await readText(catalog, next, source, rel);
    if (text === null) {
      log.warn(`[upgrade] project type ${typeId}@${next.version}: seed ${rel} not found`);
      return;
    }
    const dest = safeJoin(area === 'artifacts' ? artifactsDir : workspaceDir, rel);
    if (!dest) return;
    const rendered = renderProjectTypeTemplate(text, params);
    const prior = priorSeeds.get(recordPath);
    let state = classifySeed({
      existing: await readFile(dest).catch(() => null),
      renderedSha: sha256Hex(rendered),
      priorSha: prior?.sha256,
      policy: seedPolicy,
    });
    // A data file the app wrote before and the person since deleted stays gone.
    if (
      state === 'new' &&
      seedPolicy === 'preserve' &&
      (prior !== undefined || declaredBefore.has(recordPath))
    ) {
      state = 'keep-modified';
    }
    seeds.push({ rel, recordPath, area, rendered, state, ...(prior ? { prior } : {}) });
  };
  for (const rel of next.workspaceSeed) await planSeed(rel, 'workspace');
  for (const rel of next.artifactsSeed) await planSeed(rel, 'artifacts');

  // Craftbooks.
  const craftbooks =
    next.craftbooks.length > 0
      ? await planProjectTypeCraftbooks(
          { store, catalog },
          {
            projectId,
            typeId,
            typeVersion: next.version,
            source,
            craftbookIds: next.craftbooks,
            previousIds: previous?.craftbooks ?? null,
          },
        )
      : [];

  const folderWrites = [
    ...seeds
      .filter((s) => s.area === 'workspace' && (s.state === 'new' || s.state === 'update'))
      .map((s) => s.rel),
    ...craftbooks
      .filter((c) => c.change === 'install' || c.change === 'update')
      .map((c) => `.gezel/craftbooks/${c.id}`),
  ];
  if (folderWrites.length > 0) {
    const gate = await store.assertWorkspaceWritable(projectId);
    if (!gate.ok) for (const path of folderWrites) flag('folder-write', path);
  }

  // Crew: a slot the roster fills stays as it is; a slot the older version
  // already had and nobody fills was emptied by the person.
  const roster = await rosterGezels(store, project.gezelIds ?? []);
  const taken = new Set<string>();
  const keptCrew: AppliedCrewMember[] = [];
  const newCrew: ProjectTypeManifest['gezels'] = [];
  for (const ref of next.gezels) {
    const tpl = await catalog.get('gezel-template', ref.templateId).catch(() => null);
    const role = tpl?.manifest.kind === 'gezel-template' ? tpl.manifest.role : undefined;
    const match = projectTypeCrewMatch(roster, { templateId: ref.templateId, role }, taken);
    if (match) {
      taken.add(match.id);
      keptCrew.push({
        id: match.id,
        name: match.name,
        templateId: ref.templateId,
        voorman: ref.voorman,
        reused: true,
      });
      continue;
    }
    if (!previous || previous.gezels.some((g) => g.templateId === ref.templateId)) continue;
    newCrew.push(ref);
    flag('new-crew', ref.templateId);
  }

  // Tool services: only http-mcp installs; one the person removed stays removed.
  const installed = await store
    .listInstalledToolsets({ kind: 'project', projectId })
    .catch(() => []);
  const newToolsets: InstalledToolset[] = [];
  const deferredToolsets: string[] = [];
  for (const ref of next.toolsets) {
    const detail = await catalog.get('toolset', ref.id, ref.sourceId, undefined).catch(() => null);
    if (
      !detail ||
      detail.manifest.kind !== 'toolset' ||
      detail.manifest.runtime.kind !== 'http-mcp'
    ) {
      deferredToolsets.push(ref.id);
      continue;
    }
    if (installed.some((t) => t.toolsetId === detail.manifest.id)) continue;
    if (!previous || previous.toolsets.some((t) => t.id === ref.id)) continue;
    newToolsets.push({
      toolsetId: detail.manifest.id,
      sourceId: detail.sourceId,
      version: detail.manifest.version,
      installedAt: new Date().toISOString(),
      runtime: detail.manifest.runtime,
    });
    flag('new-toolset', ref.id);
  }

  // Schedules: refresh the hosts that exist, add the ones this version is new
  // in, and never bring back a host the person deleted.
  const hosts = new Set(
    (await store.listProjectTasks(projectId).catch(() => []))
      .map((task) =>
        task.origin?.kind === 'project-type-schedule' && task.origin.typeId === typeId
          ? task.origin.scheduleKey
          : null,
      )
      .filter((key): key is string => key !== null),
  );
  const previousKeys = previous
    ? new Set(projectTypeScheduleKeys(previous).map((k) => k.key))
    : null;
  const scheduleKeys = new Set<string>();
  const newSchedules: string[] = [];
  for (const { key, schedule } of projectTypeScheduleKeys(next)) {
    if (hosts.has(key)) {
      scheduleKeys.add(key);
      continue;
    }
    if (previousKeys === null || previousKeys.has(key)) continue;
    scheduleKeys.add(key);
    newSchedules.push(schedule.craftbook);
    if (schedule.consent === 'auto') flag('new-schedule', schedule.craftbook);
  }

  const settings = upgradeProjectTypeSettings({
    previous: previous ? projectTypeDeclaredSettings(previous) : null,
    next: projectTypeDeclaredSettings(next),
    current: projectTypeCurrentSettings(project),
  });

  const plan: ProjectTypeUpgradePlan = {
    projectId,
    typeId,
    typeName: next.name,
    source,
    fromVersion: provenance.version,
    toVersion: next.version,
    automatic: needsOk.size === 0,
    needsOk: [...needsOk.entries()].map(([kind, items]) => ({ kind, items })),
    changes: {
      page: await pageChanged(catalog, source, previous, next),
      scripts: scripts.map((s) => ({ name: s.name, change: s.change })),
      seeds: seeds.map((s) => ({ path: s.recordPath, state: s.state })),
      craftbooks: craftbooks
        .filter((c) => c.change === 'install' || c.change === 'update')
        .map((c) => c.id),
      about: about.change,
      mission: mission.change,
      crew: newCrew.map((ref) => ref.templateId),
      toolsets: newToolsets.map((t) => t.toolsetId),
      schedules: newSchedules,
      settings: settings.changed,
    },
  };

  return {
    plan,
    project,
    provenance,
    previous,
    next,
    moving,
    params,
    overlay,
    seedPolicy,
    scripts,
    seeds,
    about,
    mission,
    craftbooks,
    keptCrew,
    newCrew,
    newToolsets,
    deferredToolsets,
    scheduleKeys,
    settings,
  };
}

/**
 * The update a project could take now, or null when it runs the newest
 * version of its major (or its app no longer resolves). `toVersion` asks
 * about one specific version instead.
 */
export async function planProjectTypeUpgrade(
  deps: ApplyProjectTypeDeps,
  projectId: string,
  opts?: { toVersion?: string },
): Promise<ProjectTypeUpgradePlan | null> {
  const project = await deps.store.getProject(projectId);
  const provenance = project?.projectType;
  if (!project || !provenance) return null;
  const target = await resolveUpdateTarget(deps.catalog, provenance, opts?.toVersion, false);
  if (!target) return null;
  return (await analyzeUpdate(deps, project, provenance, target, {})).plan;
}

/** Update a project's app, holding the per-project apply lock. */
export async function applyProjectTypeUpdate(
  deps: ApplyProjectTypeDeps,
  input: ProjectTypeUpdateInput,
): Promise<AppliedProjectType> {
  return withProjectTypeApplyLock(deps.home, input.projectId, () =>
    applyProjectTypeUpdateUnlocked(deps, input),
  );
}

/** {@link applyProjectTypeUpdate} for a caller that already holds the lock. */
export async function applyProjectTypeUpdateUnlocked(
  deps: ApplyProjectTypeDeps,
  input: ProjectTypeUpdateInput,
): Promise<AppliedProjectType> {
  const { store, catalog, home } = deps;
  const { projectId } = input;
  const project = await store.getProject(projectId);
  if (!project) throw new Error(`project ${projectId} not found`);
  const provenance = project.projectType;
  if (!provenance) throw new Error(`project ${projectId} runs no project type`);
  const target = await resolveUpdateTarget(catalog, provenance, input.version, true);
  if (!target) throw new Error(`project type ${provenance.id} not found`);
  const a = await analyzeUpdate(deps, project, provenance, target, input);
  if (a.plan.needsOk.length > 0 && input.personApproved !== true) {
    throw new ProjectTypeUpgradeNeedsOkError(a.plan);
  }
  const userInitiated = input.personApproved === true;
  const typeId = provenance.id;
  const { next } = a;

  // 1. Scripts. An edited one is saved where the person can find it first.
  const scriptsInstalled: string[] = [];
  const scriptsBackedUp: { name: string; path: string }[] = [];
  for (const step of a.scripts) {
    if (step.change === 'unchanged') continue;
    if (step.change === 'replace-edited' && step.existing !== null) {
      const path = await store.writeProjectArtifactBinary(
        projectId,
        `app-updates/${typeId}/${provenance.version}/${step.name}.ts`,
        Buffer.from(step.existing, 'utf8'),
      );
      scriptsBackedUp.push({ name: step.name, path });
    }
    const dest = projectScriptFile(home, projectId, step.name);
    await mkdir(dirname(dest), { recursive: true });
    await writeFileAtomic(dest, step.content);
    scriptsInstalled.push(step.name);
  }

  // 2. Crew a new version adds (approved).
  const hired: AppliedCrewMember[] = [];
  if (a.newCrew.length > 0) {
    const install = await store.listGezels().catch(() => []);
    const pool = await crewPool({ ...deps, installGezels: install }, project.gezelIds ?? []);
    const taken = new Set(a.keptCrew.map((member) => member.id));
    const namesInUse = gezelNamesInUse(install);
    for (const ref of a.newCrew) {
      const member = await fillCrewSlot(deps, { projectId, typeId, ref, pool, taken, namesInUse });
      if (member) hired.push(member);
    }
  }
  const voormanGezelId =
    project.voormanGezelId ?? [...a.keptCrew, ...hired].find((m) => m.voorman)?.id;

  // 3. Craftbooks.
  const craftbooksInstalled: string[] = [];
  const craftbooksFailed: string[] = [];
  for (const planned of a.craftbooks) {
    if (planned.change === 'failed') craftbooksFailed.push(planned.id);
    if ((planned.change !== 'install' && planned.change !== 'update') || !planned.book) continue;
    try {
      await writeProjectTypeCraftbook(
        { store },
        { projectId, typeId, typeVersion: next.version },
        planned.book,
        userInitiated ? { userInitiated: true } : undefined,
      );
      craftbooksInstalled.push(planned.id);
    } catch (err) {
      log.warn(
        `[upgrade] craftbook '${planned.id}' in ${projectId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      craftbooksFailed.push(planned.id);
    }
  }

  // 4. Seeds.
  const appliedAt = new Date().toISOString();
  const workspaceSeeded: string[] = [];
  const seedsSkipped: string[] = [];
  const overlaySeeds: AppliedSeedRecord[] = [];
  let workspaceDir: string | undefined;
  for (const seed of a.seeds) {
    const record: AppliedSeedRecord = {
      path: seed.recordPath,
      sha256: sha256Hex(seed.rendered),
      typeVersion: next.version,
      writtenAt: appliedAt,
    };
    if (seed.state === 'keep-modified') {
      seedsSkipped.push(seed.recordPath);
      if (seed.prior) overlaySeeds.push(seed.prior);
      continue;
    }
    if (seed.state === 'unchanged') {
      overlaySeeds.push(record);
      continue;
    }
    let base: string;
    if (seed.area === 'artifacts') {
      base = store.projectArtifactsDir(projectId);
    } else {
      if (workspaceDir === undefined) {
        const gate = await store.assertWorkspaceWritable(
          projectId,
          userInitiated ? { userInitiated: true } : undefined,
        );
        if (!gate.ok) throw new Error(`project ${projectId}: workspace is not writable`);
        workspaceDir = gate.workspaceDir;
      }
      base = workspaceDir;
    }
    const dest = safeJoin(base, seed.rel);
    if (!dest) continue;
    await mkdir(dirname(dest), { recursive: true });
    await writeFileAtomic(dest, seed.rendered);
    workspaceSeeded.push(seed.recordPath);
    overlaySeeds.push(record);
  }

  // 5. Tool services a new version adds (approved).
  if (a.newToolsets.length > 0) {
    const scope = { kind: 'project' as const, projectId };
    const current = await store.listInstalledToolsets(scope);
    await store.writeInstalledToolsets(scope, [...current, ...a.newToolsets]);
  }

  // 6. Schedules.
  const scheduleResult = await materializeProjectTypeSchedules(
    { store, catalog },
    {
      projectId,
      typeId,
      manifest: next,
      ...(voormanGezelId ? { voormanGezelId } : {}),
      only: a.scheduleKeys,
    },
  );

  // 7. Overlay.
  const scriptRecords: AppliedScriptRecord[] = a.scripts.map((step) => ({
    name: step.name,
    sha256: sha256Hex(step.content),
    typeVersion: next.version,
  }));
  const docs: NonNullable<ProjectTypeOverlay['docs']> = {
    ...(a.about.record ? { about: a.about.record } : {}),
    ...(a.mission.record ? { mission: a.mission.record } : {}),
  };
  await store.writeProjectTypeOverlay(projectId, {
    schemaVersion: 1,
    typeId,
    typeVersion: next.version,
    appliedAt,
    seeds: overlaySeeds,
    scripts: scriptRecords,
    ...(Object.keys(docs).length > 0 ? { docs } : {}),
  });

  // 8. The stamp, last.
  const pinned = input.pin ?? (a.moving ? undefined : provenance.pinned);
  const params = Object.keys(a.params).length > 0 ? a.params : undefined;
  const settings = a.settings.values;
  await store.updateProject(
    projectId,
    {
      projectType: {
        id: typeId,
        version: next.version,
        source: provenance.source,
        icon: projectTypeIcon(next),
        ...(next.category ? { category: next.category } : {}),
        ...(params ? { params } : {}),
        appliedAt: provenance.appliedAt,
        ...(pinned ? { pinned: true } : {}),
      },
      ...(a.about.change === 'replace' && a.about.rendered !== undefined
        ? { about: a.about.rendered }
        : {}),
      ...(a.mission.change === 'replace' && a.mission.rendered !== undefined
        ? { missionObjectives: a.mission.rendered }
        : {}),
      ...(!project.voormanGezelId && voormanGezelId ? { voormanGezelId } : {}),
      ...(settings.mode !== undefined ? { mode: settings.mode } : {}),
      ...(settings.leadLabel !== undefined ? { leadLabel: settings.leadLabel } : {}),
      ...(settings.leanProfile !== undefined ? { leanProfile: settings.leanProfile } : {}),
      ...(settings.indexingEnabled !== undefined
        ? { indexingEnabled: settings.indexingEnabled }
        : {}),
      ...(settings.meesterManaged !== undefined
        ? { nudgeConfig: { ...project.nudgeConfig, enabled: settings.meesterManaged } }
        : {}),
      ...(settings.tabVisibility !== undefined ? { tabVisibility: settings.tabVisibility } : {}),
    },
    { preserveUpdatedAt: true },
  );

  if (a.moving) {
    log.info(
      `[upgrade] ${projectId}: ${typeId} ${provenance.version} -> ${next.version} (scripts ${scriptsInstalled.length}, seeds ${workspaceSeeded.length}, kept ${seedsSkipped.length})`,
    );
  }

  return {
    typeId,
    version: next.version,
    source: provenance.source,
    gezelsCreated: [...a.keptCrew, ...hired],
    scriptsInstalled,
    workspaceSeeded,
    seedsSkipped,
    toolsetsInstalled: a.newToolsets.map((t) => t.toolsetId),
    toolsBound: next.tools.map((t) => t.name),
    craftbooksInstalled,
    schedulesCreated: scheduleResult.schedules,
    aboutRendered: a.about.change === 'replace',
    missionRendered: a.mission.change === 'replace',
    deferred: {
      toolsets: a.deferredToolsets,
      craftbooks: craftbooksFailed,
      pages: next.pages !== undefined,
      schedules: scheduleResult.failed,
    },
    ...(a.moving ? { upgradedFrom: provenance.version } : {}),
    ...(scriptsBackedUp.length > 0 ? { scriptsBackedUp } : {}),
  };
}
