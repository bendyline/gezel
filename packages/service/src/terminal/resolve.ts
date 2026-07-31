import type { DiscoveredCommand, WorkspaceCommandIndex } from '@bendyline/gezel';
import { shellSplit } from './shell-split.js';

/**
 * One of four outcomes from `resolveTerminalInput`. The terminal manager
 * branches on `kind`:
 *
 *  - `intercept` — user typed `cd` / `pwd` / `clear`; the manager handles
 *    this without spawning anything (folder switch, echo current
 *    workingDir, or signal clear).
 *  - `argv` — argv ready to hand to `runWorkspaceCommand`. `resolvedFrom`
 *    is set when the index expanded the typed name (e.g. `build` →
 *    `pnpm run build`).
 *  - `empty` — input was whitespace-only.
 *  - `parseError` — quoted string mismatch or other tokenizer failure.
 */
export type ResolvedTerminalInput =
  | {
      kind: 'intercept';
      intercept: 'pwd' | 'clear' | 'open';
      arg?: string;
    }
  | {
      kind: 'argv';
      bin: string;
      args: string[];
      /** The fully-formed shell-paste form, for display + history audit. */
      run: string;
      /** When set, the index expanded the first token; this is the original input. */
      resolvedFrom?: string;
      /** When set, which DiscoveredCommand.kind matched. */
      matchedKind?: DiscoveredCommand['kind'];
    }
  | {
      /**
       * The first token matched a craftbook command (or its id). The
       * terminal manager dispatches this to the craftbook invoker
       * (create task + assign + start) instead of spawning a shell. The
       * trailing tokens were parsed into `params` against the
       * craftbook's `paramSchema`.
       */
      kind: 'craftbook';
      id: string;
      command: string;
      params: Record<string, string>;
      /** Shell-paste form for the persisted command bubble + history. */
      run: string;
    }
  | {
      /**
       * The first token matched a project MCP tool name. The terminal manager
       * dispatches this to the MCP tool invoker (runs the tool through the
       * project-scoped bridge). Trailing tokens were parsed into `args` —
       * `key=value` (scalar-coerced) or a single trailing `{json}` object.
       */
      kind: 'mcpTool';
      name: string;
      args: Record<string, unknown>;
      run: string;
    }
  | { kind: 'empty' }
  | { kind: 'parseError'; message: string };

/**
 * A craftbook the terminal recognizes as a launchable command. `command`
 * is the token users type (defaults to `id`); `paramSchema` is the
 * craftbook's squisq/JSON-Schema object whose top-level `properties`
 * (in declaration order) are the params positional tokens map onto.
 */
export interface CraftbookCommandSpec {
  id: string;
  command: string;
  paramSchema?: Record<string, unknown>;
}

// `cd` is intentionally NOT in this set anymore — with persistent
// shells, the shell handles it natively (and emits a workingDirChanged
// event when its cwd drifts). `pwd` and `clear` are lightweight UI-facing
// helpers; `open` validates a workspace path and asks the References pane
// to preview it without launching an OS application.
const INTERCEPTS = new Set(['pwd', 'clear', 'open']);

/**
 * Resolve raw user input into either an intercept, executable argv, or
 * an error. Index-match first, raw shell pass-through as fallback.
 *
 *  - First token gets looked up in `index.commands` by `.name`. If
 *    matched, the command's `.run` field is shell-parsed and any extra
 *    user tokens are appended.
 *  - Otherwise the input is parsed as a normal shell-ish command line.
 */
