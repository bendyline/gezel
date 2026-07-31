import {
  type Craftbook,
  type GezelTemplateManifest,
  type Question,
  type SuggestedCraftbook,
  type SuggestedWorkItem,
  type SuggestedWorkSource,
  type Task,
  createLogger,
} from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { makeCraftbookResolver } from '../craftbook/resolve.js';
import type { Store } from '../fs/store.js';
import { MATCH_THRESHOLD, rankCandidates } from '../gezels/match.js';
import { hostCronExpression } from '../tasks/schedule-host.js';

const log = createLogger('suggested-work');

/**
 * Compute a project's suggested-work list — see the schema header in
 * core `schemas/suggested-work.ts` for the model. Read-only: computed
 * on demand from the roster, the adopted project type, the catalog, and
 * the project's existing origin-stamped host tasks. Nothing here writes.
 */
export async function resolveSuggestedWork(
  deps: { store: Store; catalog: CatalogService },
  projectId: string,
): Promise<SuggestedWorkItem[]> {
  const { store, catalog } = deps;
  const project = await store.getProject(projectId);
  if (!project) return [];

  const craftbooks = makeCraftbookResolver(store, catalog);
  const resolveCraftbook = async (id: string): Promise<Craftbook | null> => {
    const hit = await craftbooks.resolve(id, { projectId }).catch(() => null);
    return hit?.craftbook ?? null;
  };

  const items: SuggestedWorkItem[] = [];

  // ── Source 1: gezel templates via the roster ─────────────────────────
  const rosterIds = [
    ...new Set([
      ...(project.voormanGezelId ? [project.voormanGezelId] : []),
      ...(project.gezelIds ?? []),
    ]),
  ];
  const templateSponsors = await resolveRosterTemplates(deps, rosterIds);
  for (const { template, sponsor } of templateSponsors) {
    const suggestions = template.suggestedCraftbooks ?? [];
    if (suggestions.length === 0) continue;
    const keyCounts = new Map<string, number>();
    for (const suggestion of suggestions) {
      const n = (keyCounts.get(suggestion.craftbookId) ?? 0) + 1;
      keyCounts.set(suggestion.craftbookId, n);
      const suggestionKey = n === 1 ? suggestion.craftbookId : `${suggestion.craftbookId}#${n}`;
      const craftbook = await resolveCraftbook(suggestion.craftbookId);
      if (!craftbook) {
        log.warn(
          `[suggested-work] template ${template.id} suggests unknown craftbook '${suggestion.craftbookId}' — skipped`,
        );
        continue;
      }
      items.push(
        buildItem({
          key: `gezel-template:${template.id}:${suggestionKey}`,
          source: {
            kind: 'gezel-template',
            templateId: template.id,
            ...(sponsor
              ? { gezelId: sponsor.id, gezelName: sponsor.name, role: sponsor.role }
              : {}),
          },
          suggestion,
          craftbook,
        }),
      );
    }
  }

  // ── Source 2: the adopted project type's schedules ───────────────────
  const typeId = project.projectType?.id;
  if (typeId) {
    const detail = await catalog.get('project-type', typeId).catch(() => null);
    if (detail && detail.manifest.kind === 'project-type') {
      const keyCounts = new Map<string, number>();
      for (const schedule of detail.manifest.schedules) {
        const n = (keyCounts.get(schedule.craftbook) ?? 0) + 1;
        keyCounts.set(schedule.craftbook, n);
        const scheduleKey = n === 1 ? schedule.craftbook : `${schedule.craftbook}#${n}`;
        const craftbook = await resolveCraftbook(schedule.craftbook);
        if (!craftbook) continue;
        items.push(
          buildItem({
            key: `project-type:${typeId}:${scheduleKey}`,
            source: { kind: 'project-type', typeId, scheduleKey },
            suggestion: {
              craftbookId: schedule.craftbook,
              runMode: schedule.runMode,
              ...(schedule.cron ? { cron: schedule.cron } : {}),
              ...(schedule.overlap ? { overlap: schedule.overlap } : {}),
            },
            craftbook,
          }),
        );
      }
    }
  }

  // ── Cross-source dedup: same craftbook + runMode from both sources →
  // the project-type item wins (it is the one already materialized at
  // adoption); credit the gezel sponsor in the surviving reason.
  const deduped = dedupeAcrossSources(items);

  // ── Overlays: host tasks (origin match), pending questions, dismissals.
  const tasks = await store.listProjectTasks(projectId).catch(() => []);
  const hosts = tasks.filter(
    (t) =>
      (t.status === 'active' || t.status === 'paused') &&
      (t.origin?.kind === 'project-type-schedule' ||
        t.origin?.kind === 'gezel-suggested-craftbook'),
  );
  const questions = await store.listProjectQuestions(projectId).catch(() => []);
  const dismissed = new Set(project.suggestedWorkDismissed ?? []);

  const matchedRefs = new Set<string>();
  for (const item of deduped) {
    const host = hosts.find((t) => originKey(t) === item.key);
    if (host) {
      matchedRefs.add(host.ref);
      item.state = host.status === 'active' ? 'enabled' : 'paused';
      item.taskRef = host.ref;
      const pending = findPendingApproval(questions, host.ref);
      if (pending) item.pendingQuestionId = pending.id;
    } else if (dismissed.has(item.key)) {
      item.state = 'dismissed';
    }
  }

  // Origin-stamped hosts whose source no longer resolves (sponsor left
  // the roster, template edition dropped the entry, project type
  // switched): keep them toggleable — the off-switch never disappears.
  for (const host of hosts) {
    if (matchedRefs.has(host.ref)) continue;
    const key = originKey(host);
    if (!key) continue;
    const pending = findPendingApproval(questions, host.ref);
    deduped.push({
      key,
      source: orphanSource(host),
      craftbookId: host.spawnsCraftbook?.id ?? host.title,
      craftbookName: host.spawnsCraftbook?.name,
      runMode: host.nightShift?.enabled ? 'night-shift' : 'scheduled',
      ...(host.nightShift?.enabled ? {} : host.cron ? { cron: host.cron.expression } : {}),
      state: host.status === 'active' ? 'enabled' : 'paused',
      taskRef: host.ref,
      ...(pending ? { pendingQuestionId: pending.id } : {}),
      orphaned: true,
    });
  }

  return deduped;
}

