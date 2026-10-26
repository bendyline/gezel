import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import {
  type CraftbookContract,
  type GateCheck,
  type HistoryEvent,
  type Task,
  type TaskCraftbookStep,
  criterionEnforce,
} from '@bendyline/gezel';
import { evaluateGate, gateHistoryEvidence, taskGivenText } from '@bendyline/gezel-service';

/**
 * Grade a finished trial against its book's contract, after the fact and from
 * the trial directory alone, with the runtime's own gate evaluator.
 *
 * This is the strategy benchmark's primary measure. It reads the contract the
 * task was launched with (interpolated, from the task snapshot in
 * `state.json`), the captured workspace and artifacts drawer, and the
 * project's history log, so a trial that timed out before reaching any gate is
 * graded the same way as one that finished. Every criterion with checks is
 * graded, `eval-only` ones included; process files the recipe wrote are not.
 */

export interface CriterionGrade {
  id: string;
  kind: 'acceptance' | 'quality';
  enforce: 'gate' | 'advisory' | 'eval-only';
  text: string;
  /** Null when the criterion has no mechanical checks (a judge question only). */
  pass: boolean | null;
  failures: string[];
}

export interface ContractGrade {
  craftbookId: string;
  taskRef: string;
  strategy?: string;
  renderedAs?: string;
  /** The task's status when the trial ended. */
  status: string;
  criteria: CriterionGrade[];
  /** P1: every acceptance criterion with checks passed. */
  acceptancePassed: boolean;
  /** P2: the fraction of checked criteria (gate and eval-only) that passed. */
  score: number;
  checked: number;
  passed: number;
}

interface TrialState {
  tasks?: { tasks?: Task[] } | Task[];
}

const MAX_LISTED_FILES = 5_000;

/** The book's own task in the trial: the newest non-child task launched from it with a contract. */
export function contractTask(tasks: readonly Task[], craftbookId: string): Task | null {
  const fromBook = tasks.filter(
    (t) =>
      !t.parentTaskRef &&
      t.craftbook.contract &&
      (t.sourceCraftbookIds?.some((s) => s.role === 'main' && s.catalogId === craftbookId) ||
        t.craftbook.id === craftbookId),
  );
  fromBook.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return fromBook[0] ?? null;
}

function within(root: string, file: string): string | null {
  const full = resolve(root, file.replace(/^\.?\/+/, ''));
  return full === root || full.startsWith(`${root}${sep}`) ? full : null;
}

async function readText(root: string, file: string): Promise<string | null> {
  const full = within(root, file);
  if (!full) return null;
  try {
    return await readFile(full, 'utf8');
  } catch {
    return null;
  }
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (out.length >= MAX_LISTED_FILES) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push(relative(root, full).split(sep).join('/'));
    }
  }
  await walk(root);
  return out;
}

async function readBytes(root: string, file: string): Promise<Uint8Array | null> {
  const full = within(root, file);
  if (!full) return null;
  try {
    return new Uint8Array(await readFile(full));
  } catch {
    return null;
  }
}

/** A gate reader over a finished trial's saved workspace and artifacts drawer. */
export function trialReader(trialDir: string, projectId: string) {
  const workspace = resolve(trialDir, 'workspace', projectId);
  const artifacts = resolve(trialDir, 'artifacts', projectId);
  return {
    read: (file: string) => readText(workspace, file),
    list: () => listFiles(workspace),
    readBytes: (file: string) => readBytes(workspace, file),
    readArtifact: (file: string) => readText(artifacts, file),
    listArtifacts: () => listFiles(artifacts),
    readArtifactBytes: (file: string) => readBytes(artifacts, file),
  };
}

async function readHistory(trialDir: string, projectId: string): Promise<HistoryEvent[]> {
  try {
    const raw = await readFile(join(trialDir, 'project-history', `${projectId}.jsonl`), 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as HistoryEvent];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** Contract checks read evidence across the whole task, as the runtime gate does. */
function taskWide(checks: readonly GateCheck[]): GateCheck[] {
  return checks.map((check) =>
    (check.kind === 'researchEvidence' || check.kind === 'commandEvidence') && !check.window
      ? { ...check, window: 'task' as const }
      : check,
  );
}

export async function gradeContract(
  trialDir: string,
  craftbookId: string,
): Promise<ContractGrade | null> {
  let state: TrialState;
  try {
    state = JSON.parse(await readFile(join(trialDir, 'state.json'), 'utf8')) as TrialState;
  } catch {
    return null;
  }
  const tasks = Array.isArray(state.tasks) ? state.tasks : (state.tasks?.tasks ?? []);
  const task = contractTask(tasks, craftbookId);
  if (!task?.craftbook.contract) return null;
  const contract: CraftbookContract = task.craftbook.contract;
  const reader = trialReader(trialDir, task.projectId);
  const events = await readHistory(trialDir, task.projectId);
  const history = {
    listEvents: async (q: { kinds?: string[]; from?: string }) =>
      events.filter((e) => (!q.kinds || q.kinds.includes(e.kind)) && (!q.from || e.at >= q.from)),
  } as unknown as Parameters<typeof gateHistoryEvidence>[0];
  const steps = task.craftbook.steps;
  const step: TaskCraftbookStep =
    steps.find((s) => s.terminal) ?? steps.find((s) => s.id === task.activeStepId) ?? steps[0]!;
  const deps = {
    ...gateHistoryEvidence(history, task.projectId, task, step, reader),
    givenText: taskGivenText(task, new Date(task.createdAt)),
  };

  const criteria: CriterionGrade[] = [];
  for (const criterion of contract.criteria) {
    const enforce = criterionEnforce(criterion);
    const checks = criterion.checks ?? [];
    if (checks.length === 0) {
      criteria.push({
        id: criterion.id,
        kind: criterion.kind,
        enforce,
        text: criterion.text,
        pass: null,
        failures: [],
      });
      continue;
    }
    const result = await evaluateGate(taskWide(checks), reader, deps);
    criteria.push({
      id: criterion.id,
      kind: criterion.kind,
      enforce,
      text: criterion.text,
      pass: result.pass,
      failures: result.failures,
    });
  }
  const graded = criteria.filter((c) => c.pass !== null && c.enforce !== 'advisory');
  const passed = graded.filter((c) => c.pass).length;
  const acceptance = criteria.filter((c) => c.kind === 'acceptance' && c.pass !== null);
  return {
    craftbookId,
    taskRef: task.ref,
    ...(task.strategy ? { strategy: task.strategy } : {}),
    ...(task.craftbook.renderedAs ? { renderedAs: task.craftbook.renderedAs } : {}),
    status: task.status,
    criteria,
    acceptancePassed: acceptance.every((c) => c.pass === true),
    score: graded.length > 0 ? passed / graded.length : 0,
    checked: graded.length,
    passed,
  };
}
