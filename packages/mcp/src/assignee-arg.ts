import { z } from 'zod';
import { coerceJsonObject } from './zod-coerce.js';

/*
 * ── Task assignee argument ──────────────────────────────────────────────
 *
 * The model-facing shape used to be the wire struct itself —
 * `{kind:"gezel", gezelId}` / `{kind:"user"}` — which reads as two
 * independent choices: pick a kind, then optionally name someone. A 27B
 * Meester turn duly sent `assignee: {kind:"gezel"}` to mean "have a gezel
 * do it", and `invoke_craftbook` died on `assignee.kind="gezel" requires
 * gezelId`, losing the whole craftbook route on a PPTX request. The intent
 * was right: a craftbook resolves its owner from the entry step's role, so
 * "some gezel" is exactly the default the caller should get.
 *
 * Two changes follow. The argument is now a plain string — a gezel id, a
 * display name, a role-based name, or the literal "user" — so there is no
 * second field to leave blank, and it matches `list_tasks({ assignee })`.
 * The object form stays accepted for callers already sending it, and a
 * kind without an id normalizes to `null`: omit the assignee rather than
 * fail, and let the recipe's step roles decide.
 */

const AssigneeObjectSchema = z.object({
  kind: z.enum(['gezel', 'user']),
  gezelId: z.string().optional(),
});

export type AssigneeArg = string | z.infer<typeof AssigneeObjectSchema>;

/** A gezel reference that still needs resolving to a canonical id. */
export type NormalizedAssignee = { kind: 'user' } | { kind: 'gezel'; ref: string };

export const ASSIGNEE_ARG_DESCRIPTION =
  'Who owns this — a gezel id, display name, or role name ("wren", "Rina", "developer"), or the ' +
  'literal "user" for the human. OMIT it when you have no specific gezel in mind: the owner then ' +
  'mirrors whichever gezel the entry step\'s role resolves to. "gezel" is not a value — it is the ' +
  'default, and passing it as a placeholder is the same as omitting the argument.';

export function assigneeArg() {
  return coerceJsonObject(z.union([z.string(), AssigneeObjectSchema])).describe(
    ASSIGNEE_ARG_DESCRIPTION,
  );
}

const USER_WORDS = new Set(['user', 'the user', 'me', 'human', 'owner']);

/**
 * Placeholders that mean "no one in particular". They arrive as the whole
 * argument (`assignee: "gezel"`) or as a stand-in id (`{kind:"gezel",
 * gezelId:"any"}`) — both say the caller never had a specific gezel, which
 * is a request to fall back to the step roles, not an error.
 */
const UNSPECIFIED_WORDS = new Set([
  'gezel',
  'a gezel',
  'any',
  'any gezel',
  'anyone',
  'someone',
  'auto',
  'automatic',
  'unassigned',
  'none',
  'null',
  'undefined',
  'tbd',
]);

export function normalizeAssigneeArg(
  raw: AssigneeArg | undefined | null,
): NormalizedAssignee | null {
  if (raw === undefined || raw === null) return null;
  const ref = typeof raw === 'string' ? raw : raw.kind === 'user' ? 'user' : (raw.gezelId ?? '');
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const lc = trimmed.toLowerCase();
  if (USER_WORDS.has(lc)) return { kind: 'user' };
  if (UNSPECIFIED_WORDS.has(lc)) return null;
  return { kind: 'gezel', ref: trimmed };
}
