import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type AppliedProjectType,
  type AppliedScriptRecord,
  type AppliedSeedRecord,
  type InstalledToolset,
  type ProjectTypeApplyPlan,
  type ProjectTypeOverlay,
  type ProjectTypeProvenance,
  type ProjectTypeSeedState,
  type ProjectTypeStatusResponse,
  createLogger,
  gezelNamesInUse,
  projectTypeCrewMatch,
  projectTypeIcon,
  projectTypeScriptHeader,
  renderProjectTypeTemplate,
  seedParamDefaults,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { safeJoin } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import { ALWAYS_REGISTERED_TOOLS, CONDITIONALLY_REGISTERED_TOOLS } from '@bendyline/gezel-mcp';
import type { Store } from '../fs/store.js';
import { installProjectTypeScripts } from '../scripts/install.js';
import { parseCron } from '../tasks/cron.js';
import {
  type AppliedCrewMember,
  type ApplyProjectTypeDeps,
  classifySeed,
  crewPool,
  docFingerprint,
  fillCrewSlot,
  materializeProjectTypeSchedules,
  parseTemplateFrontmatter,
  resolveProjectType,
  semverGreater,
  sha256Hex,
  withProjectTypeApplyLock,
} from './apply-common.js';
import { installProjectTypeCraftbooks, resolveTypeCraftbook } from './craftbooks.js';
import { listGezapps } from './gezapp.js';
import { applyProjectTypeUpdateUnlocked, planProjectTypeUpgrade } from './upgrade.js';

const log = createLogger('project-type');

export type { ApplyProjectTypeDeps } from './apply-common.js';
export { materializeProjectTypeSchedules } from './apply-common.js';

export interface ApplyProjectTypeInput {
  projectId: string;
  typeId: string;
  /** Explicit version pin; default = catalog's auto-resolved latest. */
  version?: string;
  /** Param values collected at adoption, substituted into templates + seed files. */
  params?: Record<string, unknown>;
  /**
   * Seed collision policy. `overwrite` writes every declared seed (the
   * default for a first apply). `preserve` keeps user-modified files
   * (reported in `seedsSkipped`), judged against the overlay manifest; it is
   * the default when the project already runs this type.
   */
  seedPolicy?: 'overwrite' | 'preserve';
  /**
   * Fill the crew with gezels the user already has (default true); `false`
   * hires fresh. Lean types reuse regardless.
   */
  reuseRosterGezels?: boolean;
  /**
   * `fresh` outfits the project from scratch. `upgrade` moves a project that
   * already runs this type to `version` (default: the newest version of the
   * same major in the project's own catalog source, else a refresh of the
   * version it runs), keeping the person's data, edits and settings — see
   * `upgrade.ts`. Default: `upgrade` when the project already runs `typeId`.
   */
  mode?: 'fresh' | 'upgrade';
  /**
   * The person approved this apply with their own click. An update that
   * would replace an edited script, add crew, connect a tool service, start
   * a recurring run or write into a folder Gezel holds no grant for is
   * refused without it (`ProjectTypeUpgradeNeedsOkError`). Never set from a
   * model-reachable surface.
   */
  personApproved?: boolean;
  /** Keep the project on this version; automatic app updates skip it. */
  pin?: boolean;
}

export { renderProjectTypeTemplate, seedParamDefaults };

/**
 * Resolve and validate every catalog dependency needed by a project type
 * before an atomic create starts writing its staging area. Existing-project
 * apply remains tolerant of missing optional catalog material; a brand-new
 * typed project must either be complete or not exist at all.
 */
