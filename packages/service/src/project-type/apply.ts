import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type AppliedProjectType,
  type AppliedSeedRecord,
  type GezelFrontmatter,
  GezelFrontmatterSchema,
  type InstalledToolset,
  type ProjectTypeApplyPlan,
  type ProjectTypeManifest,
  type ProjectTypeProvenance,
  type ProjectTypeSchedule,
  type ProjectTypeSeedState,
  type ProjectTypeStatusResponse,
  type Question,
  type ScheduleMaterialization,
  type SeedPlanState,
  compareSemver,
  createLogger,
  pickRandomNameWithGender,
  projectTypeIcon,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { ALWAYS_REGISTERED_TOOLS, CONDITIONALLY_REGISTERED_TOOLS } from '@bendyline/gezel-mcp';
import { makeCraftbookResolver } from '../craftbook/resolve.js';
import { safeJoin } from '../fs/safe-paths.js';
import type { Store } from '../fs/store.js';
import { installProjectTypeScripts } from '../scripts/install.js';
import { parseCron } from '../tasks/cron.js';
import { TaskManager } from '../tasks/manager.js';
import {
  SCHEDULE_HOST_STEP,
  describeHostCadence,
  hostCronExpression,
  hostRecurrenceFields,
} from '../tasks/schedule-host.js';
import { installProjectTypeCraftbooks, resolveTypeCraftbook } from './craftbooks.js';
import { listGezapps } from './gezapp.js';

const log = createLogger('project-type');

export interface ApplyProjectTypeInput {
  projectId: string;
  typeId: string;
  /** Explicit version pin; default = catalog's auto-resolved latest. */
  version?: string;
  /** Param values collected at adoption, substituted into templates + seed files. */
  params?: Record<string, unknown>;
  /**
   * Seed collision policy. `overwrite` (default — the original behavior)
   * writes every declared seed. `preserve` keeps user-modified files
   * (reported in `seedsSkipped`), judged against the overlay manifest.
   */
  seedPolicy?: 'overwrite' | 'preserve';
  /**
   * Reuse a roster gezel with the same templateId instead of minting a new
   * one — makes re-apply idempotent for non-lean types.
   */
  reuseRosterGezels?: boolean;
}

function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function semverGreater(a: string, b: string): boolean {
  try {
    return compareSemver(a, b) > 0;
  } catch {
    return a !== b && a.localeCompare(b) > 0;
  }
}

/**
 * What one seed apply would do — shared by the real write path and the
 * preflight plan so they can never disagree. `priorSha` is the overlay's
 * record of what the app last wrote to this path.
 */
function classifySeed(args: {
  existing: Buffer | null;
  renderedSha: string;
  priorSha: string | undefined;
  policy: 'overwrite' | 'preserve';
}): SeedPlanState {
  if (args.existing === null) return 'new';
  const existingSha = sha256Hex(args.existing);
  if (existingSha === args.renderedSha) return 'unchanged';
  if (args.policy === 'preserve' && existingSha !== args.priorSha) return 'keep-modified';
  return 'update';
}

/**
 * Seed a param object from the type's JSON-schema `default`s. The type owns
 * its defaults, so the engine applies them under whatever the caller passed —
 * a caller (UI form, MCP) that omits a param still gets its default, rather
 * than leaving `{{placeholder}}` unrendered. Mirrors the launcher's seeding.
 */
export function seedParamDefaults(
  paramSchema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const props = (paramSchema?.properties ?? {}) as Record<
    string,
    { default?: unknown } | undefined
  >;
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(props)) {
    if (def && def.default !== undefined) out[key] = def.default;
  }
  return out;
}

/**
 * Substitute `{{ key }}` placeholders with param values. Unknown placeholders
 * are left untouched (never silently blanked) so a template typo is visible
 * rather than swallowed. Non-string values are JSON-ish stringified.
 */
export function renderProjectTypeTemplate(
  text: string,
  params: Record<string, unknown> | undefined,
): string {
  if (!params) return text;
  return text.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (whole, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) return whole;
    const v = params[key];
    return typeof v === 'string' ? v : v == null ? '' : String(v);
  });
}

/** Parse a gilde template's optional frontmatter extension, or null. */
function parseTemplateFrontmatter(
  raw: Record<string, unknown> | undefined,
): Partial<GezelFrontmatter> | null {
  if (!raw || Object.keys(raw).length === 0) return null;
  const parsed = GezelFrontmatterSchema.parse({ name: '__template__', ...raw });
  const { name: _name, id: _id, ...extras } = parsed;
  return extras;
}

