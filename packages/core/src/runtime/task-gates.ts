import { cssMinBytes, fileCountByExt, fileMinBytes, totalMinBytes } from '../checks/files.js';
import { htmlCompleteSniff, htmlGameSniff } from '../checks/html.js';
import { csvShape, dataTableSniff, recordSchema, tableShape } from '../checks/records.js';
import { jsonPathEquals, jsonValid } from '../checks/text.js';
import type { CheckResult, WorkspaceLike } from '../checks/types.js';
import { unresolvedGatePlaceholders } from '../gate-config.js';
import {
  type GateCheck,
  type GateScriptRef,
  GateScriptResultSchema,
  normalizeStepGate,
} from '../schemas/gate.js';
import type { Task, TaskCraftbookStep } from '../schemas/task.js';
import type { PortableStore } from './store.js';
import type { PortableTaskGateResult } from './tasks.js';

export type PortableGateScript = (
  ref: GateScriptRef,
  task: Task,
  step: TaskCraftbookStep,
) => Promise<{ id?: string; status: string; output?: unknown; error?: string; logs?: string }>;
function surface(store: PortableStore, projectId: string, artifact?: boolean): WorkspaceLike {
  const area = artifact ? 'artifacts' : 'workspace';
  return {
    read: (path) => store.readFile(area, projectId, path),
    readBytes: (path) => store.readFileBytes(area, projectId, path),
    list: async () => {
      const listing = await store.listFiles(area, projectId, '', true, { includeHidden: true });
      if (listing.truncated) throw new Error('This gate needs a complete file listing');
      return listing.entries.filter((entry) => !entry.isDirectory).map((entry) => entry.path);
    },
  };
}
async function sniff(ws: WorkspaceLike, file: string, kind: string): Promise<CheckResult> {
  const text = await ws.read(file);
  if (text === null) return { ok: false, detail: `${file} not found` };
  const ok =
    kind === 'nonempty'
      ? !!text.trim()
      : kind === 'json-valid'
        ? jsonValid(text).ok
        : kind === 'data-table'
          ? dataTableSniff(text)
          : kind === 'html-complete'
            ? htmlCompleteSniff(text)
            : kind === 'html-game'
              ? htmlGameSniff(text)
              : false;
  return { ok, detail: ok ? `${file} passed ${kind}` : `${file} did not pass ${kind}` };
}
async function check(ws: WorkspaceLike, item: GateCheck): Promise<CheckResult> {
  switch (item.kind) {
    case 'minBytes':
      return fileMinBytes(ws, item.file, item.bytes);
    case 'totalMinBytes':
      return totalMinBytes(ws, item.files, item.bytes);
    case 'fileCount':
      return fileCountByExt(ws, item.ext, item.min, item.dir, {
        verifyImageBytes: item.verifyImageBytes,
      });
    case 'cssMinBytes':
      return cssMinBytes(ws, item.bytes, item.file);
    case 'sniff':
      return sniff(ws, item.file, item.sniff);
    case 'jsonPathEquals':
      return jsonPathEquals(ws, item.file, item.path, item.value, item.label);
    case 'csvShape':
      return csvShape(await ws.read(item.file), item);
    case 'tableShape':
      return tableShape((await ws.read(item.file)) ?? '', item);
    case 'recordSchema':
      return recordSchema(await ws.read(item.file), item);
    // Regex and executable syntax checks belong in bounded QuickJS, not the
    // UI thread. Unsupported declarative checks fail closed here.
    default:
      throw new Error(`The ${item.kind} gate requires a supported script or desktop execution`);
  }
}
/** Same deterministic predicates as desktop and stdlib; scripts never bypass a
 * failed declarative floor. This evaluator does not mutate task progression. */
export async function evaluatePortableTaskGate(
  store: PortableStore,
  task: Task,
  step: TaskCraftbookStep,
  runScript?: PortableGateScript,
): Promise<PortableTaskGateResult> {
  const scriptRuns: NonNullable<PortableTaskGateResult['scriptRuns']> = [];
  try {
    const gate = step.gate ? normalizeStepGate(step.gate) : undefined;
    if (gate && (gate.at !== 'completion' || gate.reviewer))
      throw new Error('This gate needs desktop review or activation behavior');
    const checks: GateCheck[] = [...(gate?.checks ?? [])];
    if (step.advanceWhen) {
      if (step.advanceWhen.requireChange)
        throw new Error('Change-tracking gates require desktop execution');
      const { file, artifact, minBytes = 1, sniff: kind } = step.advanceWhen;
      checks.push({ kind: 'minBytes', file, artifact, bytes: minBytes });
      if (kind) checks.push({ kind: 'sniff', file, artifact, sniff: kind });
    }
    const unresolved = unresolvedGatePlaceholders({
      at: 'completion',
      legacy: false,
      maxAttempts: gate?.maxAttempts ?? 3,
      checks,
      scripts: gate?.scripts ?? [],
    });
    if (unresolved.length)
      throw new Error(
        `Gate configuration error: ${unresolved.join(', ')} still contains an unresolved template placeholder. Correct the craftbook or launch parameters; writing to the literal placeholder cannot satisfy this gate.`,
      );
    for (const item of checks) {
      const result = await check(
        surface(store, task.projectId, 'artifact' in item ? item.artifact : undefined),
        item,
      );
      if (!result.ok) return { approved: false, message: result.detail };
    }
    let next: string | undefined;
    let handoff: PortableTaskGateResult['handoff'];
    for (const ref of gate?.scripts ?? []) {
      const trail: (typeof scriptRuns)[number] = { scriptName: ref.name };
      scriptRuns.push(trail);
      try {
        if (!runScript) throw new Error('This gate requires the script executor');
        const run = await runScript(ref, task, step);
        trail.runId = run.id;
        if (run.status !== 'ok') {
          trail.logsTail = run.logs?.trim().slice(-2000) || undefined;
          throw new Error(run.error ?? 'The gate script did not complete');
        }
        const parsed = GateScriptResultSchema.safeParse(run.output);
        if (!parsed.success) {
          trail.logsTail = run.logs?.trim().slice(-2000) || undefined;
          throw new Error(
            `Invalid gate result: ${parsed.error.issues[0]?.message ?? 'shape mismatch'}`,
          );
        }
        const verdict = parsed.data;
        if (
          verdict.goto !== undefined &&
          !task.craftbook.steps.some((step) => step.id === verdict.goto)
        )
          throw new Error(`Gate route "${verdict.goto}" is not a declared task step`);
        if (verdict.decision === 'reject')
          return { approved: false, message: verdict.message, next: verdict.goto };
        // Shared desktop contract: first rejection stops evaluation; the last
        // approving script's supplied goto/handoff overrides earlier ones.
        if (verdict.goto !== undefined) next = verdict.goto;
        if (verdict.handoff !== undefined) handoff = verdict.handoff;
      } catch (error) {
        trail.error = error instanceof Error ? error.message : String(error);
        throw new Error(`Gate script "${ref.name}" could not be evaluated: ${trail.error}`);
      }
    }
    return { approved: true, next, handoff };
  } catch (error) {
    return {
      approved: false,
      infrastructureError: true,
      message: error instanceof Error ? error.message : String(error),
      ...(scriptRuns.length ? { scriptRuns } : {}),
    };
  }
}
