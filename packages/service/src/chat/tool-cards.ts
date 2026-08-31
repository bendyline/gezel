import { type ToolCallCard, ToolCallCardSchema, type ToolCardStep } from '@bendyline/gezel';
import type { ToolCallEvent } from '../providers/types.js';

/**
 * ─ Inline tool cards ─────────────────────────────────────────────────
 *
 * Derives the typed `card` payload behind the chat transcript's rich
 * inline cards from a completed tool call's MCP `structuredContent`
 * (the same seam the surgical-edit `diff` and `generate_video` fields
 * use — see the onToolCall handler in manager.ts). Every card is a
 * snapshot-at-event-time receipt of the task's state when the tool
 * returned; the task rail/tab is the live view.
 *
 * Must stay pure and synchronous: the bridge awaits onToolCall before
 * handing the tool result back to the model, so a lookup here would tax
 * every turn. Everything a card needs rides in on the tool result — the
 * task snapshot carries its craftbook (steps, `recommends`) by design.
 *
 * Guards are structural, not schema parses of the whole task: CLI
 * providers fire onToolCall with foreign structuredContent shapes, and a
 * shape miss must mean "no card", never a throw.
 */

interface CardStepShape {
  id: string;
  name: string;
  completedAt?: string;
}

interface CardTaskShape {
  ref: string;
  projectId: string;
  status: string;
  activeStepId?: string;
  craftbookId: string;
  craftbookName: string;
  recommends: unknown;
  steps: CardStepShape[];
}

const TERMINAL_STATUSES = new Set(['complete', 'canceled']);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Pull the card-relevant slice out of a structuredContent `task`, or undefined on any shape miss. */
function cardTaskShape(sc: Record<string, unknown>): CardTaskShape | undefined {
  const task = asRecord(sc.task);
  if (!task) return undefined;
  const ref = asString(task.ref);
  const projectId = asString(task.projectId);
  const status = asString(task.status);
  const craftbook = asRecord(task.craftbook);
  if (!ref || !projectId || !status || !craftbook) return undefined;
  const craftbookName = asString(craftbook.name);
  if (!craftbookName) return undefined;
  const rawSteps = Array.isArray(craftbook.steps) ? craftbook.steps : undefined;
  if (!rawSteps || rawSteps.length === 0) return undefined;
  const steps: CardStepShape[] = [];
  for (const raw of rawSteps) {
    const step = asRecord(raw);
    const id = step && asString(step.id);
    const name = step && asString(step.name);
    if (!id || !name) return undefined;
    steps.push({
      id,
      name,
      ...(asString(step.completedAt) ? { completedAt: step.completedAt as string } : {}),
    });
  }
  // Prefer the catalog provenance id for the card — artwork lookups key on
  // it. Ad-hoc embedded books have only their generated `craftbook.id`,
  // which simply misses the catalog and falls back to the glyph.
  const mainSource = Array.isArray(task.sourceCraftbookIds)
    ? task.sourceCraftbookIds
        .map(asRecord)
        .find((s) => s && s.role === 'main' && asString(s.catalogId))
    : undefined;
  const craftbookId = (mainSource && asString(mainSource.catalogId)) ?? asString(craftbook.id);
  if (!craftbookId) return undefined;
  return {
    ref,
    projectId,
    status,
    ...(asString(task.activeStepId) ? { activeStepId: task.activeStepId as string } : {}),
    craftbookId,
    craftbookName,
    recommends: craftbook.recommends,
    steps,
  };
}

/**
 * Step status mirrors the UI's `taskStepStatus`: completion is the
 * step's own `completedAt`, activity is the task's `activeStepId` while
 * the task lives — NEVER step order, which lies for books whose review
 * steps loop back (powerpoint-deck's review/evaluate → write).
 */
function snapshotSteps(task: CardTaskShape): ToolCardStep[] {
  const terminal = TERMINAL_STATUSES.has(task.status);
  return task.steps.map((s) => ({
    id: s.id,
    name: s.name,
    status: s.completedAt ? 'done' : !terminal && s.id === task.activeStepId ? 'active' : 'pending',
  }));
}

function externalServicesRecommendation(recommends: unknown): { reason?: string } | undefined {
  if (!Array.isArray(recommends)) return undefined;
  for (const raw of recommends) {
    const entry = asRecord(raw);
    if (entry?.kind !== 'external-services') continue;
    const reason = asString(entry.reason);
    return reason ? { reason } : {};
  }
  return undefined;
}

function startCard(sc: Record<string, unknown>): ToolCallCard | undefined {
  const task = cardTaskShape(sc);
  if (!task) return undefined;
  const details = asRecord(sc.details);
  const recommendation = externalServicesRecommendation(task.recommends);
  return validated({
    kind: 'craftbook-start',
    craftbookId: task.craftbookId,
    craftbookName: task.craftbookName,
    taskRef: task.ref,
    projectId: task.projectId,
    status: task.status,
    ...(task.activeStepId ? { activeStepId: task.activeStepId } : {}),
    steps: snapshotSteps(task),
    ...(details?.reused === true ? { reused: true } : {}),
    ...(recommendation ? { recommendsExternalServices: recommendation } : {}),
  });
}

function advanceCard(
  sc: Record<string, unknown>,
  args: Record<string, unknown> | undefined,
): ToolCallCard | undefined {
  const task = cardTaskShape(sc);
  if (!task) return undefined;
  const completedStepId = (args && asString(args.stepId)) ?? lastCompletedStepId(task.steps);
  if (!completedStepId) return undefined;
  const completedStepName = task.steps.find((s) => s.id === completedStepId)?.name;
  const activeStepName = task.activeStepId
    ? task.steps.find((s) => s.id === task.activeStepId)?.name
    : undefined;
  return validated({
    kind: 'task-step-advance',
    craftbookId: task.craftbookId,
    craftbookName: task.craftbookName,
    taskRef: task.ref,
    projectId: task.projectId,
    status: task.status,
    completedStepId,
    ...(completedStepName ? { completedStepName } : {}),
    ...(task.activeStepId ? { activeStepId: task.activeStepId } : {}),
    ...(activeStepName ? { activeStepName } : {}),
    steps: snapshotSteps(task),
  });
}

function lastCompletedStepId(steps: CardStepShape[]): string | undefined {
  let best: CardStepShape | undefined;
  for (const s of steps) {
    if (!s.completedAt) continue;
    if (!best || s.completedAt >= (best.completedAt ?? '')) best = s;
  }
  return best?.id;
}

/** A persisted card must always match the wire schema — refuse quietly otherwise. */
function validated(candidate: unknown): ToolCallCard | undefined {
  const parsed = ToolCallCardSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Card extraction registry: tool name → snapshot card, or undefined when
 * the tool has no card or the payload doesn't hold what the card needs.
 * Failures and gate rejections are text-only `isError` results with no
 * structuredContent, so they never produce a card by construction.
 */
export function extractToolCard(info: ToolCallEvent): ToolCallCard | undefined {
  if (!info.success) return undefined;
  const sc = asRecord(info.structuredContent);
  if (!sc) return undefined;
  if (info.name === 'invoke_craftbook') return startCard(sc);
  if (info.name === 'advance_task_step') return advanceCard(sc, info.args);
  return undefined;
}
