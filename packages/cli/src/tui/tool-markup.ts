/**
 * Display-time cleanup of tool-call markup that local models leak into
 * their visible reply text. The service's salvage layer promotes these
 * blocks into real tool calls, but the raw markup can still reach the
 * feed — mid-stream (deltas arrive before salvage runs) and in persisted
 * turns from dialects the strip pass missed. Rather than show the user
 * `<tool_call><function=read_file>…`, rewrite each recognizable block
 * into the same compact `🔧 name (key: value)` line the tool rows use.
 *
 * Dialects mirror the salvage layer's inventory
 * (packages/service/src/providers/local-tool-call-salvage.ts):
 *   - qwen-xml:   `<tool_call>{"name":"x","arguments":{…}}</tool_call>`
 *   - hermes:     `<function=x><parameter=k>v</parameter></function>`,
 *                 bare or wrapped in a qwen envelope (the common leak)
 *   - GLM:        `<tool_call>x<arg_key>k</arg_key><arg_value>v</arg_value></tool_call>`
 *   - shell-style `<tool_call>x k="v"` one-liners (no closing tag)
 *   - gemma:      `<|tool_call>call:x{…}<tool_call|>`
 *
 * Unrecognized bodies are left untouched — better raw markup than a
 * rewrite that hides what the model actually said.
 */

const BULKY_KEYS = new Set([
  'content',
  'body',
  'source',
  'markdown',
  'text',
  'about',
  'missionObjectives',
]);
const MAX_VALUE_CHARS = 60;
const MAX_PARAMS = 3;

type Params = Array<[string, string]>;

function renderCall(name: string, params: Params): string {
  const pieces: string[] = [];
  for (const [key, value] of params) {
    if (pieces.length >= MAX_PARAMS) break;
    if (BULKY_KEYS.has(key)) continue;
    const flat = value.replace(/\s+/g, ' ').trim();
    if (!flat) continue;
    pieces.push(
      `${key}: ${flat.length > MAX_VALUE_CHARS ? `${flat.slice(0, MAX_VALUE_CHARS - 1)}…` : flat}`,
    );
  }
  return pieces.length > 0 ? `🔧 ${name} (${pieces.join(', ')})` : `🔧 ${name}`;
}

const NAME = '[A-Za-z_][A-Za-z0-9_.-]*';

const ENVELOPE_RE = /<tool_call>\s*([\s\S]*?)<\/tool_call\s*>/g;
const HERMES_RE = new RegExp(`<function=(${NAME})>\\s*([\\s\\S]*?)<\\/function\\s*>`, 'g');
const HERMES_PARAM_RE = new RegExp(
  `<parameter=(${NAME})>\\s*([\\s\\S]*?)\\s*<\\/parameter\\s*>`,
  'g',
);
const GLM_PAIR_RE =
  /<arg_key>\s*([\s\S]*?)\s*<\/arg_key>\s*<arg_value>\s*([\s\S]*?)\s*<\/arg_value>/g;
const GEMMA_ENVELOPE_RE = new RegExp(
  `<\\|tool_call>\\s*call:(${NAME})[\\s\\S]*?<tool_call\\|>`,
  'gi',
);
const SHELL_LINE_RE = new RegExp(
  `<tool_call>[ \\t]*(${NAME})((?:[ \\t]+${NAME}[ \\t]*=[ \\t]*(?:"[^"]*"|'[^']*'))*)[ \\t]*(?=$|\\n)`,
  'g',
);

function parseHermesParams(body: string): Params {
  const params: Params = [];
  for (const m of body.matchAll(HERMES_PARAM_RE)) {
    params.push([m[1] ?? '', m[2] ?? '']);
  }
  return params;
}