/**
 * Map the roster onto gilde gezel-templates. `templateId` provenance
 * wins; gezels without one fall back to a role-name fuzzy match — but a
 * fallback match only counts when the matched template actually declares
 * suggestions (the matcher was tuned for recruitment, not attribution).
 * One entry per distinct template; sponsor = first roster gezel that
 * resolved to it.
 */
async function resolveRosterTemplates(
  deps: { store: Store; catalog: CatalogService },
  rosterIds: string[],
): Promise<
  Array<{
    template: GezelTemplateManifest;
    sponsor: { id: string; name: string; role?: string } | null;
  }>
> {
  const { store, catalog } = deps;
  const out = new Map<
    string,
    { template: GezelTemplateManifest; sponsor: { id: string; name: string; role?: string } | null }
  >();
  let listCandidates: Array<{
    id: string;
    role?: string;
    name?: string;
    tags?: string[];
    description?: string;
  }> | null = null;

  const getTemplate = async (templateId: string): Promise<GezelTemplateManifest | null> => {
    const detail = await catalog.get('gezel-template', templateId).catch(() => null);
    if (!detail || detail.manifest.kind !== 'gezel-template') return null;
    return detail.manifest;
  };

  for (const gezelId of rosterIds) {
    const gezel = await store.getGezel(gezelId).catch(() => null);
    if (!gezel) continue;
    let templateId = gezel.templateId;
    if (!templateId) {
      const query = (gezel.role ?? '').trim();
      if (!query) continue;
      if (!listCandidates) {
        const gildeItems = await catalog.list('gezel-template').catch(() => []);
        listCandidates = gildeItems
          .filter((g) => g.manifest.kind === 'gezel-template')
          .map((g) => {
            const m = g.manifest as Extract<typeof g.manifest, { kind: 'gezel-template' }>;
            return {
              id: m.id,
              role: m.role,
              name: m.name,
              tags: m.tags,
              description: m.description,
            };
          });
      }
      const ranked = rankCandidates(query, listCandidates);
      const best = ranked[0];
      if (!best || best.score < MATCH_THRESHOLD) continue;
      templateId = best.id;
    }
    const existing = out.get(templateId);
    if (existing) continue;
    const template = await getTemplate(templateId);
    if (!template) continue;
    // Fuzzy fallback only attributes to templates that declare suggestions.
    if (!gezel.templateId && !template.suggestedCraftbooks?.length) continue;
    out.set(templateId, {
      template,
      sponsor: { id: gezel.id, name: gezel.name, ...(gezel.role ? { role: gezel.role } : {}) },
    });
  }
  return [...out.values()];
}

