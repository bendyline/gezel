/**
 * Pieces both ways of applying a project type share: the first apply
 * (`apply.ts`) and moving a project to another version of its type
 * (`upgrade.ts`). Kept apart so the two modules never import each other.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  type AppliedProjectType,
  type GezelSummary,
  KeyedLock,
  type ProjectTypeManifest,
  type ProjectTypeSchedule,
  type Question,
  type ScheduleMaterialization,
  type SeedPlanState,
  compareSemver,
  createLogger,
  pickUnusedGezelName,
  projectTypeCrewMatch,
  projectTypeTemplateFrontmatter,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { slugifyEntityName as slugify } from '@bendyline/gezel/runtime';
import { makeCraftbookResolver } from '../craftbook/resolve.js';
import type { Store } from '../fs/store.js';
import { TaskManager } from '../tasks/manager.js';
import {
  SCHEDULE_HOST_STEP,
  describeHostCadence,
  hostCronExpression,
  hostRecurrenceFields,
} from '../tasks/schedule-host.js';

const log = createLogger('project-type');

export interface ApplyProjectTypeDeps {
  store: Store;
  catalog: CatalogService;
  home: string;
  /**
   * The install's gezels when `store` is not the install — a staged create
   * applies against an empty home, where nothing could otherwise be reused.
   */
  installGezels?: readonly GezelSummary[];
}

export type CrewCandidate = Pick<
  GezelSummary,
  'id' | 'name' | 'role' | 'templateId' | 'fixedFunction'
>;

/**
 * Gezels who may fill a type's crew: the project's roster first, then the
 * rest of the install. Creating a Social Feed project once hired a second
 * Omroeper and a second Copywriter beside the ones the user already had.
 */
export async function crewPool(
  deps: ApplyProjectTypeDeps,
  rosterIds: readonly string[],
): Promise<CrewCandidate[]> {
  const roster = await rosterGezels(deps.store, rosterIds);
  const install = deps.installGezels ?? (await deps.store.listGezels().catch(() => []));
  const onRoster = new Set(roster.map((gezel) => gezel.id));
  return [...roster, ...install.filter((gezel) => !onRoster.has(gezel.id))];
}

/** The project's roster gezels that still exist. */
export async function rosterGezels(
  store: Store,
  rosterIds: readonly string[],
): Promise<CrewCandidate[]> {
  return (await Promise.all(rosterIds.map((id) => store.getGezel(id).catch(() => null)))).filter(
    (gezel): gezel is NonNullable<typeof gezel> => gezel !== null,
  );
}

export function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Hash of a project document (about, mission) for "is this still what the
 * app rendered?". Line endings and trailing whitespace are not edits.
 */
export function docFingerprint(text: string | null | undefined): string {
  return sha256Hex((text ?? '').replace(/\r\n/g, '\n').trimEnd());
}

