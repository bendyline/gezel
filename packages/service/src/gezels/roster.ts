import type { MentionCandidate, ProjectForGezel } from '@bendyline/gezel';
import type { Store } from '../fs/store.js';

const DEFAULT_PROJECT_ID = 'default';

/**
 * Build the roster for a chat composer's `@`-mention popover — the same
 * ordering both the Project-chat chip row and the suggestion provider
 * need to agree on:
 *
 *   1. `voorman` — the project's designated voorman (if any + if set)
 *   2. `assignees` — every gezel currently assigned to a task OR a phase
 *      in this project (deduped; voorman excluded since they're already
 *      in group 1)
 *   3. `team` — everyone else on the roster
 *
 * Meester chat (no `projectId`, or `'default'`) gets a different shape:
 * each gezel is expanded into one candidate **per project they have
 * presence on** (ranked via `rankProjectsForGezel`), so the user can
 * pick "Mira re: Project A" vs "Mira re: Project B" explicitly. The
 * candidate id encodes the project as a query suffix
 * (`mira?project=project-a`) — the parser splits it back out and the
 * fan-out path uses it as a project override. Gezels with no project
 * presence still get a single bare candidate so the dropdown is never
 * empty for a fresh roster.
 *
 * Passing an unknown/archived project id degrades to project-chat shape
 * with an empty voorman/assignee section rather than throwing.
 */
export async function deriveGezelRoster(
  store: Store,
  projectId?: string,
): Promise<MentionCandidate[]> {
  const gezels = await store.listGezels();
  const byId = new Map(gezels.map((g) => [g.id, g]));
  const meesterScope = !projectId || projectId === DEFAULT_PROJECT_ID;

  if (meesterScope) {
    return deriveMeesterRoster(store, gezels);
  }

  // Project-local gezels (the `@project` gezel + any others defined in the
  // workspace `.gezel/` folder) are merged in here so they're mentionable
  // in this project. They never appear in the global `listGezels()` roster,
  // so the Meester scope above never sees them.
  const projectGezels = await store.listProjectGezels(projectId).catch(() => []);
  for (const g of projectGezels) byId.set(g.id, g);

  const placed = new Set<string>();
  const out: MentionCandidate[] = [];

  const project = await store.getProject(projectId);
  if (project?.voormanGezelId) {
    const voorman = byId.get(project.voormanGezelId);
    if (voorman) {
      out.push(toCandidate(voorman, 'voorman'));
      placed.add(voorman.id);
    }
  }

  const tasks = await store.listProjectTasks(projectId).catch(() => []);
  const assigneeIds: string[] = [];
  const seenAssignee = new Set<string>();
  for (const t of tasks) {
    if (t.assignee.kind === 'gezel' && !seenAssignee.has(t.assignee.gezelId)) {
      seenAssignee.add(t.assignee.gezelId);
      assigneeIds.push(t.assignee.gezelId);
    }
    for (const s of t.craftbook.steps) {
      if (s.assignee?.kind === 'gezel' && !seenAssignee.has(s.assignee.gezelId)) {
        seenAssignee.add(s.assignee.gezelId);
        assigneeIds.push(s.assignee.gezelId);
      }
    }
  }
  for (const id of assigneeIds) {
    if (placed.has(id)) continue;
    const g = byId.get(id);
    if (!g) continue;
    out.push(toCandidate(g, 'assignees'));
    placed.add(id);
  }

  for (const g of gezels) {
    if (placed.has(g.id)) continue;
    out.push(toCandidate(g, 'team'));
    placed.add(g.id);
  }

  // Project-local gezels that aren't the voorman/assignee round out the
  // team group (e.g. extra `.gezel/gezels/` personas the repo ships).
  for (const g of projectGezels) {
    if (placed.has(g.id)) continue;
    out.push(toCandidate(g, 'team'));
    placed.add(g.id);
  }

  return out;
}

/**
 * Pick the best existing project-member gezel to promote to voorman when a
 * project has none. Scoped deliberately to gezels with *real presence* in
 * this project — never a random global gezel — and ranked by how directly
 * they're already doing the work:
 *
 *   1. Assignees on a live task or phase (`complete`/`canceled` excluded).
 *   2. Advisory roster members (`project.gezelIds`).
 *   3. Project-local gezels (the `@project` gezel + `.gezel/gezels/` personas).
 *
 * Returns the first candidate that still resolves to a real gezel, or
 * null when the project has no one to promote yet (the caller retries on
 * a later scan once a gezel joins). Never throws.
 */
