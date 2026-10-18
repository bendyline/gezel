import { z } from 'zod';

/**
 * The options `suggest_work` offers a coordinator for one request, and the
 * handle `start_work` takes back.
 *
 * Two shapes. An **action** is something the runtime does on the
 * coordinator's behalf — launch a craftbook, open a typed or a crew
 * project, start a task here, switch recurring work on or off — and it is
 * reached only through `start_work({ option: id })`, with its arguments
 * bound on the server from the person's own message. **Guidance** is a
 * verdict the coordinator acts on with tools it already has: answer in chat,
 * ask the person, hand the work to a specialist, write a new recipe. Keeping
 * guidance out of `start_work` keeps every question card on
 * `ask_user_question`, the one tool the turn loop recognizes as posting one.
 *
 * Ids are kind-prefixed and readable (`craftbook:status-report`,
 * `type:trip-planner`) so a model that skipped `suggest_work` can still name
 * one, and so the classifier can read the route back from a transcript.
 */

export const WORK_ACTION_KINDS = [
  'craftbook',
  'project-type',
  'new-project',
  'task-here',
  'recurring',
] as const;
export type WorkActionKind = (typeof WORK_ACTION_KINDS)[number];

export const WORK_GUIDANCE_KINDS = ['self', 'ask', 'specialist', 'author'] as const;
export type WorkGuidanceKind = (typeof WORK_GUIDANCE_KINDS)[number];

const OptionText = z.string().min(1).max(240);

export const WorkActionOptionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('craftbook'),
    id: z.string().min(1),
    craftbookId: z.string().min(1),
    name: OptionText,
    description: OptionText.optional(),
    /** The request named an output format this book produces exactly. */
    exact: z.boolean().optional(),
    /** Toolsets the book needs that the project does not have yet. */
    setupRequired: z.array(z.string().min(1)).optional(),
    /** Invocation params the server read from the message (a deck's topic). */
    params: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    kind: z.literal('project-type'),
    id: z.string().min(1),
    typeId: z.string().min(1),
    name: OptionText,
    description: OptionText.optional(),
  }),
  z.object({
    kind: z.literal('new-project'),
    id: z.literal('new-project'),
    name: OptionText,
    description: OptionText.optional(),
  }),
  z.object({
    kind: z.literal('task-here'),
    id: z.literal('task-here'),
    projectId: z.string().min(1),
    name: OptionText,
    description: OptionText.optional(),
  }),
  z.object({
    kind: z.literal('recurring'),
    id: z.string().min(1),
    key: z.string().min(1),
    /** True: pause work that is running. False: switch suggested work on. */
    pause: z.boolean(),
    name: OptionText,
    description: OptionText.optional(),
  }),
]);
export type WorkActionOption = z.infer<typeof WorkActionOptionSchema>;

export const WorkGuidanceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('self'),
    /** On-roster tools that serve an answer: consult_*, status, search. */
    tools: z.array(z.string().min(1)).max(6),
  }),
  z.object({
    kind: z.literal('ask'),
    question: OptionText,
    choices: z.array(z.string().min(1).max(120)).min(2).max(4),
  }),
  z.object({
    kind: z.literal('specialist'),
    role: z.string().min(1),
    tool: z.string().min(1),
  }),
  z.object({
    kind: z.literal('author'),
  }),
]);
export type WorkGuidance = z.infer<typeof WorkGuidanceSchema>;

export const SuggestWorkResultSchema = z.object({
  schemaVersion: z.literal(1),
  /** The request the options were ranked for, as the server read it. */
  request: z.string().min(1),
  projectId: z.string().min(1),
  /**
   * The request reads as a question or a follow-up, not a request for work:
   * answer it, and treat the options as the exception.
   */
  question: z.boolean(),
  /** Best first; at most four. */
  options: z.array(WorkActionOptionSchema).max(4),
  /** Verdicts in the order they apply. */
  guidance: z.array(WorkGuidanceSchema).max(4),
});
export type SuggestWorkResult = z.infer<typeof SuggestWorkResultSchema>;

export const SuggestWorkRequestSchema = z.object({
  request: z.string().min(1).max(120_000),
  /** The asking session's model-facing tools; the self and specialist verdicts name only these. */
  tools: z.array(z.string().min(1)).max(400).optional(),
});
export type SuggestWorkRequest = z.infer<typeof SuggestWorkRequestSchema>;

/** Ids the grammar knows, parsed. Unknown prefixes return null. */
export type ParsedWorkOptionId =
  | { kind: 'craftbook'; craftbookId: string }
  | { kind: 'project-type'; typeId: string }
  | { kind: 'new-project' }
  | { kind: 'task-here' }
  | { kind: 'recurring'; key: string; pause: boolean };

export function workOptionId(option: ParsedWorkOptionId): string {
  switch (option.kind) {
    case 'craftbook':
      return `craftbook:${option.craftbookId}`;
    case 'project-type':
      return `type:${option.typeId}`;
    case 'new-project':
      return 'new-project';
    case 'task-here':
      return 'task-here';
    case 'recurring':
      return `${option.pause ? 'recurring-pause' : 'recurring'}:${option.key}`;
  }
}

/**
 * Read an option id back. Lenient about the surrounding noise a small model
 * adds when copying one — brackets, quotes, a trailing period — and strict
 * about the grammar itself.
 */
export function parseWorkOptionId(raw: string): ParsedWorkOptionId | null {
  const id = raw
    .trim()
    .replace(/^[\s[("'`]+|[\s\])"'`.,;:]+$/g, '')
    .trim();
  if (id === 'new-project') return { kind: 'new-project' };
  if (id === 'task-here') return { kind: 'task-here' };
  const match = /^(craftbook|type|recurring|recurring-pause):(.+)$/.exec(id);
  const prefix = match?.[1];
  const rest = match?.[2]?.trim();
  if (!prefix || !rest) return null;
  // A prefix put on an id that is something else: Qwen 3.5 9B wrote
  // `craftbook:new-project` for the listed `new-project` (S1c, 2026-10-17).
  // The id after the prefix wins when it is itself a complete option id.
  const inner = rest === 'new-project' || rest === 'task-here' || /^[a-z-]+:/.test(rest);
  if (inner) {
    const reparsed = parseWorkOptionId(rest);
    if (reparsed) return reparsed;
  }
  if (prefix === 'craftbook') return { kind: 'craftbook', craftbookId: rest };
  if (prefix === 'type') return { kind: 'project-type', typeId: rest };
  return { kind: 'recurring', key: rest, pause: prefix === 'recurring-pause' };
}