function buildItem(args: {
  key: string;
  source: SuggestedWorkSource;
  suggestion: Pick<
    SuggestedCraftbook,
    'craftbookId' | 'runMode' | 'cron' | 'overlap' | 'params' | 'reason'
  >;
  craftbook: Craftbook;
}): SuggestedWorkItem {
  const { key, source, suggestion, craftbook } = args;
  return {
    key,
    source,
    craftbookId: suggestion.craftbookId,
    craftbookName: craftbook.name,
    ...(craftbook.description ? { description: craftbook.description } : {}),
    ...(suggestion.reason ? { reason: suggestion.reason } : {}),
    runMode: suggestion.runMode,
    ...(suggestion.runMode === 'scheduled' ? { cron: hostCronExpression(suggestion) } : {}),
    ...(suggestion.overlap ? { overlap: suggestion.overlap } : {}),
    ...(craftbook.paramSchema ? { paramSchema: craftbook.paramSchema } : {}),
    ...(suggestion.params ? { params: suggestion.params } : {}),
    state: 'suggested',
  };
}

function dedupeAcrossSources(items: SuggestedWorkItem[]): SuggestedWorkItem[] {
  const out: SuggestedWorkItem[] = [];
  for (const item of items) {
    const dup = out.find((o) => o.craftbookId === item.craftbookId && o.runMode === item.runMode);
    if (!dup) {
      out.push(item);
      continue;
    }
    // Project-type wins; fold the gezel sponsor into the survivor's reason.
    const [typeItem, gezelItem] = dup.source.kind === 'project-type' ? [dup, item] : [item, dup];
    if (typeItem.source.kind !== 'project-type') {
      // Same-source duplicate (two templates suggesting the same book):
      // first one stands.
      continue;
    }
    const sponsorName =
      gezelItem.source.kind === 'gezel-template' ? gezelItem.source.gezelName : undefined;
    if (sponsorName) {
      const credit = `Also suggested by ${sponsorName}.`;
      typeItem.reason = typeItem.reason ? `${typeItem.reason} ${credit}` : credit;
    }
    if (dup !== typeItem) out[out.indexOf(dup)] = typeItem;
  }
  return out;
}

/** The suggested-work key a host task's origin maps to, if any. */
export function originKey(task: Task): string | null {
  if (task.origin?.kind === 'project-type-schedule') {
    return `project-type:${task.origin.typeId}:${task.origin.scheduleKey}`;
  }
  if (task.origin?.kind === 'gezel-suggested-craftbook') {
    return `gezel-template:${task.origin.templateId}:${task.origin.suggestionKey}`;
  }
  return null;
}

function orphanSource(task: Task): SuggestedWorkSource {
  if (task.origin?.kind === 'project-type-schedule') {
    return {
      kind: 'project-type',
      typeId: task.origin.typeId,
      scheduleKey: task.origin.scheduleKey,
    };
  }
  if (task.origin?.kind === 'gezel-suggested-craftbook') {
    return { kind: 'gezel-template', templateId: task.origin.templateId };
  }
  throw new Error(`task ${task.ref} is not a suggested-work host`);
}

function findPendingApproval(questions: Question[], taskRef: string): Question | undefined {
  return questions.find(
    (q) => q.intent?.kind === 'schedule-approval' && q.taskRef === taskRef && !q.answer,
  );
}
