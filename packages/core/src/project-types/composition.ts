/**
 * Pure project-type composition rules shared by every host that applies a
 * type: the desktop daemon (`service/src/project-type/`) and the phone
 * runtime (`runtime/project-types.ts`). Anything that decides what a type
 * renders, which tools a session or page sees, or who fills a crew slot lives
 * here, so the two hosts cannot drift apart.
 */
import type { TerminalToolPolicy } from '../local-loop/provider-contract.js';
import { type ModelTier, tierAtLeast } from '../roles/tier.js';
import type {
  ProjectTypeManifest,
  ProjectTypeTool,
  ProjectTypeToolReaction,
} from '../schemas/catalog.js';
import {
  type GezelFrontmatter,
  GezelFrontmatterSchema,
  type GezelSummary,
} from '../schemas/gezel.js';
import type { TurnMessageOrigin } from '../schemas/session.js';
import { scriptOutputMatches } from '../scripts/predicates.js';

/** The builtins a lean (game / chat-room) type keeps beside its own script tools. */
export const LEAN_PROFILE_BUILTIN_TOOLS: readonly string[] = ['ask_user_question'];

/**
 * The reply a lean (game / chat-room) session holds room for on a small
 * system model: a move call and a line of table talk fit several times over.
 * The desktop caps a game reaction's wrap-up at 300 tokens for the same reason.
 */
export const LEAN_PROFILE_REPLY_MAX_TOKENS = 512;

/** Marker line opening a script a project type installed into a project. */
export const PROJECT_TYPE_SCRIPT_MARKER = '// @gezel-project-type:';

/** Provenance header for a project-type script; provenance, never a trust grant. */
export function projectTypeScriptHeader(typeId: string, version: string): string {
  return `${PROJECT_TYPE_SCRIPT_MARKER} ${typeId}@${version}\n`;
}

/** `<typeId>@<version>` of a script a project type installed, else null. */
export function projectTypeScriptProvenance(content: string): string | null {
  if (!content.startsWith(PROJECT_TYPE_SCRIPT_MARKER)) return null;
  const newline = content.indexOf('\n');
  const line = newline === -1 ? content : content.slice(0, newline);
  return line.slice(PROJECT_TYPE_SCRIPT_MARKER.length).trim();
}

/**
 * Seed a param object from the type's JSON-schema `default`s. The type owns
 * its defaults, so the engine applies them under whatever the caller passed —
 * a caller that omits a param still gets its default rather than leaving
 * `{{placeholder}}` unrendered.
 */
export function seedParamDefaults(
  paramSchema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const props = (paramSchema?.properties ?? {}) as Record<
    string,
    { default?: unknown } | undefined
  >;
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(props)) {
    if (def && def.default !== undefined) out[key] = def.default;
  }
  return out;
}

/**
 * Substitute `{{ key }}` placeholders with param values. Unknown placeholders
 * are left untouched (never silently blanked) so a template typo is visible
 * rather than swallowed. Non-string values are stringified.
 */
export function renderProjectTypeTemplate(
  text: string,
  params: Record<string, unknown> | undefined,
): string {
  if (!params) return text;
  return text.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (whole, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, key)) return whole;
    const v = params[key];
    return typeof v === 'string' ? v : v == null ? '' : String(v);
  });
}

/**
 * A gilde template's optional frontmatter extension for the gezels it hires,
 * validated through the frontmatter schema, or null when it has none. Name
 * and id are never taken from a template.
 */
export function projectTypeTemplateFrontmatter(
  raw: Record<string, unknown> | undefined,
): Partial<GezelFrontmatter> | null {
  if (!raw || Object.keys(raw).length === 0) return null;
  const parsed = GezelFrontmatterSchema.parse({ name: '__template__', ...raw });
  const { name: _name, id: _id, ...extras } = parsed;
  return extras;
}

export type ProjectTypeCrewCandidate = Pick<
  GezelSummary,
  'id' | 'name' | 'role' | 'templateId' | 'fixedFunction'
>;

