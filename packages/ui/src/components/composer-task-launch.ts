import {
  type CatalogItemSummary,
  type CraftbookTemplateManifest,
  type LaunchTaskFromSessionRequest,
  type PromptDraftTaskLaunch,
  type TaskAssignee,
  type TaskInputSource,
  type TurnIntentPlan,
  craftbookInputParams,
  launchFormParamSchema,
  mainContentParamKey,
  paramAsksUser,
  unmetParamAlternatives,
} from '@bendyline/gezel';
import type { CraftbookInputValue } from './craftbook-input/CraftbookInputField.js';

/**
 * Pure helpers behind the composer's attached task: what the New Task
 * dialog hands over, what the strip shows, whether Send may go, how a
 * daemon route suggestion merges with what the person already chose, and
 * what the launch route receives. Editor-free so every rule is a unit test.
 */

export type LaunchOrigin = PromptDraftTaskLaunch['origin'];

/** A suggestion the person dismissed; the same text must not resuggest it. */
export interface SuppressedSuggestion {
  craftbookId: string;
  text: string;
}

export interface LaunchReadiness {
  ready: boolean;
  /** Why Send is held back — shown as the key's title. */
  reason?: string;
}

/** Package the dialog's configured state as the launch the composer keeps. */
export function taskLaunchFromDialog(args: {
  manifest: CraftbookTemplateManifest;
  item: CatalogItemSummary;
  params: Record<string, unknown>;
  inputValues: Record<string, CraftbookInputValue>;
  title: string;
  assignee: TaskAssignee | null;
  origin: LaunchOrigin;
}): PromptDraftTaskLaunch {
  const inputs: Record<string, TaskInputSource> = {};
  const inputLabels: NonNullable<PromptDraftTaskLaunch['inputLabels']> = {};
  for (const input of craftbookInputParams(args.manifest.paramSchema)) {
    const value = args.inputValues[input.key];
    if (!value?.source) continue;
    inputs[input.key] = value.source;
    const label: { label?: string; fileCount?: number } = {};
    if (value.label) label.label = value.label;
    if (value.fileCount !== undefined) label.fileCount = value.fileCount;
    if (Object.keys(label).length > 0) inputLabels[input.key] = label;
  }
  const title = args.title.trim();
  return {
    craftbookId: args.manifest.id,
    ...(args.item.sourceId ? { craftbookSourceId: args.item.sourceId } : {}),
    craftbookName: args.manifest.name,
    ...(title && title !== args.manifest.name ? { title } : {}),
    ...(args.assignee ? { assignee: args.assignee } : {}),
    params: args.params,
    ...(Object.keys(inputs).length > 0 ? { inputs } : {}),
    ...(Object.keys(inputLabels).length > 0 ? { inputLabels } : {}),
    origin: args.origin,
  };
}

