import type { CommandShape, DiscoveredCommand, FlagSpec } from '@bendyline/gezel';
import type {
  CraftbookCompletionSpec,
  McpToolCompletionSpec,
  TerminalCompletionData,
} from './completion-data.js';

/**
 * Pure, monaco-free terminal-completion logic. `parseTerminalContext` turns the
 * line-before-cursor into a structured context; `computeTerminalCompletions`
 * returns neutral completion items. The monaco wrapper (in
 * `terminal-monaco-setup.ts`) maps these to `CompletionItem`s. Keeping this
 * layer monaco-free makes it directly unit-testable.
 */

export type TerminalCompletionKind =
  | 'command'
  | 'craftbook'
  | 'mcp-tool'
  | 'subcommand'
  | 'flag'
  | 'arg'
  | 'enum';

export interface TerminalCompletionItem {
  label: string;
  insertText: string;
  kind: TerminalCompletionKind;
  /** Short right-aligned tag, e.g. "script" | "craftbook" | "mcp" | "bin". */
  badge?: string;
  /** One-liner detail (the resolved run string, a param type, …). */
  detail?: string;
  /** Markdown documentation shown in the widget's detail pane. */
  documentation?: string;
  /** Group/order key (commands first, then scripts, then tools …). */
  sortText?: string;
}

export interface TerminalCompletionContext {
  /** Completed tokens before the one being typed (the command at [0], etc.). */
  tokens: string[];
  /** The token currently under the cursor (prefix only); '' at a fresh slot. */
  currentToken: string;
  /** True when the cursor sits at the start of a new (empty) token. */
  atTokenStart: boolean;
  /** When `currentToken` is `key=value`, the `key` (so we complete its value). */
  pendingKey?: string;
}

/** Best-effort tokenization of the command line up to the cursor. */
export function parseTerminalContext(lineBeforeCursor: string): TerminalCompletionContext {
  const trimmed = lineBeforeCursor.trim();
  const endsWithSpace = lineBeforeCursor === '' || /\s$/.test(lineBeforeCursor);
  const raw = trimmed.length ? trimmed.split(/\s+/) : [];
  let tokens: string[];
  let currentToken: string;
  if (endsWithSpace) {
    tokens = raw;
    currentToken = '';
  } else {
    tokens = raw.slice(0, -1);
    currentToken = raw[raw.length - 1] ?? '';
  }
  const kv = /^([A-Za-z][\w-]*)=(.*)$/.exec(currentToken);
  return { tokens, currentToken, atTokenStart: currentToken === '', pendingKey: kv?.[1] };
}

export function computeTerminalCompletions(
  ctx: TerminalCompletionContext,
  data: TerminalCompletionData,
): TerminalCompletionItem[] {
  const { tokens } = ctx;

  // First token: unified list of runnable things.
  if (tokens.length === 0) {
    return firstTokenItems(data);
  }

  const cmd = tokens[0]!;

  const cb = data.craftbooks.find((c) => c.command === cmd || c.id === cmd);
  if (cb) return craftbookCompletions(cb, tokens.slice(1), ctx.pendingKey);

  const tool = data.mcpTools.find((t) => t.name === cmd);
  if (tool) return mcpToolCompletions(tool, tokens.slice(1), ctx.pendingKey);

  // Shaped command — descend through nested subcommands by joined key
  // (the shapes map is keyed by fullName, e.g. "gh pr").
  const shape = resolveShape(data, tokens);
  if (shape) return shapedCompletions(shape, tokens, ctx.currentToken);

  // Unrecognized first token → raw shell, no completions.
  return [];
}

// ── First token ───────────────────────────────────────────────────────