export async function preflightProjectType(
  deps: { catalog: CatalogService },
  input: Pick<ApplyProjectTypeInput, 'typeId' | 'version'>,
): Promise<void> {
  const { manifest, source } = await resolveProjectType(deps.catalog, input.typeId, input.version);

  for (const rel of [manifest.aboutTemplate, manifest.missionTemplate].filter(
    (value): value is string => typeof value === 'string',
  )) {
    if (!safeJoin('/gezel-project-type-preflight', rel)) {
      throw new Error(`project type ${input.typeId}: unsafe template path ${rel}`);
    }
    const file = await deps.catalog.readItemFile(
      'project-type',
      input.typeId,
      rel,
      source,
      manifest.version,
    );
    if (!file) throw new Error(`project type ${input.typeId}: template file ${rel} not found`);
  }

  for (const ref of manifest.gezels) {
    const template = await deps.catalog.get('gezel-template', ref.templateId);
    if (!template || template.manifest.kind !== 'gezel-template') {
      throw new Error(`project type ${input.typeId}: gezel template ${ref.templateId} not found`);
    }
    parseTemplateFrontmatter(template.manifest.frontmatter);
  }

  for (const rel of [...manifest.workspaceSeed, ...manifest.artifactsSeed]) {
    if (!safeJoin('/gezel-project-type-preflight', rel)) {
      throw new Error(`project type ${input.typeId}: unsafe seed path ${rel}`);
    }
    const file = await deps.catalog.readItemFile(
      'project-type',
      input.typeId,
      rel,
      source,
      manifest.version,
    );
    if (!file) throw new Error(`project type ${input.typeId}: seed file ${rel} not found`);
  }

  for (const name of Object.keys(manifest.scripts ?? {})) {
    if (!safeJoin('/gezel-project-type-preflight', `${name}.ts`)) {
      throw new Error(`project type ${input.typeId}: unsafe script name ${name}`);
    }
  }

  for (const id of manifest.craftbooks) {
    const book = await resolveTypeCraftbook(
      deps.catalog,
      { typeId: input.typeId, typeVersion: manifest.version, source },
      id,
      new Date().toISOString(),
    );
    if (!book) {
      throw new Error(
        `project type ${input.typeId}: craftbook ${id} resolves nowhere (no embedded craftbooks/${id}.json and no catalog template)`,
      );
    }
  }

  const reservedToolNames = new Set<string>([
    ...ALWAYS_REGISTERED_TOOLS,
    ...Object.keys(CONDITIONALLY_REGISTERED_TOOLS),
  ]);
  for (const tool of manifest.tools) {
    if (!manifest.scripts?.[tool.script]) {
      throw new Error(
        `project type ${input.typeId}: tool ${tool.name} references undeclared script ${tool.script}`,
      );
    }
    if (reservedToolNames.has(tool.name)) {
      throw new Error(
        `project type ${input.typeId}: tool name ${tool.name} collides with a builtin tool`,
      );
    }
  }

  for (const schedule of manifest.schedules) {
    // Night-shift schedules carry no user cron — the host runs on an
    // internal heartbeat confined to the Night Shift window.
    if (schedule.runMode !== 'night-shift') {
      try {
        parseCron(schedule.cron ?? '');
      } catch (err) {
        throw new Error(
          `project type ${input.typeId}: schedule cron "${schedule.cron}" is invalid: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    if (!manifest.craftbooks.includes(schedule.craftbook)) {
      throw new Error(
        `project type ${input.typeId}: schedule references craftbook ${schedule.craftbook}, which is not declared in craftbooks[]`,
      );
    }
  }
}

/**
 * Instantiate a custom project type onto an existing project: render its
 * about/mission templates, create its gezels from gilde templates (setting the
 * voorman), install its SDK scripts with provenance markers, seed its
 * workspace data files, and stamp `projectType` provenance on `project.json`.
 *
 * Applying the type a project already runs is an update (`upgrade.ts`): it
 * moves the project to a newer version of the same major, or refreshes the
 * one it runs, keeping the person's data, edits and settings. Pass
 * `mode: 'fresh'` to outfit from scratch regardless. See docs/project-types.md.
 */
export async function applyProjectType(
  deps: ApplyProjectTypeDeps,
  input: ApplyProjectTypeInput,
): Promise<AppliedProjectType> {
  return withProjectTypeApplyLock(deps.home, input.projectId, async () => {
    const project = await deps.store.getProject(input.projectId);
    if (!project) throw new Error(`project ${input.projectId} not found`);
    const mode = input.mode ?? (project.projectType?.id === input.typeId ? 'upgrade' : 'fresh');
    if (mode === 'upgrade' && project.projectType?.id === input.typeId) {
      return applyProjectTypeUpdateUnlocked(deps, {
        projectId: input.projectId,
        ...(input.version !== undefined ? { version: input.version } : {}),
        ...(input.params !== undefined ? { params: input.params } : {}),
        ...(input.seedPolicy !== undefined ? { seedPolicy: input.seedPolicy } : {}),
        ...(input.personApproved !== undefined ? { personApproved: input.personApproved } : {}),
        ...(input.pin !== undefined ? { pin: input.pin } : {}),
      });
    }
    return applyFresh(deps, input, project);
  });
}

async function applyFresh(
  deps: ApplyProjectTypeDeps,
  input: ApplyProjectTypeInput,
  project: NonNullable<Awaited<ReturnType<Store['getProject']>>>,
): Promise<AppliedProjectType> {
  const { store, catalog, home } = deps;
  const { projectId, typeId, version } = input;

  const { manifest, source } = await resolveProjectType(catalog, typeId, version);

  // The type owns its param defaults — apply them under the caller's values so
  // an omitted param still renders (no leftover `{{placeholder}}`).
  const params = { ...seedParamDefaults(manifest.params), ...(input.params ?? {}) };

  // 1. Render about / mission templates (param-substituted).
  let renderedAbout: string | undefined;
  let renderedMission: string | undefined;
  if (manifest.aboutTemplate) {
    const buf = await catalog.readItemFile(
      'project-type',
      typeId,
      manifest.aboutTemplate,
      source,
      manifest.version,
    );
    if (buf) renderedAbout = renderProjectTypeTemplate(buf.toString('utf8'), params);
  }
  if (manifest.missionTemplate) {
    const buf = await catalog.readItemFile(
      'project-type',
      typeId,
      manifest.missionTemplate,
      source,
      manifest.version,
    );
    if (buf) renderedMission = renderProjectTypeTemplate(buf.toString('utf8'), params);
  }

  // 2. Set up the roster gezels from gilde templates; remember which is
  // voorman. A slot someone the user already has can fill goes to them — the
  // checkers Damspeler is ONE recurring opponent across every game, not a new
  // stranger per project, and a new Social Feed project gets the Omroeper
  // the user already works with. Reuse keeps the existing character
  // (including any rename); per-project personality varies through params.
  const gezelsCreated: AppliedProjectType['gezelsCreated'] = [];
  let voormanGezelId: string | undefined;
  const reuse = manifest.leanProfile || input.reuseRosterGezels !== false;
  const install = deps.installGezels ?? (await store.listGezels().catch(() => []));
  const pool = reuse
    ? await crewPool({ ...deps, installGezels: install }, project.gezelIds ?? [])
    : [];
  const namesInUse = gezelNamesInUse(install);
  const taken = new Set<string>();
  for (const ref of manifest.gezels) {
    const member: AppliedCrewMember | null = await fillCrewSlot(deps, {
      projectId,
      typeId,
      ref,
      pool,
      taken,
      namesInUse,
    });
    if (!member) continue;
    gezelsCreated.push(member);
    if (ref.voorman && !voormanGezelId) voormanGezelId = member.id;
  }

  // 3. Install SDK scripts with provenance markers.
  const { installed: scriptsInstalled } = await installProjectTypeScripts(
    home,
    projectId,
    typeId,
    manifest.version,
    manifest.scripts,
  );
  const overlayScripts: AppliedScriptRecord[] = Object.entries(manifest.scripts ?? {}).map(
    ([name, body]) => ({
      name,
      sha256: sha256Hex(`${projectTypeScriptHeader(typeId, manifest.version)}${body}`),
      typeVersion: manifest.version,
    }),
  );

  // 3b. Copy-install the type's craftbooks into the project's workspace
  //     (`.gezel/craftbooks/`), provenance-stamped. MUST precede schedule
  //     materialization — schedules resolve their spawn book from the
  //     project scope. Idempotent; user-modified copies are left alone.
  const craftbookInstall =
    manifest.craftbooks.length > 0
      ? await installProjectTypeCraftbooks(
          { store, catalog },
          {
            projectId,
            typeId,
            typeVersion: manifest.version,
            source,
            craftbookIds: manifest.craftbooks,
          },
        )
      : { installed: [], skipped: [], failed: [] };

  // 4. Seed workspace + artifact data files (param-substituted). Under
  //    `seedPolicy: 'preserve'` a file the user modified since the app last
  //    wrote it is kept (reported in `seedsSkipped`); everything written or
  //    confirmed app-owned is recorded in the overlay manifest so the NEXT
  //    apply can make the same distinction.
  const seedPolicy = input.seedPolicy ?? 'overwrite';
  const priorOverlay = await store.readProjectTypeOverlay(projectId);
  const priorSeedByPath = new Map(
    (priorOverlay?.seeds ?? []).map((seed) => [seed.path, seed] as const),
  );
  const appliedAt = new Date().toISOString();
  const workspaceSeeded: string[] = [];
  const seedsSkipped: string[] = [];
  const overlaySeeds: AppliedSeedRecord[] = [];

  const applySeed = async (rel: string, baseDir: string, recordPath: string): Promise<void> => {
    const buf = await catalog.readItemFile('project-type', typeId, rel, source, manifest.version);
    if (!buf) {
      log.warn(`[apply] project type ${typeId}: seed file ${rel} not found — skipping`);
      return;
    }
    const dest = safeJoin(baseDir, rel);
    if (!dest) {
      log.warn(`[apply] project type ${typeId}: unsafe seed path ${rel} — skipping`);
      return;
    }
    const rendered = renderProjectTypeTemplate(buf.toString('utf8'), params);
    const renderedSha = sha256Hex(rendered);
    const prior = priorSeedByPath.get(recordPath);
    const record: AppliedSeedRecord = {
      path: recordPath,
      sha256: renderedSha,
      typeVersion: manifest.version,
      writtenAt: appliedAt,
    };
    const existing = seedPolicy === 'preserve' ? await readFile(dest).catch(() => null) : null;
    const state =
      seedPolicy === 'preserve'
        ? classifySeed({ existing, renderedSha, priorSha: prior?.sha256, policy: seedPolicy })
        : 'update';
    if (state === 'keep-modified') {
      seedsSkipped.push(recordPath);
      // The app's last-written content is still whatever the old overlay
      // recorded — carry that forward, never claim the user's bytes.
      if (prior) overlaySeeds.push(prior);
      return;
    }
    if (state === 'unchanged') {
      overlaySeeds.push(record);
      return;
    }
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, rendered, 'utf8');
    workspaceSeeded.push(recordPath);
    overlaySeeds.push(record);
  };

  if (manifest.workspaceSeed.length > 0) {
    const workspaceDir = await store.projectWorkspaceDir(projectId);
    for (const rel of manifest.workspaceSeed) {
      await applySeed(rel, workspaceDir, rel);
    }
  }

  // 4b. Artifact seeds, for types whose output lives in `artifacts/` —
  //     e.g. a design gallery reading a starter palette.
  if (manifest.artifactsSeed.length > 0) {
    const artifactsDir = store.projectArtifactsDir(projectId);
    for (const rel of manifest.artifactsSeed) {
      await applySeed(rel, artifactsDir, `artifacts/${rel}`);
    }
  }

  // 5. Register the type's toolsets into the PROJECT scope. Only http-mcp
  //    installs on adoption (it's just a URL — no code download, consistent
  //    with the adoption being the consent point). npm-package (code download)
  //    and builtin (needs a per-gezel group unlock) are surfaced as deferred
  //    so the user installs them explicitly.
  const toolsetsInstalled: string[] = [];
  const toolsetsDeferred: string[] = [];
  if (manifest.toolsets.length > 0) {
    const existing = await store.listInstalledToolsets({ kind: 'project', projectId });
    const next = [...existing];
    for (const ref of manifest.toolsets) {
      const tsDetail = await catalog.get('toolset', ref.id, ref.sourceId, undefined);
      if (!tsDetail || tsDetail.manifest.kind !== 'toolset') {
        log.warn(`[apply] project type ${typeId}: toolset ${ref.id} not found — skipping`);
        toolsetsDeferred.push(ref.id);
        continue;
      }
      const tm = tsDetail.manifest;
      if (tm.runtime.kind !== 'http-mcp') {
        toolsetsDeferred.push(ref.id);
        continue;
      }
      const record: InstalledToolset = {
        toolsetId: tm.id,
        sourceId: tsDetail.sourceId,
        version: tm.version,
        installedAt: new Date().toISOString(),
        runtime: tm.runtime,
      };
      const idx = next.findIndex((t) => t.toolsetId === tm.id);
      if (idx >= 0) next[idx] = record;
      else next.push(record);
      toolsetsInstalled.push(tm.id);
    }
    if (toolsetsInstalled.length > 0) {
      await store.writeInstalledToolsets({ kind: 'project', projectId }, next);
    }
  }

  // 6. Stamp provenance + inherited taxonomy id + rendered docs + voorman.
  //    Project types may also set defaults for ambient Meester progress
  //    check-ins, optional tab visibility, and workspace indexing. Only write
  //    settings the manifest declares, preserving existing project overrides
  //    otherwise.
  const provenance: ProjectTypeProvenance = {
    id: typeId,
    version: manifest.version,
    source,
    icon: projectTypeIcon(manifest),
    ...(manifest.category ? { category: manifest.category } : {}),
    ...(params && Object.keys(params).length > 0 ? { params } : {}),
    appliedAt: new Date().toISOString(),
    ...(input.pin ? { pinned: true } : {}),
  };
  await store.updateProject(projectId, {
    projectType: provenance,
    // A custom type that `extends` a taxonomy id inherits detection-based
    // craftbook suggestion by setting the override.
    ...(manifest.extends ? { projectTypeId: manifest.extends } : {}),
    ...(renderedAbout !== undefined ? { about: renderedAbout } : {}),
    ...(renderedMission !== undefined ? { missionObjectives: renderedMission } : {}),
    ...(voormanGezelId ? { voormanGezelId } : {}),
    // Solo types (games, the chat room) run in single-gezel mode: the one
    // roster gezel IS the lead, no separate voorman is recruited, and the
    // picker collapses. Runs after createProject in the staged store, so
    // the manifest wins over the request's mode for an inherently-solo type.
    ...(manifest.mode ? { mode: manifest.mode } : {}),
    ...(manifest.leadLabel ? { leadLabel: manifest.leadLabel } : {}),
    ...(manifest.leanProfile !== undefined ? { leanProfile: manifest.leanProfile } : {}),
    ...(manifest.indexingEnabled !== undefined
      ? { indexingEnabled: manifest.indexingEnabled }
      : {}),
    ...(manifest.meesterManaged !== undefined
      ? {
          nudgeConfig: {
            ...project.nudgeConfig,
            enabled: manifest.meesterManaged,
          },
        }
      : {}),
    ...(manifest.tabVisibility !== undefined
      ? {
          tabVisibility: {
            ...project.tabVisibility,
            ...manifest.tabVisibility,
          },
        }
      : {}),
  });

  // 7. Materialize declared schedules as cron host tasks — after the project
  //    update so the voorman assignment is final, and after craftbook install
  //    so each schedule's spawn book resolves from the project scope.
  const scheduleResult = await materializeProjectTypeSchedules(
    { store, catalog },
    { projectId, typeId, manifest, voormanGezelId },
  );

  // 8. Record the overlay manifest — the durable answer to "which files did
  //    the app deploy here, and what did the app-owned content hash to".
  const docs: NonNullable<ProjectTypeOverlay['docs']> = {
    ...(renderedAbout !== undefined ? { about: { sha256: docFingerprint(renderedAbout) } } : {}),
    ...(renderedMission !== undefined
      ? { mission: { sha256: docFingerprint(renderedMission) } }
      : {}),
  };
  await store.writeProjectTypeOverlay(projectId, {
    schemaVersion: 1,
    typeId,
    typeVersion: manifest.version,
    appliedAt,
    seeds: overlaySeeds,
    scripts: overlayScripts,
    ...(Object.keys(docs).length > 0 ? { docs } : {}),
  });

  return {
    typeId,
    version: manifest.version,
    source,
    gezelsCreated,
    scriptsInstalled,
    workspaceSeeded,
    seedsSkipped,
    toolsetsInstalled,
    toolsBound: manifest.tools.map((t) => t.name),
    craftbooksInstalled: craftbookInstall.installed,
    schedulesCreated: scheduleResult.schedules,
    aboutRendered: renderedAbout !== undefined,
    missionRendered: renderedMission !== undefined,
    deferred: {
      toolsets: toolsetsDeferred,
      craftbooks: craftbookInstall.failed,
      pages: manifest.pages !== undefined,
      schedules: scheduleResult.failed,
    },
  };
}

/**
 * Dry-run report: what an apply with the same input would materialize,
 * computed without writing anything. Runs the same preflight validation the
 * apply engine relies on, so a plan that renders is a plan that can apply.
 */
export async function planProjectTypeApply(
  deps: ApplyProjectTypeDeps,
  input: ApplyProjectTypeInput,
): Promise<ProjectTypeApplyPlan> {
  const { store, catalog } = deps;
  const project = await store.getProject(input.projectId);
  if (!project) throw new Error(`project ${input.projectId} not found`);
  const { manifest, source } = await resolveProjectType(catalog, input.typeId, input.version);
  await preflightProjectType({ catalog }, { typeId: input.typeId, version: manifest.version });
  const params = { ...seedParamDefaults(manifest.params), ...(input.params ?? {}) };
  const policy = input.seedPolicy ?? 'overwrite';

  const reuse = manifest.leanProfile || input.reuseRosterGezels !== false;
  const pool = reuse ? await crewPool(deps, project.gezelIds ?? []) : [];
  const taken = new Set<string>();
  const gezels: ProjectTypeApplyPlan['gezels'] = [];
  for (const ref of manifest.gezels) {
    const tpl = await catalog.get('gezel-template', ref.templateId).catch(() => null);
    const role = tpl?.manifest.kind === 'gezel-template' ? tpl.manifest.role : undefined;
    const match = projectTypeCrewMatch(pool, { templateId: ref.templateId, role }, taken);
    if (match) taken.add(match.id);
    gezels.push({ templateId: ref.templateId, voorman: ref.voorman, reuse: !!match });
  }

  const overlay = await store.readProjectTypeOverlay(input.projectId);
  const priorSeedByPath = new Map((overlay?.seeds ?? []).map((seed) => [seed.path, seed] as const));
  const seeds: ProjectTypeApplyPlan['seeds'] = [];
  const planSeed = async (rel: string, baseDir: string, recordPath: string): Promise<void> => {
    const buf = await catalog.readItemFile(
      'project-type',
      input.typeId,
      rel,
      source,
      manifest.version,
    );
    if (!buf) return;
    const dest = safeJoin(baseDir, rel);
    if (!dest) return;
    const rendered = renderProjectTypeTemplate(buf.toString('utf8'), params);
    const existing = await readFile(dest).catch(() => null);
    seeds.push({
      path: recordPath,
      state: classifySeed({
        existing,
        renderedSha: sha256Hex(rendered),
        priorSha: priorSeedByPath.get(recordPath)?.sha256,
        policy,
      }),
    });
  };
  if (manifest.workspaceSeed.length > 0) {
    const workspaceDir = await store.projectWorkspaceDir(input.projectId);
    for (const rel of manifest.workspaceSeed) await planSeed(rel, workspaceDir, rel);
  }
  if (manifest.artifactsSeed.length > 0) {
    const artifactsDir = store.projectArtifactsDir(input.projectId);
    for (const rel of manifest.artifactsSeed) await planSeed(rel, artifactsDir, `artifacts/${rel}`);
  }

  const installNow: string[] = [];
  const deferred: string[] = [];
  for (const ref of manifest.toolsets) {
    const tsDetail = await catalog.get('toolset', ref.id, ref.sourceId, undefined);
    if (tsDetail?.manifest.kind === 'toolset' && tsDetail.manifest.runtime.kind === 'http-mcp') {
      installNow.push(ref.id);
    } else {
      deferred.push(ref.id);
    }
  }

  return {
    typeId: input.typeId,
    version: manifest.version,
    source,
    gezels,
    scripts: Object.keys(manifest.scripts ?? {}),
    seeds,
    toolsets: { installNow, deferred },
    craftbooks: manifest.craftbooks,
    schedules: manifest.schedules.map((schedule) => ({
      craftbook: schedule.craftbook,
      ...(schedule.cron ? { cron: schedule.cron } : {}),
      consent: schedule.consent,
    })),
    pages: manifest.pages !== undefined,
  };
}

/**
 * The applied type vs the installed AI App, plus per-seed drift against the
 * overlay manifest. Declared seeds with no overlay record report `untracked`
 * (the folder moved machines, or the apply predates overlay tracking).
 */
export async function projectTypeStatus(
  deps: { store: Store; catalog: CatalogService; home: string },
  projectId: string,
): Promise<ProjectTypeStatusResponse> {
  const { store, catalog } = deps;
  const project = await store.getProject(projectId);
  if (!project) throw new Error(`project ${projectId} not found`);
  const provenance = project.projectType ?? null;

  let installedApp: ProjectTypeStatusResponse['installedApp'] = null;
  if (provenance) {
    const apps = await listGezapps(deps.home);
    const found = apps.find((app) => app.entry.appId === provenance.id);
    if (found) {
      installedApp = {
        appId: found.entry.appId,
        version: found.entry.version,
        enabled: found.entry.enabled,
      };
    }
  }
  const upgrade = provenance
    ? await planProjectTypeUpgrade(deps, projectId).catch((err) => {
        log.warn(
          `[status] ${projectId}: could not plan an app update: ${err instanceof Error ? err.message : String(err)}`,
        );
        return null;
      })
    : null;
  const updateAvailable = Boolean(
    upgrade ||
      (provenance && installedApp && semverGreater(installedApp.version, provenance.version)),
  );

  const seedDest = async (recordPath: string): Promise<string | null> => {
    if (recordPath.startsWith('artifacts/')) {
      return safeJoin(store.projectArtifactsDir(projectId), recordPath.slice('artifacts/'.length));
    }
    try {
      return safeJoin(await store.projectWorkspaceDir(projectId), recordPath);
    } catch {
      return null;
    }
  };

  const overlay = await store.readProjectTypeOverlay(projectId);
  const seeds: Array<{ path: string; state: ProjectTypeSeedState }> = [];
  for (const record of overlay?.seeds ?? []) {
    const dest = await seedDest(record.path);
    const existing = dest ? await readFile(dest).catch(() => null) : null;
    seeds.push({
      path: record.path,
      state:
        existing === null ? 'missing' : sha256Hex(existing) === record.sha256 ? 'ok' : 'modified',
    });
  }
  if (provenance) {
    try {
      const { manifest } = await resolveProjectType(
        catalog,
        provenance.id,
        provenance.version,
        provenance.source,
      );
      const known = new Set((overlay?.seeds ?? []).map((seed) => seed.path));
      for (const rel of manifest.workspaceSeed) {
        if (!known.has(rel)) seeds.push({ path: rel, state: 'untracked' });
      }
      for (const rel of manifest.artifactsSeed) {
        if (!known.has(`artifacts/${rel}`)) {
          seeds.push({ path: `artifacts/${rel}`, state: 'untracked' });
        }
      }
    } catch {
      // The type no longer resolves (app removed) — overlay-only report.
    }
  }

  return {
    projectId,
    provenance,
    installedApp,
    updateAvailable,
    ...(upgrade ? { latestVersion: upgrade.toVersion } : {}),
    seeds,
  };
}