export async function pickRosterVoorman(store: Store, projectId: string): Promise<string | null> {
  if (!projectId || projectId === DEFAULT_PROJECT_ID) return null;

  const ordered: string[] = [];
  const seen = new Set<string>();
  const add = (id: string | undefined): void => {
    if (id && !seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  };

  // 1. Gezels actually assigned to live work.
  const tasks = await store.listProjectTasks(projectId).catch(() => []);
  for (const t of tasks) {
    if (t.status === 'complete' || t.status === 'canceled') continue;
    if (t.assignee.kind === 'gezel') add(t.assignee.gezelId);
    for (const s of t.craftbook.steps) {
      if (s.assignee?.kind === 'gezel') add(s.assignee.gezelId);
    }
  }

  // 2. The advisory roster (pinged / sessioned / explicitly added).
  const project = await store.getProject(projectId).catch(() => null);
  for (const id of project?.gezelIds ?? []) add(id);

  // 3. Project-local gezels shipped/minted in the workspace.
  const projectGezels = await store.listProjectGezels(projectId).catch(() => []);
  for (const g of projectGezels) add(g.id);

  // Only promote someone who still exists on a real roster.
  const global = await store.listGezels().catch(() => []);
  const known = new Set<string>([...global.map((g) => g.id), ...projectGezels.map((g) => g.id)]);
  for (const id of ordered) {
    if (known.has(id)) return id;
  }
  return null;
}

/**
 * Expand each gezel into one candidate per project they have presence
 * on. Used by the Meester chat where the user is conceptually
 * routing to a specific project's session — without this fan-out the
 * picker would show one "Mira" entry that silently auto-picks a single
 * project (today's behavior), and a user with a 3-project Mira can't
 * tell which session they're actually pinging.
 *
 * `default` is excluded as a project context — pinging the Meester's
 * own pseudo-project would be a no-op routing back to the same chat.
 * A bare candidate (no `?project=` suffix) is still added for gezels
 * with no real project presence so the dropdown is never empty.
 */
async function deriveMeesterRoster(
  store: Store,
  gezels: Awaited<ReturnType<Store['listGezels']>>,
): Promise<MentionCandidate[]> {
  const out: MentionCandidate[] = [];
  for (const g of gezels) {
    const ranked = await rankProjectsForGezel(store, g.id).catch(() => []);
    const realProjects = ranked.filter(
      (p) => p.projectId !== DEFAULT_PROJECT_ID && p.precedence !== 'fallback',
    );
    if (realProjects.length === 0) {
      // Gezel hasn't been pulled into any non-default project yet —
      // fall back to a bare mention so the Meester can still ping
      // them (they'll land in the auto-picked project at fan-out
      // time, which today means `default`).
      out.push(toCandidate(g, 'team'));
      continue;
    }
    for (const p of realProjects) {
      out.push(toProjectScopedCandidate(g, p, 'team'));
    }
  }
  return out;
}

function toCandidate(
  g: { id: string; name: string; role?: string; description?: string; roleBasedName?: string },
  group: 'voorman' | 'assignees' | 'team',
): MentionCandidate {
  const description = g.role?.trim() || g.description?.trim();
  return {
    id: g.id,
    label: g.name,
    ...(description ? { description } : {}),
    ...(g.roleBasedName ? { roleBasedName: g.roleBasedName } : {}),
    group,
  };
}

/**
 * Like {@link toCandidate} but tags the id with the project the
 * mention should route to. Encoded as a query suffix
 * (`mira?project=project-a`) so the existing markdown form
 * `@[Label](gezel:<id>)` carries the routing without a schema change;
 * the parser splits the id on `?` to recover the gezel id +
 * projectId.
 *
 * The label includes the project context (`Mira re: Project A`) so the
 * inserted chip in the composer + the rendered chip in the chat
 * bubble + the "TO:" row at the top of the composer all read with the
 * project explicitly — picking by project is the whole reason this
 * candidate exists, and a bare `@Mira` chip would lose that context
 * the moment the user hits Send. The description stays as the role
 * (or empty) so the popover row pairs the project-scoped label with a
 * muted role line below it.
 */
function toProjectScopedCandidate(
  g: { id: string; name: string; role?: string; description?: string; roleBasedName?: string },
  project: ProjectForGezel,
  group: 'voorman' | 'assignees' | 'team',
): MentionCandidate {
  const role = g.role?.trim() || g.description?.trim();
  return {
    id: `${g.id}?project=${encodeURIComponent(project.projectId)}`,
    label: `${g.name} re: ${project.projectName}`,
    ...(role ? { description: role } : {}),
    ...(g.roleBasedName ? { roleBasedName: g.roleBasedName } : {}),
    group,
  };
}

/**
 * The inverse of {@link deriveGezelRoster}: rank the projects where a given
 * gezel has presence. Drives both the per-gezel Chat tab's project picker
 * AND the Meester-chat `@mention` re-anchoring heuristic, so the two stay
 * coherent — a gezel mentioned from the Meester always lands in the same
 * project the dropdown would pre-select.
 *
 * Precedence:
 *   1. `voorman` — the gezel runs this project
 *   2. `assignment` — the gezel is on an active task / phase here
 *      (`complete` and `canceled` tasks excluded — wrapped work shouldn't
 *      pull a gezel back)
 *   3. `session` — they have a non-archived session in the project, even
 *      without a formal assignment
 *   4. `fallback` — `default` always appears last so the dropdown is never
 *      empty for a fresh install
 *
 * Within each precedence band, projects are ordered by the gezel's most
 * recent session activity (newest first), then by project id for stable
 * ties when no sessions exist.
 */
export async function rankProjectsForGezel(
  store: Store,
  gezelId: string,
): Promise<ProjectForGezel[]> {
  const projects = await store.listProjects();
  const projectsById = new Map(projects.map((p) => [p.id, p]));
  const ranked = new Map<string, ProjectForGezel>();

  for (const p of projects) {
    if (p.id === DEFAULT_PROJECT_ID) continue;
    const detail = await store.getProject(p.id).catch(() => null);
    if (detail?.voormanGezelId === gezelId) {
      ranked.set(p.id, {
        projectId: p.id,
        projectName: p.name,
        precedence: 'voorman',
      });
      continue;
    }
    const tasks = await store.listProjectTasks(p.id).catch(() => []);
    let assignmentHit = false;
    for (const t of tasks) {
      if (t.status === 'complete' || t.status === 'canceled') continue;
      if (t.assignee.kind === 'gezel' && t.assignee.gezelId === gezelId) {
        assignmentHit = true;
        break;
      }
      if (
        t.craftbook.steps.some(
          (s) => s.assignee?.kind === 'gezel' && s.assignee.gezelId === gezelId,
        )
      ) {
        assignmentHit = true;
        break;
      }
    }
    if (assignmentHit) {
      ranked.set(p.id, {
        projectId: p.id,
        projectName: p.name,
        precedence: 'assignment',
      });
    }
  }

  const sessions = await store.listSessions({ gezelId });
  for (const s of sessions) {
    if (s.archived) continue;
    if (s.projectId === DEFAULT_PROJECT_ID) continue;
    const existing = ranked.get(s.projectId);
    if (existing) {
      if (!existing.lastActivityAt || s.lastActivityAt > existing.lastActivityAt) {
        existing.lastActivityAt = s.lastActivityAt;
      }
      continue;
    }
    const proj = projectsById.get(s.projectId);
    if (!proj) continue;
    ranked.set(s.projectId, {
      projectId: s.projectId,
      projectName: proj.name,
      precedence: 'session',
      lastActivityAt: s.lastActivityAt,
    });
  }

  // `default` is always available so the dropdown is never empty.
  const defaultProj = projectsById.get(DEFAULT_PROJECT_ID);
  if (defaultProj && !ranked.has(DEFAULT_PROJECT_ID)) {
    ranked.set(DEFAULT_PROJECT_ID, {
      projectId: DEFAULT_PROJECT_ID,
      projectName: defaultProj.name,
      precedence: 'fallback',
    });
  }

  const order: Record<ProjectForGezel['precedence'], number> = {
    voorman: 0,
    assignment: 1,
    session: 2,
    fallback: 3,
  };
  return Array.from(ranked.values()).sort((a, b) => {
    const byBand = order[a.precedence] - order[b.precedence];
    if (byBand !== 0) return byBand;
    const aT = a.lastActivityAt ? Date.parse(a.lastActivityAt) : 0;
    const bT = b.lastActivityAt ? Date.parse(b.lastActivityAt) : 0;
    if (aT !== bT) return bT - aT;
    return a.projectId.localeCompare(b.projectId);
  });
}

/**
 * The single-best project for a gezel — the one a Meester-chat `@mention`
 * should land in. Same ranking as {@link rankProjectsForGezel}; we just
 * take the head, with one wrinkle: `fallback` is acceptable as a final
 * resort but the caller may prefer to skip it (e.g. when the heuristic
 * runs from project chat where falling back to `default` would be wrong).
 */
export async function pickProjectForGezel(store: Store, gezelId: string): Promise<string> {
  const ranked = await rankProjectsForGezel(store, gezelId);
  return ranked[0]?.projectId ?? DEFAULT_PROJECT_ID;
}

/**
 * Filter the derived roster with a (usually short) client-supplied query.
 * Case-insensitive match against name and role; falls back to returning
 * everything when the query is empty. Keeps the grouped order so the UI
 * can still render "voorman" first.
 */
export function filterRoster(roster: MentionCandidate[], query: string): MentionCandidate[] {
  const q = query.trim().toLowerCase();
  if (!q) return roster;
  return roster.filter((c) => {
    if (c.label.toLowerCase().includes(q)) return true;
    if (c.description?.toLowerCase().includes(q)) return true;
    if (c.roleBasedName?.toLowerCase().includes(q)) return true;
    return false;
  });
}