function firstTokenItems(data: TerminalCompletionData): TerminalCompletionItem[] {
  const items: TerminalCompletionItem[] = [];
  const nativeCommands: TerminalCompletionItem[] = [
    {
      label: 'open',
      insertText: 'open',
      kind: 'command',
      badge: 'gezel',
      detail: 'Preview a workspace file in References',
      documentation: 'Usage: `open <workspace-file>`',
      sortText: '0open',
    },
  ];
  items.push(...nativeCommands);
  const nativeNames = new Set(nativeCommands.map((command) => command.label));
  const craftbookNames = new Set(data.craftbooks.map((c) => c.command));

  // Craftbooks rank first (they win over a same-named npm script, matching the
  // server resolver) — sortText group '0'.
  for (const cb of data.craftbooks) {
    if (nativeNames.has(cb.command)) continue;
    items.push({
      label: cb.command,
      insertText: cb.command,
      kind: 'craftbook',
      badge: 'craftbook',
      detail: cb.name,
      documentation: cb.description,
      sortText: `1${cb.command}`,
    });
  }
  // Indexed commands/scripts — group '1'.
  for (const c of data.index?.commands ?? []) {
    if (nativeNames.has(c.name) || craftbookNames.has(c.name)) continue;
    items.push({
      label: c.name,
      insertText: c.name,
      kind: 'command',
      badge: badgeForKind(c.kind),
      detail: c.run,
      documentation: commandDoc(c, data.index?.shapes?.[c.name]),
      sortText: `2${c.name}`,
    });
  }
  // MCP tools — group '2'.
  for (const t of data.mcpTools) {
    if (nativeNames.has(t.name)) continue;
    items.push({
      label: t.name,
      insertText: t.name,
      kind: 'mcp-tool',
      badge: 'mcp',
      documentation: t.description,
      sortText: `3${t.name}`,
    });
  }
  return items;
}

function badgeForKind(kind: DiscoveredCommand['kind']): string {
  switch (kind) {
    case 'npm-script':
    case 'workspace-script':
      return 'script';
    case 'vscode-launch':
      return 'launch';
    case 'bin':
      return 'bin';
  }
}

function commandDoc(c: DiscoveredCommand, shape?: CommandShape): string {
  const lines: string[] = [];
  const summary = shape?.summary ?? c.description;
  if (summary) lines.push(summary);
  lines.push('', `Runs: \`${c.run}\``, `Source: ${c.source}`);
  if (shape?.usage) lines.push('', `Usage: \`${shape.usage}\``);
  if (shape?.examples?.length) {
    lines.push('', 'Examples:', '```', ...shape.examples.slice(0, 5), '```');
  }
  return lines.join('\n');
}

// ── Shaped commands (oclif) ───────────────────────────────────────────

function resolveShape(data: TerminalCompletionData, tokens: string[]): CommandShape | undefined {
  const shapes = data.index?.shapes;
  if (!shapes) return undefined;
  // Longest matching joined-key prefix wins (e.g. "gh pr" over "gh").
  for (let n = Math.min(tokens.length, 3); n >= 1; n--) {
    const key = tokens.slice(0, n).join(' ');
    if (shapes[key]) return shapes[key];
  }
  return undefined;
}

function flagDetail(f: FlagSpec): string {
  const parts = [`(${f.type})`];
  if (f.required) parts.push('required');
  if (f.default) parts.push(`default ${f.default}`);
  return parts.join(' ');
}

function shapedCompletions(
  shape: CommandShape,
  tokens: string[],
  currentToken: string,
): TerminalCompletionItem[] {
  const flags = shape.flags ?? [];
  const after = tokens.slice(1);

  // Value for a preceding `--option` flag that constrains its values.
  const lastCompleted = tokens[tokens.length - 1];
  if (lastCompleted && !currentToken.startsWith('-')) {
    const m = /^--?([\w-]+)$/.exec(lastCompleted);
    const f = m ? flags.find((fl) => fl.name === m[1] || fl.char === m[1]) : undefined;
    if (f?.type === 'option' && f.options?.length) {
      return f.options.map((opt) => ({
        label: opt,
        insertText: opt,
        kind: 'enum' as const,
        detail: f.name,
        sortText: `0${opt}`,
      }));
    }
  }

  // Flags.
  if (currentToken.startsWith('-')) {
    return flags.map((f) => ({
      label: `--${f.name}`,
      insertText: `--${f.name}`,
      kind: 'flag' as const,
      badge: f.type,
      detail: flagDetail(f),
      documentation: f.description,
      sortText: `${f.required ? '0' : '1'}${f.name}`,
    }));
  }

  // Subcommands — only directly after the command token.
  if (after.length === 0 && (shape.subcommands?.length ?? 0) > 0) {
    return (shape.subcommands ?? []).map((s) => ({
      label: s.name,
      insertText: s.name,
      kind: 'subcommand' as const,
      detail: s.summary,
      documentation: s.summary,
      sortText: `0${s.name}`,
    }));
  }

  // Positional args with constrained values.
  const args = shape.args ?? [];
  const positionalsTyped = after.filter((t) => !t.startsWith('-')).length;
  const arg = args[positionalsTyped];
  if (arg?.options?.length) {
    return arg.options.map((opt) => ({
      label: opt,
      insertText: opt,
      kind: 'enum' as const,
      detail: arg.name,
      documentation: arg.description,
      sortText: `0${opt}`,
    }));
  }
  return [];
}