async function resolveProjectType(
  catalog: CatalogService,
  typeId: string,
  version?: string,
): Promise<{ manifest: ProjectTypeManifest; source: string }> {
  const detail = await catalog.get('project-type', typeId, undefined, version);
  if (!detail || detail.manifest.kind !== 'project-type') {
    throw new Error(
      version ? `project type ${typeId}@${version} not found` : `project type ${typeId} not found`,
    );
  }
  return { manifest: detail.manifest, source: detail.sourceId };
}

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
 * Idempotent-ish: re-applying re-renders docs and re-installs scripts (the
 * script installer no-ops on unchanged bodies), and re-creating a gezel whose
 * slug already exists is surfaced by the Store. Toolsets, script-tools, Output
 * pages, and schedules are recorded in the returned `deferred` set — their
 * materialization lands in later phases. See docs/project-types.md.
 */
export async function applyProjectType(
  deps: { store: Store; catalog: CatalogService; home: string },
  input: ApplyProjectTypeInput,
): Promise<AppliedProjectType> {
  const { store, catalog, home } = deps;
  const { projectId, typeId, version } = input;

  const project = await store.getProject(projectId);
  if (!project) throw new Error(`project ${projectId} not found`);

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
  // voorman. For lean singleton types (games, chat-room personas) REUSE an
  // existing global gezel from the same template instead of minting a fresh
  // one every time: a game's opponent — the checkers Damspeler — should be
  // ONE recurring character across every game you start, not a new stranger
  // per project (which is how you end up with four Damspelers, none of them
  // clearly "the" opponent). Reuse keeps the existing character (including
  // any rename); the per-project personality still varies through the
  // reaction params, not the gezel.
  const gezelsCreated: AppliedProjectType['gezelsCreated'] = [];
  let voormanGezelId: string | undefined;
  const reusePool = manifest.leanProfile ? await store.listGezels().catch(() => []) : [];
  // Non-lean re-apply reuse (opt-in): a roster gezel from the same template
  // is this project's instance of that role — minting another one per apply
  // is exactly the duplicate-Damspeler failure, one project down.
  const rosterPool =
    !manifest.leanProfile && input.reuseRosterGezels
      ? (
          await Promise.all(
            (project.gezelIds ?? []).map((id) => store.getGezel(id).catch(() => null)),
          )
        ).filter((g) => g !== null)
      : [];
  for (const ref of manifest.gezels) {
    const reused = manifest.leanProfile
      ? reusePool.find((g) => g.templateId === ref.templateId)
      : rosterPool.find((g) => g.templateId === ref.templateId);
    let gezelId: string;
    let gezelName: string;
    if (reused) {
      gezelId = reused.id;
      gezelName = reused.name;
    } else {
      const tpl = await catalog.get('gezel-template', ref.templateId);
      if (!tpl || tpl.manifest.kind !== 'gezel-template') {
        log.warn(
          `[apply] project type ${typeId}: gezel template ${ref.templateId} not found — skipping`,
        );
        continue;
      }
      const { name, gender } = pickRandomNameWithGender();
      const extraFrontmatter = parseTemplateFrontmatter(tpl.manifest.frontmatter);
      const created = await store.createGezel({
        name,
        role: tpl.manifest.role,
        about: tpl.about ?? '',
        gender,
        templateId: ref.templateId,
        templateVersion: tpl.manifest.version,
        ...(extraFrontmatter ? { frontmatter: extraFrontmatter } : {}),
      });
      gezelId = created.id;
      gezelName = created.name;
    }
    gezelsCreated.push({
      id: gezelId,
      name: gezelName,
      templateId: ref.templateId,
      voorman: ref.voorman,
    });
    if (ref.voorman && !voormanGezelId) voormanGezelId = gezelId;
    // The type's crew belongs on the project roster — that is what makes a
    // later `reuseRosterGezels` re-apply idempotent for every role, not
    // just the voorman (whose roster join rides the provenance update).
    await store.addGezelToProject(projectId, gezelId, { source: 'project-type' }).catch((err) => {
      log.warn(`[apply] roster add failed for ${projectId}/${gezelId}: ${String(err)}`);
    });
  }

  // 3. Install SDK scripts with provenance markers.
  const { installed: scriptsInstalled } = await installProjectTypeScripts(
    home,
    projectId,
    typeId,
    manifest.version,
    manifest.scripts,
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
    ...(params && Object.keys(params).length > 0 ? { params } : {}),
    appliedAt: new Date().toISOString(),
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
  await store.writeProjectTypeOverlay(projectId, {
    schemaVersion: 1,
    typeId,
    typeVersion: manifest.version,
    appliedAt,
    seeds: overlaySeeds,
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
 * Turn a type's declared `schedules[]` into schedule-host tasks
 * (`{cron, spawnsCraftbook, assignee}`) on the existing task engine.
 * Consent rule from docs/project-types.md — never silently armed:
 * `auto` → active; `ask` → paused + a `schedule-approval` question;
 * `disabled` → paused, no question. Idempotent via `Task.origin`:
 * re-apply refreshes a changed cron but never touches the user's
 * arm/disarm decision and never re-asks an answered question.
 */
export async function materializeProjectTypeSchedules(
  deps: { store: Store; catalog: CatalogService },
  args: {
    projectId: string;
    typeId: string;
    manifest: ProjectTypeManifest;
    voormanGezelId?: string;
  },
): Promise<{ schedules: ScheduleMaterialization[]; failed: number }> {
  const { store, catalog } = deps;
  const { projectId, typeId, manifest } = args;
  if (manifest.schedules.length === 0) return { schedules: [], failed: 0 };

  // Apply-owned manager over the SAME store instance: task numbering
  // serializes through the store's per-project locks, and on the atomic
  // create path the hosts + questions land inside the staged project dir
  // and ride the publish (crash-safety inherited from the transaction).
  const tasks = new TaskManager(store);
  tasks.setCraftbookResolver(makeCraftbookResolver(store, catalog));

  const existing = await store.listProjectTasks(projectId).catch(() => []);
  const out: ScheduleMaterialization[] = [];
  let failed = 0;
  const keyCounts = new Map<string, number>();

  for (const schedule of manifest.schedules) {
    const n = (keyCounts.get(schedule.craftbook) ?? 0) + 1;
    keyCounts.set(schedule.craftbook, n);
    const scheduleKey = n === 1 ? schedule.craftbook : `${schedule.craftbook}#${n}`;

    const hostCron = hostCronExpression(schedule);
    try {
      const prior = existing.find(
        (t) =>
          t.origin?.kind === 'project-type-schedule' &&
          t.origin.typeId === typeId &&
          t.origin.scheduleKey === scheduleKey,
      );
      if (prior) {
        if (
          (prior.status === 'active' || prior.status === 'paused') &&
          (prior.cron?.expression !== hostCron || prior.cron?.overlap !== schedule.overlap)
        ) {
          await tasks.update(projectId, prior.num, {
            cron: {
              expression: hostCron,
              ...(schedule.overlap ? { overlap: schedule.overlap } : {}),
            },
          });
        }
        // Crash-window repair: a paused ask-host with no question on record
        // (question write died mid-apply) gets its question posted now; an
        // answered or pending one is never duplicated.
        if (prior.status === 'paused' && schedule.consent === 'ask') {
          await writeScheduleApprovalQuestion(store, {
            projectId,
            typeId,
            schedule,
            taskRef: prior.ref,
            gezelId: args.voormanGezelId ?? '',
          });
        }
        out.push({
          ref: prior.ref,
          craftbook: schedule.craftbook,
          cron: hostCron,
          consent: schedule.consent,
          status: prior.status === 'active' ? 'active' : 'paused',
          created: false,
        });
        continue;
      }

      // Created ACTIVE then immediately consent-mapped: a draft may not
      // carry cron (schema), create never dispatches a host (no entry
      // dispatch for spawn hosts), and its first `nextTickAt` is in the
      // future — so there is no fire window before the pause below.
      const host = await tasks.create(
        projectId,
        {
          title: `Schedule: ${schedule.craftbook}`,
          description: `Recurring craftbook run installed by the "${typeId}" project type. ${describeHostCadence(schedule)} Each fire spawns a "${schedule.craftbook}" child task; this host never runs steps itself.`,
          assignee: args.voormanGezelId
            ? { kind: 'gezel', gezelId: args.voormanGezelId }
            : { kind: 'user' },
          steps: [{ ...SCHEDULE_HOST_STEP }],
          spawnsCraftbookId: schedule.craftbook,
          ...hostRecurrenceFields(schedule),
          createdBy: { kind: 'user' },
        },
        { origin: { kind: 'project-type-schedule', typeId, scheduleKey } },
      );

      let status: 'active' | 'paused' = 'active';
      if (schedule.consent !== 'auto') {
        await tasks.setStatus(projectId, host.num, 'paused');
        status = 'paused';
      }
      if (schedule.consent === 'ask') {
        await writeScheduleApprovalQuestion(store, {
          projectId,
          typeId,
          schedule,
          taskRef: host.ref,
          gezelId: args.voormanGezelId ?? '',
        });
      }
      out.push({
        ref: host.ref,
        craftbook: schedule.craftbook,
        cron: hostCron,
        consent: schedule.consent,
        status,
        created: true,
      });
    } catch (err) {
      log.warn(
        `[apply] project type ${typeId}: schedule for '${schedule.craftbook}' failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      failed += 1;
    }
  }
  return { schedules: out, failed };
}

async function writeScheduleApprovalQuestion(
  store: Store,
  args: {
    projectId: string;
    typeId: string;
    schedule: ProjectTypeSchedule;
    taskRef: string;
    gezelId: string;
  },
): Promise<void> {
  const all = await store.listProjectQuestions(args.projectId).catch(() => []);
  // Any question for this host — answered or pending — means the user has
  // seen (or will see) the ask; never post a duplicate.
  if (all.some((q) => q.intent?.kind === 'schedule-approval' && q.taskRef === args.taskRef)) {
    return;
  }
  const night = args.schedule.runMode === 'night-shift';
  const question: Question = {
    id: randomUUID(),
    projectId: args.projectId,
    gezelId: args.gezelId,
    // Adoption has no live chat session; the answer route early-returns
    // for this intent, so nothing tries to seed a turn from it.
    sessionId: '',
    prompt: night
      ? `The "${args.typeId}" project type set up a recurring "${args.schedule.craftbook}" run for the Night Shift (at most once per night, inside your configured window). It was created paused and will not run until you enable it.`
      : `The "${args.typeId}" project type set up a recurring "${args.schedule.craftbook}" run (cron \`${args.schedule.cron}\`, UTC). It was created paused and will not run until you enable it.`,
    choices: ['Enable schedule', 'Keep paused'],
    allowWriteIn: false,
    multiSelect: false,
    taskRef: args.taskRef,
    intent: {
      kind: 'schedule-approval',
      typeId: args.typeId,
      craftbookId: args.schedule.craftbook,
      ...(night ? { runMode: 'night-shift' as const } : {}),
      cron: hostCronExpression(args.schedule),
      ...(args.schedule.overlap ? { overlap: args.schedule.overlap } : {}),
    },
    createdAt: new Date().toISOString(),
  };
  await store.writeQuestion(question);
}

/**
 * Dry-run report: what an apply with the same input would materialize,
 * computed without writing anything. Runs the same preflight validation the
 * apply engine relies on, so a plan that renders is a plan that can apply.
 */
export async function planProjectTypeApply(
  deps: { store: Store; catalog: CatalogService; home: string },
  input: ApplyProjectTypeInput,
): Promise<ProjectTypeApplyPlan> {
  const { store, catalog } = deps;
  const project = await store.getProject(input.projectId);
  if (!project) throw new Error(`project ${input.projectId} not found`);
  const { manifest, source } = await resolveProjectType(catalog, input.typeId, input.version);
  await preflightProjectType({ catalog }, { typeId: input.typeId, version: manifest.version });
  const params = { ...seedParamDefaults(manifest.params), ...(input.params ?? {}) };
  const policy = input.seedPolicy ?? 'overwrite';

  const reusePool = manifest.leanProfile ? await store.listGezels().catch(() => []) : [];
  const rosterPool =
    !manifest.leanProfile && input.reuseRosterGezels
      ? (
          await Promise.all(
            (project.gezelIds ?? []).map((id) => store.getGezel(id).catch(() => null)),
          )
        ).filter((g) => g !== null)
      : [];
  const gezels = manifest.gezels.map((ref) => ({
    templateId: ref.templateId,
    voorman: ref.voorman,
    reuse: manifest.leanProfile
      ? reusePool.some((g) => g.templateId === ref.templateId)
      : rosterPool.some((g) => g.templateId === ref.templateId),
  }));

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
  const updateAvailable = Boolean(
    provenance && installedApp && semverGreater(installedApp.version, provenance.version),
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
      const { manifest } = await resolveProjectType(catalog, provenance.id, provenance.version);
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

  return { projectId, provenance, installedApp, updateAvailable, seeds };
}
