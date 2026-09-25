/**
 * What every surface that turns a request into a craftbook task must agree
 * on: how the person's words become the task's description, and which
 * parameter — if any — carries them as the book's main content. The chat
 * composer's launch route and the MCP `invoke_craftbook` tool both call
 * {@link composeCraftbookLaunch}; keeping one owner is what stops the two
 * from drifting the way the old `inferCraftbookJobParams` /
 * `normalizedCraftbookTaskDescription` pair and the New Task dialog's
 * `composeCraftbookDescription` already had.
 */

import { withoutInputParams } from './craftbook-inputs.js';
import type { Craftbook } from './schemas/craftbook.js';

/** Matches `CreateTaskRequestSchema.description`'s minimum. */
export const MIN_TASK_DESCRIPTION_LENGTH = 40;

const SOURCE_FORM_KEYS = ['sourcePath', 'topic', 'content'] as const;

/**
 * The paramSchema property annotation that marks a book's main content
 * parameter — the one a free-text request is written into when no source
 * form was supplied:
 *
 *   "brief": { "type": "string", "fromMessage": true }
 *
 * A sibling of the `input` annotation, read in exactly one place
 * ({@link mainContentParamKey}). Books that declare none fall back to a
 * property named `topic`.
 */
export const PARAM_FROM_MESSAGE_KEY = 'fromMessage';

function paramProperties(paramSchema: unknown): Record<string, Record<string, unknown>> {
  if (!paramSchema || typeof paramSchema !== 'object' || Array.isArray(paramSchema)) return {};
  const properties = (paramSchema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return {};
  return Object.fromEntries(
    Object.entries(properties as Record<string, unknown>).filter(
      (entry): entry is [string, Record<string, unknown>] =>
        !!entry[1] && typeof entry[1] === 'object' && !Array.isArray(entry[1]),
    ),
  );
}

/**
 * The parameter a book reads a free-text request into. A property carrying
 * the `fromMessage` annotation wins (the first one, in declaration order);
 * otherwise a property named `topic`, by convention. `content` is
 * deliberately not a fallback — books treat it as inline source material,
 * and a request sentence is not the material. A book that declares neither
 * has no main content parameter and the request reaches it through the task
 * description alone.
 */
export function mainContentParamKey(paramSchema: unknown): string | null {
  const properties = paramProperties(paramSchema);
  for (const [key, property] of Object.entries(properties)) {
    if (property[PARAM_FROM_MESSAGE_KEY] === true) return key;
  }
  return properties.topic ? 'topic' : null;
}

/**
 * Fill the main content parameter from the request when the caller supplied
 * no source form at all. An explicit `sourcePath`, `topic`, or `content` is
 * always left alone: a person who pointed the book at a file did not also
 * mean to paste their sentence into `topic`.
 */
export function fillMainContentParam(args: {
  paramSchema: unknown;
  params?: Record<string, string>;
  message?: string;
}): Record<string, string> {
  const params = { ...(args.params ?? {}) };
  const message = args.message?.trim();
  if (!message) return params;
  const key = mainContentParamKey(args.paramSchema);
  if (!key) return params;
  const suppliedSource = SOURCE_FORM_KEYS.some(
    (candidate) => typeof params[candidate] === 'string' && params[candidate]!.trim().length > 0,
  );
  return suppliedSource ? params : { ...params, [key]: message };
}

/**
 * The task description for a launch: the person's own words, verbatim,
 * padded with one imperative sentence only when they are too short to meet
 * the create request's minimum. No standing provenance line — the task
 * already records where it came from (`origin`, `launchSessionId`,
 * `createdBy`), and this text is fed to every step's prompt.
 */
export function composeCraftbookTaskDescription(args: {
  message?: string;
  craftbookName: string;
}): string {
  const message = args.message?.trim() ?? '';
  if (message.length >= MIN_TASK_DESCRIPTION_LENGTH) return message;
  const padding = message
    ? `Run the "${args.craftbookName}" craftbook end to end for this request.`
    : `Run the "${args.craftbookName}" craftbook against this project.`;
  return message ? `${message}\n\n${padding}` : padding;
}

/**
 * The one entry both launchers use. The fill runs on the raw message before
 * padding so the padding sentence never leaks into `topic`.
 */
export function composeCraftbookLaunch(args: {
  message?: string;
  craftbookName: string;
  paramSchema: unknown;
  params?: Record<string, string>;
}): { description: string; params: Record<string, string> } {
  return {
    description: composeCraftbookTaskDescription({
      ...(args.message !== undefined ? { message: args.message } : {}),
      craftbookName: args.craftbookName,
    }),
    params: fillMainContentParam({
      paramSchema: args.paramSchema,
      ...(args.params ? { params: args.params } : {}),
      ...(args.message !== undefined ? { message: args.message } : {}),
    }),
  };
}

/**
 * Coerce editor-shaped parameter values to the wire's `Record<string,string>`.
 * Empty strings, `null`, and `undefined` are dropped rather than sent as
 * `""`, because a book's `required` check treats an absent key and an empty
 * one the same and a `minLength` branch would reject the empty one anyway.
 * Objects and arrays are not string params and are skipped.
 */
export function stringifyCraftbookParamValues(
  value: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined || raw === null || raw === '') continue;
    if (typeof raw === 'boolean') out[key] = raw ? 'true' : 'false';
    else if (typeof raw === 'number') out[key] = String(raw);
    else if (typeof raw === 'string') out[key] = raw;
  }
  return out;
}