export function resolveTerminalInput(
  input: string,
  index: WorkspaceCommandIndex | null,
  craftbooks?: readonly CraftbookCommandSpec[] | null,
  mcpTools?: readonly { name: string }[] | null,
): ResolvedTerminalInput {
  const trimmed = input.trim();
  if (trimmed === '') return { kind: 'empty' };

  let tokens: string[];
  try {
    tokens = shellSplit(trimmed);
  } catch (err) {
    return { kind: 'parseError', message: err instanceof Error ? err.message : String(err) };
  }
  if (tokens.length === 0) return { kind: 'empty' };

  const first = tokens[0]!;

  if (INTERCEPTS.has(first)) {
    const intercept = first as 'pwd' | 'clear' | 'open';
    const rest = tokens.slice(1).join(' ');
    if (intercept === 'open' && !rest) {
      return { kind: 'parseError', message: 'open requires a workspace file path' };
    }
    return rest ? { kind: 'intercept', intercept, arg: rest } : { kind: 'intercept', intercept };
  }

  // Craftbook commands are recognized BEFORE the workspace-index lookup,
  // so a craftbook wins over a same-named npm script (`npm run <x>` is
  // the escape hatch). Match the typed token against the alias OR the id.
  const cb = craftbooks?.find((c) => c.command === first || c.id === first);
  if (cb) {
    const parsed = parseCraftbookArgs(cb, tokens.slice(1));
    if ('error' in parsed) return { kind: 'parseError', message: parsed.error };
    return {
      kind: 'craftbook',
      id: cb.id,
      command: first,
      params: parsed.params,
      run: renderArgv(tokens),
    };
  }

  // Index lookup: only when a workspace command index exists for the
  // project. Names from the index are exact-match (no fuzzy / prefix);
  // the indexer keeps them de-duped per project.
  const matched = index?.commands.find((c) => c.name === first);
  if (matched) {
    let runArgv: string[];
    try {
      runArgv = shellSplit(matched.run);
    } catch (err) {
      return {
        kind: 'parseError',
        message: `Indexed command ${first} has unparseable run field: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (runArgv.length === 0) {
      return { kind: 'parseError', message: `Indexed command ${first} has empty run field` };
    }
    const extra = tokens.slice(1);
    const fullArgv = [...runArgv, ...extra];
    return {
      kind: 'argv',
      bin: fullArgv[0]!,
      args: fullArgv.slice(1),
      run: renderArgv(fullArgv),
      resolvedFrom: trimmed,
      matchedKind: matched.kind,
    };
  }

  // Project MCP tool — recognized after intercepts/craftbooks/index commands
  // (snake_case tool names rarely collide), before falling to raw shell.
  const tool = mcpTools?.find((t) => t.name === first);
  if (tool) {
    // Raw args substring preserves JSON quoting that shellSplit would strip;
    // the split tokens drive the key=value form.
    const rawArgs = trimmed.slice(first.length).trim();
    const parsed = parseMcpToolArgs(rawArgs, tokens.slice(1));
    if ('error' in parsed) return { kind: 'parseError', message: parsed.error };
    return { kind: 'mcpTool', name: tool.name, args: parsed.args, run: renderArgv(tokens) };
  }

  // Raw pass-through.
  return {
    kind: 'argv',
    bin: first,
    args: tokens.slice(1),
    run: renderArgv(tokens),
  };
}

/** Coerce a `key=value` scalar: booleans + finite numbers, else the raw string. */
function coerceScalar(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && Number.isFinite(Number(v))) return Number(v);
  return v;
}

/**
 * Parse an MCP tool command's args. A `{json}` raw string (quotes intact) wins
 * for complex/nested args; otherwise the shell-split `key=value` tokens are
 * scalar-coerced. `rawArgs` is the original substring after the tool name.
 */
function parseMcpToolArgs(
  rawArgs: string,
  tokens: string[],
): { args: Record<string, unknown> } | { error: string } {
  if (rawArgs === '') return { args: {} };
  if (rawArgs.startsWith('{')) {
    try {
      const obj: unknown = JSON.parse(rawArgs);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        return { args: obj as Record<string, unknown> };
      }
      return { error: 'tool args JSON must be an object' };
    } catch (e) {
      return { error: `invalid JSON args: ${e instanceof Error ? e.message : String(e)}` };
    }
  }
  const args: Record<string, unknown> = {};
  for (const tok of tokens) {
    const kv = /^([A-Za-z_][\w-]*)=(.*)$/.exec(tok);
    if (!kv) return { error: `expected key=value or a {json} object, got "${tok}"` };
    args[kv[1]!] = coerceScalar(kv[2]!);
  }
  return { args };
}

/**
 * Render argv back into a shell-paste form for display purposes. Used
 * for the persisted `command` message `content`, the history-audit
 * `run` field, and as the visible right-aligned bubble text. NOT used
 * to actually exec — `runWorkspaceCommand` takes argv directly.
 */
function renderArgv(argv: string[]): string {
  return argv
    .map((t) => {
      if (t === '') return "''";
      if (/^[A-Za-z0-9_.\-/=:@%+,]+$/.test(t)) return t;
      // Use double quotes; escape backslash, double-quote, and dollar.
      return `"${t.replace(/(["\\$`])/g, '\\$1')}"`;
    })
    .join(' ');
}

interface CraftbookParamDef {
  key: string;
  type: string;
  enum?: string[];
}

/**
 * Read the ordered scalar param definitions out of a craftbook's
 * `paramSchema` (a squisq/JSON-Schema object). Structural access — the
 * schema is stored permissively, so we type-guard each field.
 */
function craftbookParamDefs(spec: CraftbookCommandSpec): {
  defs: CraftbookParamDef[];
  required: Set<string>;
} {
  const schema = spec.paramSchema as
    | { properties?: Record<string, unknown>; required?: unknown }
    | undefined;
  const props = (schema?.properties ?? {}) as Record<string, Record<string, unknown>>;
  const defs: CraftbookParamDef[] = Object.keys(props).map((key) => {
    const p = props[key] ?? {};
    return {
      key,
      type: typeof p.type === 'string' ? p.type : 'string',
      ...(Array.isArray(p.enum) ? { enum: p.enum.map((v) => String(v)) } : {}),
    };
  });
  const required = new Set<string>(
    Array.isArray(schema?.required) ? (schema.required as unknown[]).map((v) => String(v)) : [],
  );
  return { defs, required };
}

function coerceCraftbookParam(
  def: CraftbookParamDef,
  value: string,
  out: Record<string, string>,
): string | null {
  if (def.type === 'boolean') {
    if (value !== 'true' && value !== 'false') {
      return `parameter "${def.key}" must be true or false`;
    }
  } else if (def.enum && !def.enum.includes(value)) {
    return `parameter "${def.key}" must be one of ${def.enum.join('|')}`;
  }
  out[def.key] = value;
  return null;
}

/**
 * Parse the trailing tokens of a craftbook command into param values.
 * Accepts positional tokens (mapped to `paramSchema.properties` in
 * declaration order) AND `key=value` / `--key=value` (a bare `--flag`
 * sets a declared boolean to "true"). Rejects unknown params, bad enum
 * values, missing required params, and extra positional tokens.
 */
function parseCraftbookArgs(
  spec: CraftbookCommandSpec,
  tokens: string[],
): { params: Record<string, string> } | { error: string } {
  const { defs, required } = craftbookParamDefs(spec);
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const params: Record<string, string> = {};
  const filled = new Set<string>();
  let positional = 0;

  for (const tok of tokens) {
    // `key=value`, `-key=value`, or `--key=value` (the launcher emits the
    // bare `key=value` form for params after a positional gap).
    const kv = /^-{0,2}([A-Za-z][\w-]*)=(.*)$/.exec(tok);
    if (kv) {
      const key = kv[1]!;
      const def = byKey.get(key);
      if (!def) return { error: `unknown parameter "${key}" for ${spec.command}` };
      const err = coerceCraftbookParam(def, kv[2]!, params);
      if (err) return { error: err };
      filled.add(key);
      continue;
    }
    const flag = /^--?([A-Za-z][\w-]*)$/.exec(tok);
    if (flag && byKey.get(flag[1]!)?.type === 'boolean') {
      params[flag[1]!] = 'true';
      filled.add(flag[1]!);
      continue;
    }
    // Positional: advance to the next declared param not already filled.
    while (positional < defs.length && filled.has(defs[positional]!.key)) positional++;
    if (positional >= defs.length) {
      return { error: `unexpected argument "${tok}" for ${spec.command}` };
    }
    const def = defs[positional]!;
    const err = coerceCraftbookParam(def, tok, params);
    if (err) return { error: err };
    filled.add(def.key);
    positional++;
  }

  for (const key of required) {
    if (!(key in params))
      return { error: `missing required parameter "${key}" for ${spec.command}` };
  }
  return { params };
}
