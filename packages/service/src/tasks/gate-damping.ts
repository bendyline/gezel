import { createHash } from 'node:crypto';

/**
 * Which files a completion gate's verdict is a pure function of, and the
 * hash the repeat-reject damper keys on.
 *
 * The damper skips re-evaluating a gate when "the deliverable" is
 * byte-identical to what the gate last rejected. It used to hash ONE input,
 * the `advanceWhen` file, which is right only while every check reads that
 * same file. invoice-run's `scope` step checkpoints on `billables.json` and
 * gates on `scope.md` as well: an owner that wrote `billables.json` first
 * was auto-advanced, rejected for the missing `scope.md`, then wrote
 * `scope.md` three times and heard "scope.md not found" three more times,
 * because the checkpoint bytes never changed and the cached verdict was
 * replayed until the plateau ladder paused the task (2026-09-20). Same
 * defect as the scripted-gate carve-out, one layer down: a byte-identical
 * checkpoint does not imply the same verdict.
 *
 * So the hash covers every file the gate reads, a missing file hashes
 * differently from an empty one, and a gate with any check whose verdict
 * depends on something other than one file's bytes (receipts, history,
 * directories, source corpora, an LLM) is never damped. Re-evaluating a
 * declarative check is cheap, and the plateau ladder still ends a loop.
 */

export interface GateDampingCheck {
  kind: string;
  file?: string;
  artifact?: boolean;
}

export interface GateDampingGate {
  checks?: readonly GateDampingCheck[];
  scripts: readonly unknown[];
}

export interface GateDampingStep {
  advanceWhen?: { file: string; artifact?: boolean } | undefined;
}

export interface GateDampingInput {
  file: string;
  artifact: boolean;
}

/** Checks whose verdict is a pure function of `file`'s bytes and static arguments. */
export const SINGLE_FILE_GATE_CHECK_KINDS: ReadonlySet<string> = new Set([
  'contains',
  'notContains',
  'minBytes',
  'sniff',
  'cssMinBytes',
  'csvShape',
  'htmlLint',
  'jsParses',
  'jsonPathEquals',
  'planStructure',
  'recordSchema',
  'tableShape',
  'valueGrounding',
]);

/**
 * The files whose bytes decide this gate, checkpoint first, or null when
 * the gate must not be damped: a scripted gate, a check that reads beyond
 * one file, or nothing to hash at all.
 */
export function gateDampingInputs(
  gate: GateDampingGate,
  step: GateDampingStep,
): GateDampingInput[] | null {
  if (gate.scripts.length > 0) return null;
  const inputs = new Map<string, GateDampingInput>();
  const add = (file: string | undefined, artifact: boolean | undefined) => {
    if (!file) return;
    const key = `${artifact ? 'a' : 'w'}:${file}`;
    if (!inputs.has(key)) inputs.set(key, { file, artifact: artifact === true });
  };
  add(step.advanceWhen?.file, step.advanceWhen?.artifact);
  for (const check of gate.checks ?? []) {
    if (!SINGLE_FILE_GATE_CHECK_KINDS.has(check.kind)) return null;
    add(check.file, check.artifact);
  }
  return inputs.size > 0 ? [...inputs.values()] : null;
}

/**
 * Hash of every damping input's bytes, or undefined when the gate must not
 * be damped or none of its inputs exist yet (nothing was resubmitted).
 */
export async function gateDampingHash(
  gate: GateDampingGate,
  step: GateDampingStep,
  read: (file: string, artifact: boolean) => Promise<string | null>,
): Promise<string | undefined> {
  const inputs = gateDampingInputs(gate, step);
  if (!inputs) return undefined;
  const hash = createHash('sha256');
  let present = 0;
  for (const input of inputs) {
    const content = await read(input.file, input.artifact);
    if (content !== null) present += 1;
    hash.update(`${input.artifact ? 'a' : 'w'}:${input.file}\0`);
    hash.update(content === null ? '\0missing\0' : `${content.length}\0${content}\0`);
  }
  return present === 0 ? undefined : hash.digest('hex');
}
