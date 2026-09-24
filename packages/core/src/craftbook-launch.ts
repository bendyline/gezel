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