export function semverGreater(a: string, b: string): boolean {
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
export function classifySeed(args: {
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

export const parseTemplateFrontmatter = projectTypeTemplateFrontmatter;

/**
 * Resolve a project type. `sourceId` keeps an update inside the catalog the
 * project's app came from: an installed AI App that reuses a Gilde type's id
 * must not take over projects made from the Gilde one.
 */
export async function resolveProjectType(
  catalog: CatalogService,
  typeId: string,
  version?: string,
  sourceId?: string,
): Promise<{ manifest: ProjectTypeManifest; source: string }> {
  const detail = await catalog.get('project-type', typeId, sourceId, version);
  if (!detail || detail.manifest.kind !== 'project-type') {
    throw new Error(
      version ? `project type ${typeId}@${version} not found` : `project type ${typeId} not found`,
    );
  }
  return { manifest: detail.manifest, source: detail.sourceId };
}

/** One applied crew slot, as reported in `gezelsCreated`. */
export type AppliedCrewMember = AppliedProjectType['gezelsCreated'][number];

/**
 * Fill one crew slot: reuse a matching gezel from `pool`, else hire one from
 * the slot's gilde template, then put them on the project's roster. Mutates
 * `taken` and `namesInUse`. Null when the template resolves nowhere.
 */
export async function fillCrewSlot(
  deps: Pick<ApplyProjectTypeDeps, 'store' | 'catalog'>,
  args: {
    projectId: string;
    typeId: string;
    ref: ProjectTypeManifest['gezels'][number];
    pool: readonly CrewCandidate[];
    taken: Set<string>;
    namesInUse: Set<string>;
  },
): Promise<AppliedCrewMember | null> {
  const { store, catalog } = deps;
  const { ref } = args;
  const tpl = await catalog.get('gezel-template', ref.templateId).catch(() => null);
  const role = tpl?.manifest.kind === 'gezel-template' ? tpl.manifest.role : undefined;
  const reused = projectTypeCrewMatch(args.pool, { templateId: ref.templateId, role }, args.taken);
  let gezelId: string;
  let gezelName: string;
  if (reused) {
    gezelId = reused.id;
    gezelName = reused.name;
  } else {
    if (!tpl || tpl.manifest.kind !== 'gezel-template') {
      log.warn(
        `[apply] project type ${args.typeId}: gezel template ${ref.templateId} not found — skipping`,
      );
      return null;
    }
    const { name, gender } = pickUnusedGezelName(args.namesInUse);
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
    args.namesInUse.add(created.id).add(slugify(created.name));
  }
  args.taken.add(gezelId);
  // The type's crew belongs on the project roster — that is what makes a
  // re-apply idempotent for every role, not just the voorman (whose roster
  // join rides the provenance update).
  await store
    .addGezelToProject(args.projectId, gezelId, { source: 'project-type' })
    .catch((err) => {
      log.warn(`[apply] roster add failed for ${args.projectId}/${gezelId}: ${String(err)}`);
    });
  return {
    id: gezelId,
    name: gezelName,
    templateId: ref.templateId,
    voorman: ref.voorman,
    ...(reused ? { reused: true } : {}),
  };
}

/**
 * A type's schedules with the keys that identify their host tasks: the
 * craftbook id, `#n`-suffixed when the same book is scheduled again.
 */
export function projectTypeScheduleKeys(
  manifest: Pick<ProjectTypeManifest, 'schedules'>,
): Array<{ key: string; schedule: ProjectTypeSchedule }> {
  const counts = new Map<string, number>();
  return manifest.schedules.map((schedule) => {
    const n = (counts.get(schedule.craftbook) ?? 0) + 1;
    counts.set(schedule.craftbook, n);
    return { key: n === 1 ? schedule.craftbook : `${schedule.craftbook}#${n}`, schedule };
  });
}

/**
 * A host's cron is the one `schedule` creates. Overlap compares by effect: a
 * night-shift host is created with `skip`, which is also the scheduler's
 * default for a schedule that declares none.
 */
function hostRunsOn(
  cron: { expression: string; overlap?: string } | undefined,
  schedule: ProjectTypeSchedule,
): boolean {
  const want = hostRecurrenceFields(schedule).cron;
  return (
    cron?.expression === want?.expression && (cron?.overlap ?? 'skip') === (want?.overlap ?? 'skip')
  );
}

/**
 * Turn a type's declared `schedules[]` into schedule-host tasks
 * (`{cron, spawnsCraftbook, assignee}`) on the existing task engine.
 * Consent rule from docs/project-types.md — never silently armed:
 * `auto` → active; `ask` → paused + a `schedule-approval` question;
 * `disabled` → paused, no question. Idempotent via `Task.origin`:
 * re-apply refreshes a changed cron but never touches the user's
 * arm/disarm decision and never re-asks an answered question.
 * `only` limits the pass to those schedule keys (an app update skips a
 * schedule the person deleted).
 */
export async function materializeProjectTypeSchedules(
  deps: { store: Store; catalog: CatalogService },
  args: {
    projectId: string;
    typeId: string;
    manifest: ProjectTypeManifest;
    voormanGezelId?: string;
    only?: ReadonlySet<string>;
    /**
     * An app update's earlier version. A host keeps its time unless it
     * still runs on what that version declared, since anything else is a
     * time the person chose; `null` (the earlier version no longer
     * resolves) keeps every host's time. Unset on a fresh apply.
     */
    previous?: ProjectTypeManifest | null;
  },
): Promise<{ schedules: ScheduleMaterialization[]; failed: number }> {
  const { store, catalog } = deps;
  const { projectId, typeId, manifest } = args;
  if (manifest.schedules.length === 0) return { schedules: [], failed: 0 };
  const previousSchedules =
    args.previous === undefined
      ? undefined
      : new Map(
          (args.previous ? projectTypeScheduleKeys(args.previous) : []).map(
            ({ key, schedule }) => [key, schedule] as const,
          ),
        );

  // Apply-owned manager over the SAME store instance: task numbering
  // serializes through the store's per-project locks, and on the atomic
  // create path the hosts + questions land inside the staged project dir
  // and ride the publish (crash-safety inherited from the transaction).
  const tasks = new TaskManager(store);
  tasks.setCraftbookResolver(makeCraftbookResolver(store, catalog));

  const existing = await store.listProjectTasks(projectId).catch(() => []);
  const out: ScheduleMaterialization[] = [];
  let failed = 0;

  for (const { key: scheduleKey, schedule } of projectTypeScheduleKeys(manifest)) {
    if (args.only && !args.only.has(scheduleKey)) continue;
    const hostCron = hostCronExpression(schedule);
    try {
      const prior = existing.find(
        (t) =>
          t.origin?.kind === 'project-type-schedule' &&
          t.origin.typeId === typeId &&
          t.origin.scheduleKey === scheduleKey,
      );
      if (prior) {
        const declared = previousSchedules?.get(scheduleKey);
        const appOwned =
          previousSchedules === undefined ||
          (declared !== undefined && hostRunsOn(prior.cron, declared));
        if (
          appOwned &&
          (prior.status === 'active' || prior.status === 'paused') &&
          !hostRunsOn(prior.cron, schedule)
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

const applyLocks = new KeyedLock();

/**
 * One apply or update per project at a time, across every caller (the
 * routes, the MCP tool through them, and the automatic updater). Keyed by
 * home too, because tests and app hosts run several homes in one process.
 */
export function withProjectTypeApplyLock<T>(
  home: string,
  projectId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return applyLocks.run(`${home}\u0000${projectId}`, fn);
}