/** The dialog's input fields, restored from a parked launch. */
export function inputValuesFromLaunch(
  launch: PromptDraftTaskLaunch,
): Record<string, CraftbookInputValue> {
  const out: Record<string, CraftbookInputValue> = {};
  for (const [key, source] of Object.entries(launch.inputs ?? {})) {
    const label = launch.inputLabels?.[key];
    out[key] = {
      source,
      ...(label?.label ? { label: label.label } : {}),
      ...(label?.fileCount !== undefined ? { fileCount: label.fileCount } : {}),
    };
  }
  return out;
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * The same required-input and required-param checks the dialog runs before
 * "Create & start", so Send and the dialog cannot disagree about whether a
 * launch is complete. No manifest yet means the catalog has not answered;
 * Send waits rather than guessing.
 */
export function launchReadiness(
  launch: PromptDraftTaskLaunch,
  manifest: CraftbookTemplateManifest | null,
): LaunchReadiness {
  if (!manifest) return { ready: false, reason: 'Loading the craftbook…' };
  for (const input of craftbookInputParams(manifest.paramSchema)) {
    if (input.required && !launch.inputs?.[input.key]) {
      return {
        ready: false,
        reason: `Choose the ${input.title.toLowerCase()} this craftbook works on.`,
      };
    }
  }
  // The message being sent is the book's main content, so that param is
  // never a reason to hold Send.
  const mainKey = mainContentParamKey(manifest.paramSchema);
  const messageFills = mainKey ? [mainKey] : [];
  const schema = launchFormParamSchema(manifest.paramSchema, messageFills) as
    | { required?: unknown }
    | undefined;
  const required = Array.isArray(schema?.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : [];
  const missing = required.find((key) => isBlank(launch.params[key]));
  if (missing) return { ready: false, reason: `"${missing}" is required.` };
  const unmet = unmetParamAlternatives(manifest.paramSchema, launch.params, [
    ...messageFills,
    ...Object.keys(launch.inputs ?? {}),
  ]);
  if (unmet) return { ready: false, reason: paramAlternativesMessage(manifest.paramSchema, unmet) };
  return { ready: true };
}

/**
 * Plain words for a "fill at least one of these" rule, naming each
 * alternative by its field title: `Fill in Source file, Topic, or Source
 * material.` `labels` renames a field a surface shows under its own name —
 * the composer dialog's Brief stands in for the book's main content param.
 */
export function paramAlternativesMessage(
  paramSchema: unknown,
  alternatives: string[][],
  labels: Record<string, string> = {},
): string {
  const properties = ((paramSchema as { properties?: Record<string, unknown> } | undefined)
    ?.properties ?? {}) as Record<string, { title?: unknown } | undefined>;
  const nameOf = (key: string): string => {
    if (labels[key]) return labels[key];
    const title = properties[key]?.title;
    return typeof title === 'string' && title.trim() ? title.trim() : key;
  };
  const names = alternatives.map((keys) => keys.map(nameOf).join(' and '));
  if (names.length === 1) return `Fill in ${names[0]}.`;
  if (names.length === 2) return `Fill in ${names[0]} or ${names[1]}.`;
  return `Fill in ${names.slice(0, -1).join(', ')}, or ${names[names.length - 1]}.`;
}

const PREVIEW_VALUE_MAX = 32;
const PREVIEW_ENTRY_MAX = 3;

function clip(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_VALUE_MAX ? `${flat.slice(0, PREVIEW_VALUE_MAX - 1)}…` : flat;
}

/**
 * The strip's one-line readout of the launch: `topic: France · audience:
 * executives`, in the book's own property order, inputs as `source: Notes
 * (3 files)`, at most three entries then `+N more`. `full` is the unclipped
 * list for the title attribute. Params a person is never asked for stay out
 * even when the launch carries a value: the strip mirrors the form.
 */
export function formatTaskLaunchPreview(
  launch: PromptDraftTaskLaunch,
  manifest: CraftbookTemplateManifest | null,
): { short: string; full: string } {
  const properties = manifest
    ? ((launchFormParamSchema(manifest.paramSchema) as { properties?: Record<string, unknown> })
        ?.properties ?? {})
    : {};
  const allProperties = (manifest?.paramSchema?.properties ?? {}) as Record<string, unknown>;
  const unasked = new Set(
    Object.entries(allProperties)
      .filter(([, property]) => !paramAsksUser(property))
      .map(([key]) => key),
  );
  const declared = Object.keys(properties);
  const paramKeys = [
    ...declared.filter((key) => key in launch.params),
    ...Object.keys(launch.params).filter((key) => !declared.includes(key) && !unasked.has(key)),
  ];
  const inputKeys = Object.keys(launch.inputs ?? {});
  const entries: Array<{ key: string; value: string }> = [];
  for (const key of inputKeys) {
    const label = launch.inputLabels?.[key];
    const name = label?.label ?? key;
    const count =
      label?.fileCount !== undefined
        ? ` (${label.fileCount} file${label.fileCount === 1 ? '' : 's'})`
        : '';
    entries.push({ key, value: `${name}${count}` });
  }
  for (const key of paramKeys) {
    if (inputKeys.includes(key)) continue;
    const raw = launch.params[key];
    if (isBlank(raw) || typeof raw === 'object') continue;
    entries.push({ key, value: String(raw) });
  }
  const full = entries.map((entry) => `${entry.key}: ${entry.value}`).join(' · ');
  const shown = entries
    .slice(0, PREVIEW_ENTRY_MAX)
    .map((entry) => `${entry.key}: ${clip(entry.value)}`);
  const rest = entries.length - shown.length;
  const short = [...shown, ...(rest > 0 ? [`+${rest} more`] : [])].join(' · ');
  return { short, full };
}

/**
 * Fold a daemon route suggestion into the attachment. A person's own pick
 * always wins. A suggestion attaches only when the plan already satisfies
 * the book (an incomplete suggestion would make Send a dead key), replaces
 * an earlier suggestion, and clears when the plan goes quiet. A dismissed
 * suggestion stays dismissed for the same text.
 */
export function mergeSuggestedLaunch(args: {
  current: PromptDraftTaskLaunch | null;
  plan: TurnIntentPlan | null;
  text: string;
  suppressed: SuppressedSuggestion | null;
  manifest: CraftbookTemplateManifest | null;
}): PromptDraftTaskLaunch | null {
  const { current, plan } = args;
  if (current?.origin === 'user') return current;
  const craftbook = plan?.visible && plan.route === 'craftbook' ? plan.craftbook : undefined;
  if (!craftbook) return current?.origin === 'suggested' ? null : current;
  if (
    args.suppressed &&
    args.suppressed.craftbookId === craftbook.id &&
    args.suppressed.text === args.text.trim()
  ) {
    return current?.origin === 'suggested' ? null : current;
  }
  const params = craftbook.invocation.params ?? {};
  const candidate: PromptDraftTaskLaunch = {
    craftbookId: craftbook.id,
    craftbookName: craftbook.name,
    params,
    origin: 'suggested',
  };
  // The manifest may still be loading; keep the earlier suggestion for the
  // same book rather than flickering it away, and attach nothing new until
  // readiness can be judged.
  if (!args.manifest || args.manifest.id !== craftbook.id) {
    return current?.craftbookId === craftbook.id ? current : null;
  }
  if (!launchReadiness(candidate, args.manifest).ready) {
    return current?.origin === 'suggested' ? null : current;
  }
  if (current?.craftbookId === craftbook.id && sameParams(current.params, params)) return current;
  return candidate;
}

function sameParams(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key, index) => key === keysB[index] && a[key] === b[key]);
}

/** The request body the launch route takes, with the display-only fields dropped. */
export function launchRequestBody(
  launch: PromptDraftTaskLaunch,
): LaunchTaskFromSessionRequest['launch'] {
  return {
    craftbookId: launch.craftbookId,
    ...(launch.craftbookSourceId ? { craftbookSourceId: launch.craftbookSourceId } : {}),
    ...(launch.title ? { title: launch.title } : {}),
    ...(launch.assignee ? { assignee: launch.assignee } : {}),
    params: launch.params,
    ...(launch.inputs && Object.keys(launch.inputs).length > 0 ? { inputs: launch.inputs } : {}),
  };
}

/** Staging ids an upload input holds — what a replace or a dismiss must free. */
export function uploadStagingIds(launch: PromptDraftTaskLaunch | null): string[] {
  if (!launch?.inputs) return [];
  return Object.values(launch.inputs).flatMap((source) =>
    source.from === 'upload' ? [source.stagingId] : [],
  );
}
