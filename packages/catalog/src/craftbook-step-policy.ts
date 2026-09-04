import type {
  CraftbookDoc,
  CraftbookStepOutputMedium,
  CraftbookStepWritableOutputMedium,
  NewCraftbookStep,
} from '@bendyline/gezel';
import { deliverableKindForStep, requiredOutputMediaForGate } from '@bendyline/gezel';
import { BUILTIN_TOOLSETS } from './builtin-toolsets.js';

const BUILTIN_BY_ID = new Map(BUILTIN_TOOLSETS.map((group) => [group.id, group]));

const SPECIALIZED_GROUP_SIGNALS: Readonly<Record<string, RegExp>> = {
  'security-intel': /\b(?:security|vulnerabilit|threat|attack surface|taint|secret scan)\b/i,
  'image-intel':
    /\b(?:image library|photo library|similar images|search_images|describe_folder)\b/i,
  'entity-intel': /\b(?:find_entity|entity mentions|cross-file entit)\b/i,
  archives: /\b(?:archive|zip|tar|extract_archive|list_archive)\b/i,
  'data-tables': /\b(?:sql|query_table|describe_table|list_tables|data table)\b/i,
  craftbooks: /\b(?:craftbook_(?:read|write|add|remove|reorder|update)|edit (?:the )?craftbook)\b/i,
  'ai-apps': /\b(?:export_ai_app|import_ai_app|\.gezapp\b|ai app bundle)\b/i,
  audio: /\b(?:transcribe_audio|synthesize_speech|speech[- ]to[- ]text|text[- ]to[- ]speech)\b/i,
  videos: /\b(?:generate_video|video generation|generate (?:a )?video)\b/i,
  images:
    /\b(?:generate_image|render_image|describe_image|read_image|image generation|generate (?:an? )?image|render (?:a )?(?:chart|diagram))\b/i,
  'browser-automation':
    /\b(?:run_playwright_script|playwright|browser automation|headless browser)\b/i,
  git: /\b(?:run_git|github_|git\b|pull request|\bPR\s*#?\d*)\b/i,
  web: /\b(?:web_search|wikipedia_|fetch_url|live web|search the web|external source|https?:\/\/)\b/i,
  'team-management':
    /\b(?:ensure_gezel|message_gezel|create_gezel|update_gezel|start_project|delegate|hand (?:the )?work)\b/i,
  'role-delegation': /\b(?:ask_specialist|ask_gezel|delegate_[a-z]|consult_[a-z])\b/i,
  'role-delegation-escalation': /\b(?:escalat|second opinion|ask_specialist|consult_[a-z])\b/i,
};

const DECLARED_TOOLSET_SIGNALS: Readonly<Record<string, RegExp>> = {
  docblocks:
    /\b(?:docblocks|list_roots|convert_document|preview_document|save_artifact|document artifact uri)\b/i,
  github: SPECIALIZED_GROUP_SIGNALS.git!,
  '@playwright/mcp': /\b(?:playwright|browser_|browser automation|headless browser)\b/i,
  'microsoft-playwright-mcp': /\b(?:playwright|browser_|browser automation|headless browser)\b/i,
};

const TASK_NOTE_OUTPUT_SIGNAL =
  /\bwrite_task_note\b|\b(?:write|record|append|summarize)[^.!?\n]{0,100}\b(?:task\s+)?notes?\b|\bwrite\s+PASS\s*\/\s*FAIL\b/i;

function procedureText(step: NewCraftbookStep): string {
  return [step.name, step.description, step.prompt, step.suggestedRole].filter(Boolean).join('\n');
}

function gateChecks(step: NewCraftbookStep): Array<Record<string, unknown>> {
  const gate = step.gate;
  return gate && 'checks' in gate && Array.isArray(gate.checks)
    ? (gate.checks as Array<Record<string, unknown>>)
    : [];
}

/** Resolve the authored blueprint's primary result drawer without prompt inference. */
export function outputMediumForCraftbookBlueprint(
  step: NewCraftbookStep,
): CraftbookStepOutputMedium {
  const gateRequiredMedia = [...requiredOutputMediaForGate(step.gate)];
  if (step.toolPolicy?.outputMedium) {
    // A gate is an executable exit contract. It outranks a contradictory
    // `none` annotation, which would otherwise author a step that cannot
    // produce the state its own gate inspects.
    if (step.toolPolicy.outputMedium === 'none' && gateRequiredMedia[0]) {
      return gateRequiredMedia[0];
    }
    return step.toolPolicy.outputMedium;
  }
  if (step.deliverable?.path) return step.deliverable.artifact ? 'artifact' : 'workspace';
  if (step.advanceWhen?.file) return step.advanceWhen.artifact ? 'artifact' : 'workspace';
  const fileCheck = gateChecks(step).find(
    (check) => typeof check.file === 'string' && check.file.length > 0,
  );
  if (fileCheck) return fileCheck.artifact === true ? 'artifact' : 'workspace';
  if (gateRequiredMedia[0]) return gateRequiredMedia[0];
  const text = procedureText(step);
  if (
    /\b(?:write_file|append_to_file|replace_in_file|replace_lines|apply_patch|insert_at_marker)\b/i.test(
      text,
    )
  ) {
    return 'workspace';
  }
  if (/\bwrite_artifact\b/i.test(text)) return 'artifact';
  return TASK_NOTE_OUTPUT_SIGNAL.test(text) ? 'task-note' : 'none';
}

function additionalOutputMediaForStep(
  step: NewCraftbookStep,
  primary: CraftbookStepOutputMedium,
): CraftbookStepWritableOutputMedium[] {
  if (primary === 'none') return [];
  const text = procedureText(step);
  const out = new Set(step.toolPolicy?.additionalOutputMedia ?? []);
  for (const medium of requiredOutputMediaForGate(step.gate)) out.add(medium);
  if (
    /\b(?:write_file|append_to_file|replace_in_file|replace_lines|apply_patch|insert_at_marker)\b|\b(?:edit|change|patch|fix)\b[^.!?\n]{0,80}\b(?:actual|workspace|source|project)\s+files?\b/i.test(
      text,
    )
  ) {
    out.add('workspace');
  }
  if (/\bwrite_artifact\b/i.test(text)) out.add('artifact');
  if (TASK_NOTE_OUTPUT_SIGNAL.test(text)) out.add('task-note');
  out.delete(primary as CraftbookStepWritableOutputMedium);
  return [...out].sort();
}

function groupToolMentioned(groupId: string, text: string): boolean {
  const group = BUILTIN_BY_ID.get(groupId);
  return group?.tools.some((tool) => new RegExp(`\\b${tool}\\b`, 'i').test(text)) ?? false;
}

function needsCodeExecution(step: NewCraftbookStep, text: string): boolean {
  const kind = step.deliverable?.kind ?? deliverableKindForStep(step);
  if (
    kind === 'code-module' ||
    kind === 'code-with-tests' ||
    kind === 'data-file' ||
    kind === 'json' ||
    kind === 'audio-file'
  ) {
    return true;
  }
  if (
    gateChecks(step).some((check) => check.kind === 'nodeRuns' || check.kind === 'commandEvidence')
  ) {
    return true;
  }
  if (step.onExit !== undefined) return true;
  if (groupToolMentioned('code-execution', text)) return true;
  return /\b(?:execute|npm|npx|sandbox|compile|transform)\b|\b(?:re-?run|run)[^.!?\n]{0,50}\b(?:test|script|build|command|suite)\b/i.test(
    text,
  );
}

function builtinDisallows(
  step: NewCraftbookStep,
  medium: CraftbookStepOutputMedium,
  additionalMedia: readonly CraftbookStepWritableOutputMedium[],
): string[] {
  const text = procedureText(step);
  const out = new Set(step.toolPolicy?.disallowBuiltinToolsets ?? []);
  const media = new Set<CraftbookStepOutputMedium>([medium, ...additionalMedia]);

  // The output contract already removes individual wrong-drawer writers;
  // these group-level denials also keep broad custom role overrides lean.
  if (!media.has('workspace')) out.add('workspace-fs-write');
  const consumesArtifact = step.consumes?.some((input) => input.artifact) === true;
  const mentionsArtifact =
    /\b(?:read_artifact|list_artifacts|grep_artifact|artifacts drawer)\b/i.test(text);
  if (!media.has('artifact') && !consumesArtifact && !mentionsArtifact) out.add('artifacts');

  for (const [groupId, signal] of Object.entries(SPECIALIZED_GROUP_SIGNALS)) {
    if (groupId === 'web' && /research/i.test(step.suggestedRole ?? '')) continue;
    if (!signal.test(text) && !groupToolMentioned(groupId, text)) out.add(groupId);
  }
  if (!needsCodeExecution(step, text)) out.add('code-execution');

  return [...out].sort();
}

function explicitlyDeniedExternalToolsets(
  step: NewCraftbookStep,
  declaredIds: readonly string[],
): string[] {
  const text = procedureText(step);
  const out = new Set(step.toolPolicy?.disallowToolsets ?? []);
  for (const id of declaredIds) {
    // Built-in needs are governed by the stable group field below. Keeping
    // them out of the exact-id list also handles roles that receive the
    // group by default rather than by an installed-toolset record.
    if (id.startsWith('builtin.')) continue;
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const denial = new RegExp(
      `(?:\\bdo\\s+not\\b|\\bdon't\\b|\\bnever\\b)[^.!?\\n]{0,160}\\b(?:call|use|invoke|run|access|load)\\s+(?:the\\s+)?${escaped}(?=$|[^A-Za-z0-9_-])`,
      'iu',
    );
    const positiveSignal = DECLARED_TOOLSET_SIGNALS[id] ?? new RegExp(escaped, 'iu');
    if (denial.test(text) || !positiveSignal.test(text)) out.add(id);
  }
  return [...out].sort();
}

function withDefaultPolicy<T extends NewCraftbookStep>(step: T, declaredIds: readonly string[]): T {
  const outputMedium = outputMediumForCraftbookBlueprint(step);
  const additionalOutputMedia = additionalOutputMediaForStep(step, outputMedium);
  const disallowBuiltinToolsets = builtinDisallows(step, outputMedium, additionalOutputMedia);
  const disallowToolsets = explicitlyDeniedExternalToolsets(step, declaredIds);
  return {
    ...step,
    toolPolicy: {
      ...(disallowToolsets.length > 0 ? { disallowToolsets } : {}),
      ...(disallowBuiltinToolsets.length > 0 ? { disallowBuiltinToolsets } : {}),
      outputMedium,
      ...(additionalOutputMedia.length > 0 ? { additionalOutputMedia } : {}),
    },
  } as T;
}

/**
 * Add deterministic subtractive policies to every top-level and fanout step.
 * Existing authored denials are preserved; generated defaults only add
 * groups for which the procedure carries no positive signal.
 */
export function applyDefaultCraftbookStepPolicies(doc: CraftbookDoc): CraftbookDoc {
  const declaredIds = (doc.toolsets ?? []).map((need) => need.toolsetId);
  return {
    ...doc,
    steps: doc.steps.map((step) => withDefaultPolicy(step, declaredIds)),
    ...(doc.spawn
      ? {
          spawn: {
            ...doc.spawn,
            steps: doc.spawn.steps.map((step) => withDefaultPolicy(step, declaredIds)),
          },
        }
      : {}),
  };
}