/**
 * The paramSchema property annotation that says whether a launch form asks
 * a person for this parameter:
 *
 *   "issueRefs": { "type": "string", "askUser": false }
 *
 * `false` marks a parameter another surface fills (the night-fix planner's
 * issue refs, the Review panel's review id) or that the task description
 * already carries. Omitted, a parameter is asked unless its default is a
 * runtime template (`{{task.dir}}`, `powerpoint/task-{{task.num}}`): the
 * daemon resolves those at create, so the form could only show an empty box
 * labelled with a folder path the person has no reason to know. `true`
 * forces the field back into the form. Launch forms read it through
 * {@link paramAsksUser}; the terminal still accepts every parameter.
 */
export const PARAM_ASK_USER_KEY = 'askUser';

const RUNTIME_TEMPLATE_PATTERN = /\{\{\s*[a-zA-Z0-9_.-]+\s*\}\}/;

/** Whether a declared default is a template the daemon resolves at task create. */
export function isRuntimeTemplateDefault(value: unknown): boolean {
  return typeof value === 'string' && RUNTIME_TEMPLATE_PATTERN.test(value);
}

/** Whether a launch form should show this paramSchema property to a person. */
export function paramAsksUser(property: unknown): boolean {
  if (!property || typeof property !== 'object' || Array.isArray(property)) return true;
  const record = property as Record<string, unknown>;
  const explicit = record[PARAM_ASK_USER_KEY];
  if (typeof explicit === 'boolean') return explicit;
  return !isRuntimeTemplateDefault(record.default);
}

/**
 * The paramSchema with every property a person is not asked for removed,
 * and `required` filtered to match, so a form never demands a field it does
 * not show. Values for the removed keys are left to the caller: a form that
 * seeded one keeps sending it.
 */
export function withoutUnaskedParams<T extends Record<string, unknown> | undefined>(
  paramSchema: T,
): T {
  if (!paramSchema) return paramSchema;
  const properties = paramProperties(paramSchema);
  const hidden = new Set(
    Object.entries(properties)
      .filter(([, property]) => !paramAsksUser(property))
      .map(([key]) => key),
  );
  if (hidden.size === 0) return paramSchema;
  const next: Record<string, unknown> = {
    ...paramSchema,
    properties: Object.fromEntries(
      Object.entries(
        (paramSchema as { properties?: Record<string, unknown> }).properties ?? {},
      ).filter(([key]) => !hidden.has(key)),
    ),
  };
  const required = (paramSchema as { required?: unknown }).required;
  if (Array.isArray(required)) {
    next.required = required.filter(
      (key): key is string => typeof key === 'string' && !hidden.has(key),
    );
  }
  return next as T;
}

/**
 * A top-level `anyOf` / `oneOf` in a paramSchema is a validation rule —
 * powerpoint-deck's "give a source file, a topic, or source material" —
 * never a layout. Squisq's form picks a tab control for any schema carrying
 * one, before it looks at `properties`, so the rule rendered as unlabeled
 * "Option 1/2/3" tabs over a text box printing the whole value object, and
 * no real field was shown at all. Forms drop the rule and check it through
 * {@link unmetParamAlternatives} instead.
 */
