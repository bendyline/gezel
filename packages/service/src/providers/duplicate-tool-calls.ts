/**
 * Collapse tool calls a model emitted more than once in ONE generation.
 *
 * Local models stutter: a single assistant message repeats the identical
 * `<tool_call>` block several times. Every salvage format faithfully promotes
 * each copy, so the runtime dispatches N identical calls — and
 * `ToolRepeatTracker`, which exists to stop a model looping ACROSS turns
 * without progress, sees N identical calls and aborts the turn.
 *
 * Wild-caught on the meester-to-PPTX end-to-end run, three trials running:
 *
 *   salvaged 8 Hermes-style tool call(s): read_task_notes, read_task_notes,
 *   read_task_notes, read_task_notes, read_task_notes, read_task_notes,
 *   read_task_notes, read_task_notes
 *
 * one generation, one set of arguments, eight copies — then
 * `abort-repeat-loop tool=read_task_notes sameArgsCalls=5`. The model had not
 * failed to make progress; it had said the same thing eight times in a row and
 * been punished for the echo. The same stutter on `invoke_craftbook` produced
 * four competing craftbook tasks from one Meester turn.
 *
 * Asking the same question twice in one breath is asking it once, so identical
 * reads and whole-file writes collapse. Accumulative tools are the exception:
 * two appends of the same text are genuinely two appends, and a model that
 * wanted one paragraph twice must still get it.
 */

export interface DuplicableToolCall {
  function: { name: string; arguments: string };
}

/**
 * Tools where a second identical call means a second effect. Everything else
 * is a read or a whole-file overwrite, where the repeat is indistinguishable
 * from the original.
 */
const ACCUMULATIVE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'append_to_file',
  'write_task_note',
  'add_task_step',
  'save_memory',
  'message_gezel',
  'insert_at_marker',
]);

/** Order-insensitive form, so `{a:1,b:2}` and `{b:2,a:1}` are one call. */
function canonicalArguments(raw: string): string {
  try {
    return JSON.stringify(sortValue(JSON.parse(raw)));
  } catch {
    // Not JSON (a half-salvaged fragment). Compare the literal text; a
    // stutter reproduces it byte for byte anyway.
    return raw.trim();
  }
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortValue(entry)]),
    );
  }
  return value;
}

export interface CollapsedToolCalls<T> {
  calls: readonly T[];
  /** Tool names that lost at least one copy, with how many were dropped. */
  dropped: Array<{ name: string; count: number }>;
}

export function collapseDuplicateToolCalls<T extends DuplicableToolCall>(
  calls: readonly T[],
): CollapsedToolCalls<T> {
  if (calls.length < 2) return { calls, dropped: [] };
  const seen = new Set<string>();
  const dropCounts = new Map<string, number>();
  const kept: T[] = [];
  for (const call of calls) {
    const name = call.function.name;
    if (ACCUMULATIVE_TOOL_NAMES.has(name)) {
      kept.push(call);
      continue;
    }
    const key = `${name}\n${canonicalArguments(call.function.arguments)}`;
    if (seen.has(key)) {
      dropCounts.set(name, (dropCounts.get(name) ?? 0) + 1);
      continue;
    }
    seen.add(key);
    kept.push(call);
  }
  if (dropCounts.size === 0) return { calls, dropped: [] };
  return {
    calls: kept,
    dropped: [...dropCounts].map(([name, count]) => ({ name, count })),
  };
}