function roleKey(role: string | undefined): string {
  return (role ?? '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * The gezel already filling a crew slot: one from the same template, else
 * one with the same role title. Titles match exactly, not through the role
 * aliases, which map "Practice Coach" to voorman. A fixed-function gezel runs
 * a single scripted job and never fills a slot, and no gezel fills two.
 */
export function projectTypeCrewMatch<T extends ProjectTypeCrewCandidate>(
  pool: readonly T[],
  slot: { templateId: string; role: string | undefined },
  taken: ReadonlySet<string>,
): T | undefined {
  const free = pool.filter((gezel) => !taken.has(gezel.id) && !gezel.fixedFunction);
  const sameTemplate = free.find((gezel) => gezel.templateId === slot.templateId);
  if (sameTemplate) return sameTemplate;
  const wanted = roleKey(slot.role);
  if (!wanted) return undefined;
  return free.find((gezel) => roleKey(gezel.role) === wanted);
}

/**
 * The script-backed tools a session registers for the model. Names listed in
 * `pages.tools` are the page-only surface and never reach the model — a
 * checkers gezel must never see `user_move`.
 */
export function projectTypeModelTools(
  manifest: Pick<ProjectTypeManifest, 'tools' | 'pages'>,
): ProjectTypeTool[] {
  const pageOnly = new Set(manifest.pages?.tools ?? []);
  return (manifest.tools ?? []).filter((tool) => !pageOnly.has(tool.name));
}

/** Only the tools listed in `pages.tools` that resolve to a declared tool. */
export function projectTypePageTools(
  manifest: Pick<ProjectTypeManifest, 'tools' | 'pages'>,
): ProjectTypeTool[] {
  const listed = new Set(manifest.pages?.tools ?? []);
  return (manifest.tools ?? []).filter((tool) => listed.has(tool.name));
}

export interface ProjectTypePageReadScope {
  source: 'workspace' | 'artifacts';
  path: string;
  subtree: boolean;
}

/** The declared data reads of a type's pages; `type`-source reads are the page tree itself. */
export function projectTypePageReads(
  manifest: Pick<ProjectTypeManifest, 'pages'>,
): ProjectTypePageReadScope[] {
  return (manifest.pages?.reads ?? [])
    .filter(
      (read): read is typeof read & { source: 'workspace' | 'artifacts' } =>
        read.source === 'workspace' || read.source === 'artifacts',
    )
    .map((read) => ({ source: read.source, path: read.path, subtree: read.subtree === true }));
}

/**
 * Normalize a page-supplied relative path: forward slashes, no leading `/`,
 * no drive letter, no `..` segment, no trailing slash. Null when the path
 * could escape its root. `''` is the root itself.
 */
export function normalizePagePath(input: string): string | null {
  if (typeof input !== 'string' || input.includes('\0')) return null;
  const slashPath = input.replaceAll('\\', '/');
  if (slashPath.startsWith('/') || /^[A-Za-z]:\//.test(slashPath)) return null;
  const parts: string[] = [];
  for (const part of slashPath.split('/')) {
    if (part === '..') return null;
    if (part === '' || part === '.') continue;
    parts.push(part);
  }
  return parts.join('/');
}

/** Whether a normalized path is the scope itself or inside its subtree. */
export function pagePathIsInScope(path: string, scopePath: string): boolean {
  return scopePath === '' || path === scopePath || path.startsWith(`${scopePath}/`);
}

/** Whether a page read of `path` from `source` is one the type declared. */
export function pageReadIsDeclared(
  scopes: readonly ProjectTypePageReadScope[],
  source: 'workspace' | 'artifacts',
  path: string,
): boolean {
  return scopes.some((scope) => {
    if (scope.source !== source) return false;
    const scopePath = normalizePagePath(scope.path) ?? scope.path;
    return scope.subtree ? pagePathIsInScope(path, scopePath) : path === scopePath;
  });
}

/**
 * Flatten a script run's output into dot-path template keys (depth ≤ 2):
 * `{board, stats: {moves}}` → `output.board`, `output.stats.moves`, plus a
 * JSON `output.stats` for the object itself. Objects and arrays
 * JSON-stringify; templates pick whichever form reads best.
 */
export function flattenRunOutput(output: unknown): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  if (output === null || output === undefined || typeof output !== 'object') {
    if (output !== undefined) map.output = output;
    return map;
  }
  map.output = JSON.stringify(output);
  for (const [key, value] of Object.entries(output as Record<string, unknown>)) {
    if (value !== null && typeof value === 'object') {
      map[`output.${key}`] = JSON.stringify(value);
      for (const [inner, innerValue] of Object.entries(value as Record<string, unknown>)) {
        map[`output.${key}.${inner}`] =
          innerValue !== null && typeof innerValue === 'object'
            ? JSON.stringify(innerValue)
            : innerValue;
      }
    } else {
      map[`output.${key}`] = value;
    }
  }
  return map;
}

/** The seed a page reaction delivers, labelled with the type that sent it. */
export function renderProjectTypeReactionSeed(args: {
  typeName: string;
  prompt: string;
  tool: string;
  params?: Record<string, unknown>;
  output: unknown;
}): string {
  const renderMap: Record<string, unknown> = {
    ...(args.params ?? {}),
    ...flattenRunOutput(args.output),
    tool: args.tool,
  };
  return `[${args.typeName} page]: ${renderProjectTypeTemplate(args.prompt, renderMap)}`;
}

/** Whether a type's page speaks the v1 `window.gezel` API rather than the v0 sentinels. */
export function projectTypePageUsesApiV1(
  manifest: Pick<ProjectTypeManifest, 'pages'>,
  entryHtml?: string,
): boolean {
  if (manifest.pages?.api === 1) return true;
  return entryHtml !== undefined && /\bwindow\.gezel\b|\bmakeDemoGezel\s*\(/.test(entryHtml);
}

/** What a host can supply to a type's sessions, for {@link projectTypeHostGap}. */
export interface ProjectTypeHost {
  /** The tier of the model this host runs, when it runs exactly one. */
  modelTier?: ModelTier;
  /** The host runs project scripts (a type's tools are scripts). */
  scripts: boolean;
  /** The host installs catalog toolsets. */
  toolsets: boolean;
}

/**
 * Why this host cannot run a type, in words for a person, or undefined when
 * it can. A host offers such a type disabled with the reason and refuses to
 * create it; it never runs one on a model or runtime that cannot hold it.
 */
export function projectTypeHostGap(
  manifest: Pick<ProjectTypeManifest, 'capabilityFloor' | 'tools' | 'toolsets'>,
  host: ProjectTypeHost,
): string | undefined {
  if (
    manifest.capabilityFloor &&
    host.modelTier &&
    !tierAtLeast(host.modelTier, manifest.capabilityFloor)
  )
    return 'Needs a larger model than the one this device runs.';
  if ((manifest.tools?.length ?? 0) > 0 && !host.scripts)
    return 'Needs scripts, which this device cannot run.';
  if ((manifest.toolsets?.length ?? 0) > 0 && !host.toolsets)
    return 'Needs tools that only the desktop app installs.';
  return undefined;
}

/**
 * Whether a session runs lean: a conversation in a lean type (a game, a tutor,
 * the chat room). A task step there keeps the kit its step needs; narrowed to
 * the type's own tools, a craftbook's steps could not write what they owe.
 */
export function leanSession(
  project: { leanProfile?: boolean } | null | undefined,
  session: { taskRef?: string },
): boolean {
  return project?.leanProfile === true && !session.taskRef;
}

type TurnTool = Pick<ProjectTypeTool, 'name' | 'turn' | 'state'>;

/** How an activity's turns run, on every host, from what its tools declare. */
export interface ProjectTypeTurnRules {
  /** A person's message is answered from this tool's output (`state`). */
  stateTool?: string;
  /**
   * The calls that are a turn's whole job (`turn`): a successful one ends the
   * turn, its `say` argument the reply. Asked for more, a small model writes
   * the call again: Gemini Nano followed six of twelve checkers moves with
   * another `make_move`, escaped and shown raw as its reply (Galaxy S26+,
   * 2026-10-06).
   */
  terminal?: TerminalToolPolicy;
}

/**
 * Catalog versions published before tools declared `turn` and `state`
 * (checkers 1.2.1, chess 1.0.4, go 1.0.2 and earlier) get the same rules from
 * the tool names every board game shares. Remove once the pinned catalog's
 * games all declare them.
 */
function legacyGameTurnTools(
  tools: readonly TurnTool[],
  project: { leanProfile?: boolean } | null | undefined,
): readonly TurnTool[] {
  const names = new Set(tools.map((tool) => tool.name));
  if (!project?.leanProfile || !names.has('get_board') || !names.has('make_move')) return tools;
  return tools.map((tool) =>
    tool.name === 'get_board'
      ? { ...tool, state: true }
      : tool.name === 'make_move'
        ? { ...tool, turn: { say: 'moveThought', fallback: 'Move made — your turn.' } }
        : tool,
  );
}

/** The turn rules a session's type tools declare, if any. */
export function projectTypeTurnRules(
  tools: readonly TurnTool[],
  project?: { leanProfile?: boolean } | null,
): ProjectTypeTurnRules | undefined {
  const effective = tools.some((tool) => tool.turn || tool.state)
    ? tools
    : legacyGameTurnTools(tools, project);
  const stateTool = effective.find((tool) => tool.state)?.name;
  const turnTools = effective.filter((tool) => tool.turn);
  if (!stateTool && turnTools.length === 0) return undefined;
  return {
    ...(stateTool ? { stateTool } : {}),
    ...(turnTools.length
      ? {
          terminal: {
            toolNames: turnTools.map((tool) => tool.name),
            closingArgByTool: Object.fromEntries(
              turnTools.flatMap((tool) => (tool.turn?.say ? [[tool.name, tool.turn.say]] : [])),
            ),
            fallbackText:
              turnTools.find((tool) => tool.turn?.fallback)?.turn?.fallback ?? 'Your turn.',
            maxClosingChars: 600,
          },
        }
      : {}),
  };
}

/**
 * The tool a reaction's turn must call: its `turn.tool`, when that is one of
 * the session's turn tools and `turn.when` holds over the output of the tool
 * that summoned it. Otherwise the turn is an ordinary one, free to say
 * something instead (checkers: the game is over, so there is no move to make).
 */
export function reactionRequiredTool(
  reaction: Pick<ProjectTypeToolReaction, 'turn'> | undefined,
  output: unknown,
  tools: readonly TurnTool[],
  project?: { leanProfile?: boolean } | null,
): string | undefined {
  const turn = reaction?.turn;
  if (!turn) return undefined;
  const turnTools = projectTypeTurnRules(tools, project)?.terminal?.toolNames ?? [];
  if (!turnTools.includes(turn.tool)) return undefined;
  if (turn.when && !scriptOutputMatches(turn.when, output)) return undefined;
  return turn.tool;
}

/** What is wrong with a type's turn declarations, for content checks. */
export function projectTypeTurnProblems(
  manifest: Pick<ProjectTypeManifest, 'tools' | 'pages'>,
): string[] {
  const problems: string[] = [];
  const pageTools = new Set(manifest.pages?.tools ?? []);
  const byName = new Map(manifest.tools.map((tool) => [tool.name, tool]));
  for (const tool of manifest.tools) {
    if ((tool.turn || tool.state) && pageTools.has(tool.name))
      problems.push(`${tool.name} is a page tool; turn and state apply to tools the model calls`);
    const turn = tool.reaction?.turn;
    if (!turn) continue;
    const target = byName.get(turn.tool);
    if (!target)
      problems.push(
        `${tool.name}: reaction.turn names ${turn.tool}, which is not a tool of this type`,
      );
    else if (pageTools.has(turn.tool))
      problems.push(
        `${tool.name}: reaction.turn names ${turn.tool}, a page tool the model never sees`,
      );
    else if (!target.turn)
      problems.push(`${tool.name}: reaction.turn names ${turn.tool}, which does not declare turn`);
  }
  if (manifest.tools.filter((tool) => tool.state).length > 1)
    problems.push('more than one tool declares state; a message is answered from one');
  return problems;
}

/**
 * Whether a turn starts from freshly read state: any message a person sent or
 * answered, so "your move" works whatever happened to the last seed. Never a
 * page seed, a crew handoff or a nudge, which carry or need no state, and
 * never text that already carries a board.
 */
export function turnStateWanted(text: string, origin: TurnMessageOrigin): boolean {
  if (origin !== 'direct-user' && origin !== 'question-answer') return false;
  return text.trim().length > 0 && !/\b(?:board now|legal moves)\s*:/i.test(text);
}

/** The state a person's message is answered from, ahead of their words. */
export function renderTurnStatePrelude(tool: string, output: unknown): string {
  return `[Latest state — read from \`${tool}\` immediately before this turn. It overrides every older copy in the conversation; act on this one.]\n${JSON.stringify(output)}`;
}