// ── Craftbook params ──────────────────────────────────────────────────

interface ParamDef {
  key: string;
  type: string;
  enum?: string[];
  required?: boolean;
  description?: string;
}

/** Read ordered scalar param defs from a craftbook `paramSchema` (structural). */
export function readParamDefs(schema: Record<string, unknown> | undefined): ParamDef[] {
  const s = schema as { properties?: Record<string, unknown>; required?: unknown } | undefined;
  const props = (s?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(s?.required) ? (s.required as unknown[]).map(String) : []);
  return Object.keys(props).map((key) => {
    const p = props[key] ?? {};
    return {
      key,
      type: typeof p.type === 'string' ? p.type : 'string',
      enum: Array.isArray(p.enum) ? p.enum.map(String) : undefined,
      required: required.has(key),
      description: typeof p.description === 'string' ? p.description : undefined,
    };
  });
}

function valueItemsFor(def: ParamDef): TerminalCompletionItem[] {
  if (def.enum?.length) {
    return def.enum.map((v) => ({
      label: v,
      insertText: v,
      kind: 'enum' as const,
      detail: def.key,
      sortText: `0${v}`,
    }));
  }
  if (def.type === 'boolean') {
    return ['true', 'false'].map((v) => ({
      label: v,
      insertText: v,
      kind: 'enum' as const,
      detail: def.key,
      sortText: `0${v}`,
    }));
  }
  return [];
}

function craftbookCompletions(
  cb: CraftbookCompletionSpec,
  after: string[],
  pendingKey: string | undefined,
): TerminalCompletionItem[] {
  const defs = readParamDefs(cb.paramSchema);
  const byKey = new Map(defs.map((d) => [d.key, d]));

  // Completing the value of `key=…`.
  if (pendingKey) {
    const d = byKey.get(pendingKey);
    return d ? valueItemsFor(d) : [];
  }

  // Find the next unfilled positional param (positional + key=value, like the
  // server's parseCraftbookArgs).
  const filled = new Set<string>();
  let positional = 0;
  for (const tok of after) {
    const kv = /^-{0,2}([A-Za-z][\w-]*)=/.exec(tok);
    if (kv) {
      filled.add(kv[1]!);
      continue;
    }
    while (positional < defs.length && filled.has(defs[positional]!.key)) positional++;
    if (positional < defs.length) {
      filled.add(defs[positional]!.key);
      positional++;
    }
  }
  while (positional < defs.length && filled.has(defs[positional]!.key)) positional++;
  const next = defs[positional];
  if (!next) return [];

  const items = valueItemsFor(next);
  items.push({
    label: `${next.key}=`,
    insertText: `${next.key}=`,
    kind: 'arg',
    badge: next.required ? 'required' : 'param',
    detail: next.type,
    documentation: next.description,
    sortText: `1${next.key}`,
  });
  return items;
}

// ── MCP tool args ─────────────────────────────────────────────────────

function mcpToolCompletions(
  tool: McpToolCompletionSpec,
  after: string[],
  pendingKey: string | undefined,
): TerminalCompletionItem[] {
  const props = readParamDefs(tool.parameters);
  const byKey = new Map(props.map((p) => [p.key, p]));

  if (pendingKey) {
    const p = byKey.get(pendingKey);
    return p ? valueItemsFor(p) : [];
  }

  const filled = new Set(
    after.map((t) => /^([A-Za-z][\w-]*)=/.exec(t)?.[1]).filter((k): k is string => Boolean(k)),
  );
  const items: TerminalCompletionItem[] = [];
  for (const p of props) {
    if (filled.has(p.key)) continue;
    items.push({
      label: `${p.key}=`,
      insertText: `${p.key}=`,
      kind: 'arg',
      badge: p.required ? 'required' : 'arg',
      detail: p.type,
      documentation: p.description,
      sortText: `${p.required ? '0' : '1'}${p.key}`,
    });
  }
  // JSON escape hatch for complex/nested args.
  if (after.length === 0) {
    items.push({
      label: '{ } — raw JSON args',
      insertText: '{}',
      kind: 'arg',
      badge: 'json',
      detail: 'pass arguments as a JSON object',
      sortText: '2}',
    });
  }
  return items;
}
