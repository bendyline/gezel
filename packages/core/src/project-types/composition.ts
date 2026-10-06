/**
 * Pure project-type composition rules shared by every host that applies a
 * type: the desktop daemon (`service/src/project-type/`) and the phone
 * runtime (`runtime/project-types.ts`). Anything that decides what a type
 * renders, which tools a session or page sees, or who fills a crew slot lives
 * here, so the two hosts cannot drift apart.
 */
import { type ModelTier, tierAtLeast } from '../roles/tier.js';
import type { ProjectTypeManifest, ProjectTypeTool } from '../schemas/catalog.js';
import {
  type GezelFrontmatter,
  GezelFrontmatterSchema,
  type GezelSummary,
} from '../schemas/gezel.js';

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