const PARAM_ALTERNATIVE_KEYS = ['anyOf', 'oneOf'] as const;

function withoutKeys<T extends Record<string, unknown> | undefined>(
  paramSchema: T,
  omitKeys: readonly string[],
): T {
  if (!paramSchema || omitKeys.length === 0) return paramSchema;
  const omit = new Set(omitKeys);
  const properties = (paramSchema as { properties?: unknown }).properties;
  const next: Record<string, unknown> = { ...paramSchema };
  if (properties && typeof properties === 'object' && !Array.isArray(properties)) {
    next.properties = Object.fromEntries(
      Object.entries(properties as Record<string, unknown>).filter(([key]) => !omit.has(key)),
    );
  }
  const required = (paramSchema as { required?: unknown }).required;
  if (Array.isArray(required)) {
    next.required = required.filter((key) => typeof key === 'string' && !omit.has(key));
  }
  return next as T;
}

/**
 * What any generic param form renders: the properties a person is asked
 * for, minus `omitKeys` (a surface that fills a param itself, like the
 * composer's brief), without the top-level alternatives rule.
 */
export function paramFormSchema<T extends Record<string, unknown> | undefined>(
  paramSchema: T,
  omitKeys: readonly string[] = [],
): T {
  const asked = withoutKeys(withoutUnaskedParams(paramSchema), omitKeys);
  if (!asked || !PARAM_ALTERNATIVE_KEYS.some((key) => key in asked)) return asked;
  const next: Record<string, unknown> = { ...asked };
  for (const key of PARAM_ALTERNATIVE_KEYS) delete next[key];
  return next as T;
}

/**
 * What a launch dialog's generic form renders: {@link paramFormSchema}
 * without the input params, which get a source picker of their own. The New
 * Task dialog and the composer's attached task both read the form through
 * here, so the fields the dialog shows and the fields Send checks cannot
 * disagree.
 */
export function launchFormParamSchema(
  paramSchema: Craftbook['paramSchema'],
  omitKeys: readonly string[] = [],
): Craftbook['paramSchema'] {
  return paramFormSchema(withoutInputParams(paramSchema), omitKeys);
}

/**
 * The top-level "fill at least one of these" rule, as the key set each
 * branch requires. Empty when the book declares none, or when any branch
 * names no `required` keys — a branch that asks for nothing is satisfied by
 * anything, so there is no rule to enforce.
 */
export function paramAlternatives(paramSchema: unknown): string[][] {
  if (!paramSchema || typeof paramSchema !== 'object' || Array.isArray(paramSchema)) return [];
  const record = paramSchema as Record<string, unknown>;
  const branches = PARAM_ALTERNATIVE_KEYS.map((key) => record[key]).find(Array.isArray);
  if (!branches || branches.length === 0) return [];
  const out: string[][] = [];
  for (const branch of branches) {
    const required =
      branch && typeof branch === 'object' ? (branch as { required?: unknown }).required : null;
    const keys = Array.isArray(required)
      ? required.filter((key): key is string => typeof key === 'string')
      : [];
    if (keys.length === 0) return [];
    out.push(keys);
  }
  return out;
}

/**
 * The alternatives a launch has not met, or null when it meets one (or the
 * book declares none). A key counts as given when its value is non-blank,
 * when the caller fills it (`filledKeys`: the composer's message, a picked
 * input source), or when a person is never asked for it — a rule the form
 * cannot satisfy must not hold the launch. `oneOf` is checked as "at least
 * one": a second answer is extra context, not a mistake worth refusing.
 */
export function unmetParamAlternatives(
  paramSchema: unknown,
  values: Record<string, unknown>,
  filledKeys: readonly string[] = [],
): string[][] | null {
  const alternatives = paramAlternatives(paramSchema);
  if (alternatives.length === 0) return null;
  const properties = paramProperties(paramSchema);
  const filled = new Set(filledKeys);
  const given = (key: string): boolean => {
    if (filled.has(key)) return true;
    if (properties[key] && !paramAsksUser(properties[key])) return true;
    const value = values[key];
    if (value === undefined || value === null) return false;
    return typeof value === 'string' ? value.trim().length > 0 : true;
  };
  return alternatives.some((keys) => keys.every(given)) ? null : alternatives;
}
