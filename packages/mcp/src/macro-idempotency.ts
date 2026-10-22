import type { GezelClient } from '@bendyline/gezel-client';

/**
 * Per-subprocess idempotency cache for the `start_project` / `start_job`
 * macros. Keyed by normalized name (lowercased, whitespace collapsed).
 * When the same name is requested again within `MACRO_IDEMPOTENCY_TTL_MS`
 * we replay the original result instead of creating a duplicate
 * project + voorman + task triple.
 *
 * Belt-and-suspenders with the per-turn guard in the local providers:
 * the provider guard catches "same response emits multiple start_project
 * calls" (the most common failure mode). This cache also catches the
 * cross-turn variant — a model that re-emits `start_project({ name: "X" })`
 * after a salvage retry or after the turn is restarted from a failure.
 *
 * Scope: this map lives in the MCP subprocess, which is one instance
 * per (gezel, project) session. So a Meester's macros dedup against
 * each other but not across distinct gezel sessions. Good — different
 * gezels deliberately calling start_project shouldn't accidentally
 * collide.
 */
/** The macros that create a project, sharing one dedupe cache and one notice. */
export type MacroTool = 'start_project' | 'start_job' | 'start_work';

const MACRO_IDEMPOTENCY_TTL_MS = 60_000;
interface MacroCacheEntry {
  tool: MacroTool;
  projectId: string;
  resultText: string;
  expiresAt: number;
}
const macroCache = new Map<string, MacroCacheEntry>();

function macroCacheKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function lookupMacroIdempotent(
  name: string,
): { tool: MacroTool; resultText: string; projectId: string } | null {
  const key = macroCacheKey(name);
  const entry = macroCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    macroCache.delete(key);
    return null;
  }
  return { tool: entry.tool, resultText: entry.resultText, projectId: entry.projectId };
}

export function recordMacroResult(
  tool: MacroTool,
  name: string,
  projectId: string,
  resultText: string,
): void {
  macroCache.set(macroCacheKey(name), {
    tool,
    projectId,
    resultText,
    expiresAt: Date.now() + MACRO_IDEMPOTENCY_TTL_MS,
  });
}

export function createMacroProjectGuard(
  api: Pick<GezelClient, 'listProjects' | 'listProjectTasks'>,
) {
  /**
   * Persistent idempotency backstop for the macros. The in-memory cache above
   * has a 60 s TTL, but a Meester that re-calls `start_job` for the SAME named
   * deliverable every few minutes (longer than the TTL) would spawn duplicate,
   * name-suffixed projects ("Arcade Deluxe Game 2/3/4") and fragment the team's
   * effort across them. If an ACTIVE project with the same normalized name
   * already exists in the workspace, the macro should reuse it rather than create
   * another. (Wild-caught: an e4b Meester start_job'd the same arcade
   * brief 5× across 18 min, splitting one game over 5 projects, finishing none.)
   */
  async function findActiveMacroProject(
    name: string,
  ): Promise<{ id: string; name: string } | null> {
    try {
      const { projects } = await api.listProjects();
      const key = macroCacheKey(name);
      const hit = projects.find(
        (p) => (p.status ?? 'active') === 'active' && macroCacheKey(p.name) === key,
      );
      return hit ? { id: hit.id, name: hit.name } : null;
    } catch {
      return null;
    }
  }

  /**
   * A same-named project is not proof the work started. The guard exists for a
   * second call on the same request, whose first call left a running kickoff
   * task. A project the person (or a scenario) made has none: told "its lead is
   * on this deliverable", a Meester relayed "Already in motion" to the person
   * while nothing ran (start_work in the Customer List Cleanup project,
   * qwen3.8-27b, 2026-10-22).
   */
  async function duplicateMacroProjectNotice(
    tool: MacroTool,
    existing: {
      id: string;
      name: string;
    },
  ): Promise<{ content: { type: 'text'; text: string }[] }> {
    const live = await api
      .listProjectTasks(existing.id)
      .then((res) => res.tasks.some((t) => t.status === 'active' && !t.cron && !t.nightShift))
      .catch(() => true);
    if (!live) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `[runtime] A project named "${existing.name}" (projectId: ${existing.id}) already exists, and no work is running in it yet. Do NOT start a second project. Start the work inside this one: call suggest_work({ project: "${existing.id}" }), then start_work with the option that fits and project "${existing.id}".`,
          },
        ],
      };
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: `[runtime] A project named "${existing.name}" (projectId: ${existing.id}) is already active and its lead is on this deliverable. Do NOT \`${tool}\` again for it — a second call spawns a duplicate, name-suffixed project and splits the work in two. END YOUR TURN; the lead's progress will surface here. To check status use \`list_tasks\`/\`list_projects\` or \`message_gezel\` the lead. Only start a new one for a genuinely different deliverable.`,
        },
      ],
    };
  }

  return { findActiveMacroProject, duplicateMacroProjectNotice };
}
