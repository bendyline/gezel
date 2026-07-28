/**
 * Build a short human-readable summary of a tool call's arguments. Drops
 * bulky fields (markdown bodies, file contents, multiline blobs) and
 * truncates what remains. Safe to surface in the UI and in persisted
 * tool-call history — any caller that handles secrets lives in the
 * toolset-config path, not in MCP tool arguments.
 */
export function summarizeToolArgs(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const BULKY = new Set([
    'content',
    'body',
    'source',
    'markdown',
    'text',
    'about',
    'missionObjectives',
  ]);
  const MAX_VALUE_CHARS = 60;
  const MAX_ENTRIES = 3;

  const pieces: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (pieces.length >= MAX_ENTRIES) break;
    if (BULKY.has(key)) continue;
    const rendered = renderValue(value, MAX_VALUE_CHARS);
    if (rendered === null) continue;
    pieces.push(`${key}: ${rendered}`);
  }
  return pieces.length > 0 ? pieces.join(', ') : undefined;
}

/**
 * Build a NON-nerdy one-line summary of a tool call — natural phrasing
 * ("→ Freja: update the game loop · file: workspace/index.html"), not
 * `key: "value"` JSON. Returns undefined for tools we don't have a
 * template for, so the caller falls back to {@link summarizeToolArgs}.
 * The full detail lives in {@link renderFullToolArgs} (expand + copy in
 * the UI), which frees the summary to read like a sentence.
 */
export function humanizeToolCall(
  name: string,
  args: Record<string, unknown> | undefined,
): string | undefined {
  const a = args ?? {};
  const str = (k: string): string | undefined =>
    typeof a[k] === 'string' && (a[k] as string).length > 0 ? (a[k] as string) : undefined;
  const oneLine = (v: string | undefined, n = 60): string | undefined => {
    if (!v) return undefined;
    const flat = v.replace(/\s+/g, ' ').trim();
    return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
  };
  const join = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ');

  switch (name) {
    case 'message_gezel': {
      const to = str('gezel') ?? str('toGezelIdOrName') ?? str('to');
      const head = to ? `→ ${to}` : 'Sent a message';
      const body = join(oneLine(str('message') ?? str('text')), fileHint(a.expectedDeliverable));
      return body ? `${head}: ${body}` : head;
    }
    case 'ask_specialist':
      return `Asked the ${str('role') ?? 'specialist'}${str('question') ? `: ${oneLine(str('question'), 50)}` : ''}`;
    case 'ensure_gezel':
      return `Lined up a ${str('jobTitle') ?? str('role') ?? 'gezel'}`;
    case 'create_task':
      return `Created task “${oneLine(str('title'), 50) ?? '…'}”`;
    case 'assign_task':
      return join(
        `Assigned ${str('ref') ?? 'task'}`,
        str('gezel') ? `→ ${str('gezel')}` : undefined,
      );
    case 'set_task_status':
      return `Marked ${str('ref') ?? 'task'} ${str('status') ?? ''}`.trim();
    case 'advance_task_step':
      return `Advanced ${str('ref') ?? 'the task'}`;
    case 'write_task_note':
      return `Left a note on ${str('ref') ?? 'the task'}`;
    case 'read_task_notes':
      return `Read notes on ${str('ref') ?? 'the task'}`;
    case 'get_task':
      return `Looked up ${str('ref') ?? 'a task'}`;
    case 'list_tasks':
      return 'Listed the tasks';
    case 'list_gezels':
      return 'Listed the team';
    case 'write_file':
      return `Wrote ${str('path') ?? 'a file'}`;
    case 'append_to_file':
      return `Appended to ${str('path') ?? 'a file'}`;
    case 'replace_in_file':
      return `Edited ${str('path') ?? 'a file'}`;
    case 'read_file':
      return `Read ${str('path') ?? 'a file'}`;
    case 'list_dir':
      return `Listed ${str('path') ?? 'the folder'}`;
    case 'write_artifact':
      return `Saved a note${str('path') ? ` (${str('path')})` : ''}`;
    case 'read_artifact':
      return `Read a note${str('path') ? ` (${str('path')})` : ''}`;
    case 'list_artifacts':
      return 'Listed the notes';
    default:
      return undefined;
  }
}

/** Pull a `filePath` out of an `expectedDeliverable` arg, which may be an object OR a JSON string. */
function fileHint(v: unknown): string | undefined {
  let obj: unknown = v;
  if (typeof v === 'string') {
    try {
      obj = JSON.parse(v);
    } catch {
      return undefined;
    }
  }
  if (
    obj &&
    typeof obj === 'object' &&
    typeof (obj as { filePath?: unknown }).filePath === 'string'
  ) {
    return `file: ${(obj as { filePath: string }).filePath}`;
  }
  return undefined;
}

/** ~100 KB, matching the inline-diff cap — bounds session-record growth. */
const ARGS_FULL_CAP = 100_000;

/**
 * Render a tool call's FULL arguments as readable, copyable text — every
 * field, bulky values shown in full (unlike {@link summarizeToolArgs}).
 * Field-per-block, not raw JSON: short scalars inline, long/multiline
 * values on their own lines so a handoff message or file body reads
 * cleanly. Capped at {@link ARGS_FULL_CAP}.
 */
export function renderFullToolArgs(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const entries = Object.entries(args);
  if (entries.length === 0) return undefined;
  const blocks = entries.map(([key, value]) => {
    let rendered: string;
    if (value === null || value === undefined) rendered = String(value);
    else if (typeof value === 'string') rendered = value;
    else if (typeof value === 'number' || typeof value === 'boolean') rendered = String(value);
    else rendered = JSON.stringify(value, null, 2);
    return rendered.includes('\n') || rendered.length > 80
      ? `${key}:\n${rendered}`
      : `${key}: ${rendered}`;
  });
  const out = blocks.join('\n\n');
  return out.length > ARGS_FULL_CAP ? `${out.slice(0, ARGS_FULL_CAP)}\n\n… (truncated)` : out;
}

function renderValue(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    if (v.length === 0) return null;
    return jsonForDisplay(truncate(v, max));
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    if (v.length <= 3 && v.every((x) => typeof x === 'string' || typeof x === 'number')) {
      return jsonForDisplay(v.map((x) => (typeof x === 'string' ? truncate(x, 20) : x)));
    }
    return `[${v.length} items]`;
  }
  if (typeof v === 'object') return '{…}';
  return null;
}

/**
 * JSON.stringify quotes the value (so paths/strings read clearly) but
 * escapes every backslash, turning Windows paths like `c:\gh\foo` into
 * `c:\\gh\\foo` in the UI. Collapse each escaped backslash back to one for
 * display — within JSON output a run of 2k backslashes always encodes k
 * real ones, so halving them is lossless and leaves other escapes (\n, \")
 * untouched.
 */
function jsonForDisplay(value: unknown): string {
  return JSON.stringify(value).replace(/\\\\/g, '\\');
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}