function renderJsonValue(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Parse one closed `<tool_call>…</tool_call>` body; null when unrecognized. */
function parseEnvelopeBody(body: string): string | null {
  const inner = body.trim();

  const hermes = new RegExp(`^<function=(${NAME})>\\s*([\\s\\S]*)$`).exec(inner);
  if (hermes) return renderCall(hermes[1] ?? '', parseHermesParams(hermes[2] ?? ''));

  if (inner.startsWith('{')) {
    try {
      const parsed = JSON.parse(inner) as Record<string, unknown>;
      const name = parsed.name ?? parsed.tool;
      if (typeof name !== 'string' || name.length === 0) return null;
      const args = parsed.arguments ?? parsed.args ?? parsed.parameters;
      const params: Params =
        args && typeof args === 'object' && !Array.isArray(args)
          ? Object.entries(args as Record<string, unknown>).map(([k, v]) => [k, renderJsonValue(v)])
          : [];
      return renderCall(name, params);
    } catch {
      return null;
    }
  }

  const glm = new RegExp(`^(${NAME})\\s*([\\s\\S]*)$`).exec(inner);
  if (glm) {
    const rest = glm[2] ?? '';
    const params: Params = [];
    for (const m of rest.matchAll(GLM_PAIR_RE)) params.push([m[1] ?? '', m[2] ?? '']);
    const leftover = rest.replace(GLM_PAIR_RE, '').trim();
    if (leftover.length === 0) return renderCall(glm[1] ?? '', params);
  }

  return null;
}

function parseShellArgs(argText: string): Params {
  const params: Params = [];
  const re = new RegExp(`(${NAME})[ \\t]*=[ \\t]*("([^"]*)"|'([^']*)')`, 'g');
  for (const m of argText.matchAll(re)) {
    params.push([m[1] ?? '', m[3] ?? m[4] ?? '']);
  }
  return params;
}

/**
 * Rewrite the trailing, still-open markup a streaming turn leaves at the
 * end of the row — `<tool_call>\n<function=read_file>\n<parameter=path>\ndocs/secr` —
 * into a live "🔧 read_file…" marker. Re-runs on every delta, so the
 * marker resolves into the full rendered call once the block closes.
 */
function humanizePartialTail(text: string): string {
  const idx = Math.max(text.lastIndexOf('<tool_call>'), text.lastIndexOf('<|tool_call>'));
  if (idx === -1) return text;
  const tail = text.slice(idx);
  if (/<\/tool_call\s*>|<tool_call\|>/.test(tail)) return text;
  const name =
    new RegExp(`^<tool_call>\\s*<function=(${NAME})`).exec(tail)?.[1] ??
    new RegExp(`^<tool_call>\\s*\\{\\s*"(?:name|tool)"\\s*:\\s*"(${NAME})"`).exec(tail)?.[1] ??
    new RegExp(`^<\\|tool_call>\\s*call:(${NAME})`).exec(tail)?.[1] ??
    new RegExp(`^<tool_call>\\s*(${NAME})\\s*$|^<tool_call>\\s*(${NAME})\\s*<arg_key>`)
      .exec(tail)
      ?.slice(1)
      .find(Boolean);
  return `${text.slice(0, idx)}${name ? `🔧 ${name}…` : '🔧 calling a tool…'}`;
}

/** True when the text can't possibly contain tool markup — the cheap early-out. */
function hasMarkers(text: string): boolean {
  return (
    text.includes('<tool_call>') || text.includes('<function=') || text.includes('<|tool_call>')
  );
}

/**
 * Rewrite every recognizable tool-call markup block in an assistant reply
 * into a compact human-readable line. Pure; safe to call on every render.
 */
export function humanizeToolMarkup(text: string): string {
  if (!hasMarkers(text)) return text;

  let out = text.replace(ENVELOPE_RE, (raw, body: string) => parseEnvelopeBody(body) ?? raw);
  out = out.replace(HERMES_RE, (_raw, name: string, body: string) =>
    renderCall(name, parseHermesParams(body)),
  );
  out = out.replace(GEMMA_ENVELOPE_RE, (_raw, name: string) => `🔧 ${name}`);
  out = out.replace(SHELL_LINE_RE, (_raw, name: string, argText: string) =>
    renderCall(name, parseShellArgs(argText)),
  );
  return humanizePartialTail(out);
}
