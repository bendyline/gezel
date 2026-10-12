import { normalizeStepGate } from '../schemas/gate.js';
import type { Craftbook } from '../schemas/index.js';
import { normalizeScriptRefs } from '../schemas/script.js';
import { BUILTIN_TOOLSETS } from '../tools/builtin-groups.js';

/**
 * Why a portable host (the phone) cannot run a craftbook, in words a person
 * can read in New Task — or null when it can. Mirrors `projectTypeHostGap`:
 * a book the host cannot run is shown with its reason, never offered as a
 * launch that fails.
 *
 * The rules are the ones the phone build has always filtered with; they
 * now say which one applies.
 */
export interface CraftbookHost {
  /** Tools a step on this host can call. */
  tools: ReadonlySet<string>;
  /** Standard scripts the host's script runtime carries. */
  standardScripts: ReadonlySet<string>;
  /** Gate check kinds the host's gate evaluator handles. */
  gateCheckKinds: ReadonlySet<string>;
  /** Whether an embedded craftbook script can run here. */
  supportsScript?(name: string, source: string, installed: ReadonlySet<string>): boolean;
}

/**
 * Tool groups the phone does not carry. A step must exclude them explicitly
 * (or list its tools), because a role's grants could otherwise reach for them
 * mid-step; this favours a smaller runnable catalog over guessing from prose.
 */
const UNAVAILABLE_GROUPS = [
  'security-intel',
  'image-intel',
  'entity-intel',
  'archives',
  'data-tables',
  'craftbooks',
  'ai-apps',
  'audio',
  'code-execution',
  'browser-automation',
  'git',
  'web',
  'images',
  'videos',
  'role-delegation',
  'role-delegation-escalation',
];

const KNOWN_TOOLS = new Set(BUILTIN_TOOLSETS.flatMap((group) => group.tools));

/** The structural limits of the portable task runner, with a reason each. */
export function portableCraftbookGap(book: Craftbook): string | null {
  if (book.spawn) return 'Splits into many smaller tasks, which needs the desktop.';
  if (book.hooks?.length || book.commands?.length) {
    return 'Runs commands on your computer, which needs the desktop.';
  }
  if (book.connectors?.length) return 'Reads connected accounts, which needs the desktop.';
  if (book.toolsets?.length) return 'Needs tools installed on the desktop.';
  if (book.requirements?.length) return 'Works on a code repository, which needs the desktop.';
  if (book.capabilityFloor) return 'Needs a larger model than this device runs.';
  for (const step of book.steps) {
    const missingEmbedded = [
      ...normalizeScriptRefs(step.onEnter),
      ...normalizeScriptRefs(step.onExit),
      ...(step.gate ? (normalizeStepGate(step.gate).scripts ?? []) : []),
    ].some((ref) => ref.scope === 'craftbook' && !Object.hasOwn(book.scripts ?? {}, ref.name));
    if (missingEmbedded) return 'Is missing one of its own scripts.';
    if (step.spawnFanout) return 'Splits into many smaller tasks, which needs the desktop.';
    if (step.capabilityFloor) return 'Needs a larger model than this device runs.';
    if (step.branches?.length || step.advanceWhen?.requireChange) {
      return 'Uses steps this device cannot run yet.';
    }
    if (step.gate) {
      const gate = normalizeStepGate(step.gate);
      if (
        gate.at !== 'completion' ||
        gate.reviewer ||
        (gate.onReject && gate.onReject !== step.id)
      ) {
        return 'Has a review step this device cannot run yet.';
      }
    }
  }
  return null;
}

/** Whether the portable runner can run this book on this host, and if not, why. */
export function craftbookHostGap(book: Craftbook, host: CraftbookHost): string | null {
  const structural = portableCraftbookGap(book);
  if (structural) return structural;
  const installed = new Set(Object.keys(book.scripts ?? {}));
  const embedded = new Set(
    Object.entries(book.scripts ?? {})
      .filter(([name, source]) => host.supportsScript?.(name, source, installed) ?? true)
      .map(([name]) => name),
  );
  if (embedded.size !== installed.size) return 'Runs a script this device cannot run.';
  const scriptAvailable = (ref: { scope?: string; name: string }) =>
    ref.scope === 'standard'
      ? host.standardScripts.has(ref.name)
      : ref.scope === 'craftbook' && embedded.has(ref.name);
  for (const step of book.steps) {
    if (
      [...normalizeScriptRefs(step.onEnter), ...normalizeScriptRefs(step.onExit)].some(
        (ref) => !scriptAvailable(ref),
      )
    ) {
      return 'Runs a script this device cannot run.';
    }
    const policy = step.toolPolicy;
    if (!policy) return 'Can use tools this device does not have.';
    if (policy.allowTools) {
      const missing = policy.allowTools.find((name) => !host.tools.has(name));
      if (missing) return `Uses ${missing}, which this device does not have.`;
    } else if (UNAVAILABLE_GROUPS.some((id) => !policy.disallowBuiltinToolsets?.includes(id))) {
      return 'Can use tools this device does not have.';
    }
    const mentioned =
      [step.prompt, step.description].join('\n').match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [];
    const missingTool = mentioned.find((name) => KNOWN_TOOLS.has(name) && !host.tools.has(name));
    if (missingTool) return `Uses ${missingTool}, which this device does not have.`;
    if (step.gate) {
      const gate = normalizeStepGate(step.gate);
      if (
        gate.checks?.some((check) => !host.gateCheckKinds.has(check.kind)) ||
        gate.scripts?.some((ref) => !scriptAvailable(ref))
      ) {
        return 'Checks its work in a way this device cannot yet.';
      }
    }
  }
  return null;
}
