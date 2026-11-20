import type { ParsedGezel, Project } from '@bendyline/gezel';
import { HttpStatusError } from '@bendyline/gezel/runtime';

/**
 * What a machine-shared definition may not carry.
 *
 * The machine-shared root (`%ProgramData%\Gezel\shared`, `/Users/Shared/Gezel`,
 * `/var/lib/gezel/shared`) is writable by every local account, and each
 * account's daemon reads it with that account's own authority. A shared
 * `project.json` or `gezel.md` is therefore text another account may have
 * written. One account once could point every other account's daemon at that
 * account's private folders, credentials and Startup folder just by editing a
 * shared project, with nobody on the other accounts doing anything.
 *
 * So a field that would aim this daemon at the account's own folders,
 * secrets, repositories or other projects, or loosen its agents, is ignored
 * when read and refused when written. A shared project only ever touches the
 * shared tree: its own internal workspace, artifacts and memory. Everything
 * else stays with each account's private projects and settings.
 */
const REFUSED_PROJECT_FIELDS = {
  workingDir: 'use a folder of your own',
  linkedProjectIds: 'link other projects',
  github: 'link a GitHub repository',
  connectors: 'hold connections',
  grantedCredentials: 'use saved credentials',
  credentialAllowedOrigins: 'use saved credentials',
  claudePermissionMode: 'set Claude Code permissions',
  codexPermissionMode: 'set Codex permissions',
} as const satisfies Partial<Record<keyof Project, string>>;

/** Gezel settings that loosen an agent's sandbox or permissions. */
const REFUSED_GEZEL_FIELDS = {
  sandboxCopilot: 'turn off the Copilot sandbox',
  claudePermissionMode: 'set Claude Code permissions',
  codexPermissionMode: 'set Codex permissions',
} as const;

type FieldPhrases = Readonly<Record<string, string>>;

/**
 * An `HttpStatusError`, so every route that reaches the Store answers 403
 * with this sentence instead of a generic 500, and MCP tools hand it to the
 * gezel verbatim.
 */
export class SharedEntityAuthorityError extends HttpStatusError {
  readonly code = 'machine_shared' as const;
  /** The message is the remedy; never rewrite it into a generic failure. */
  readonly isActionable = true;
  constructor(message: string) {
    super(message, 403, { code: 'machine_shared' });
    this.name = 'SharedEntityAuthorityError';
  }
}

function presentFields(record: object, fields: FieldPhrases): string[] {
  const values = record as Record<string, unknown>;
  return Object.keys(fields).filter((key) => {
    const value = values[key];
    if (value === undefined || value === null) return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  });
}

function without<T extends object>(record: T, keys: readonly string[]): T {
  const copy = { ...record } as Record<string, unknown>;
  for (const key of keys) delete copy[key];
  return copy as T;
}

function refusal(entity: 'project' | 'crew member', present: string[], fields: FieldPhrases) {
  const actions = [...new Set(present.map((key) => fields[key]))].join(', or ');
  const remedy =
    entity === 'project'
      ? 'Use a project of your own for that.'
      : 'Use a crew member of your own for that.';
  return new SharedEntityAuthorityError(
    `This ${entity} is shared with every account on this computer, so it can't ${actions}. Any account can edit what is shared, and these settings would act with your account's access. ${remedy}`,
  );
}

/** A shared project as this account may act on it, and what was left out. */
export function withoutSharedProjectAuthority(project: Project): {
  project: Project;
  ignored: string[];
} {
  const ignored = presentFields(project, REFUSED_PROJECT_FIELDS);
  return ignored.length > 0
    ? { project: without(project, Object.keys(REFUSED_PROJECT_FIELDS)), ignored }
    : { project, ignored };
}

/** Throws when `project` would put a refused field into a shared definition. */
export function assertNoSharedProjectAuthority(project: Project): void {
  const present = presentFields(project, REFUSED_PROJECT_FIELDS);
  if (present.length > 0) throw refusal('project', present, REFUSED_PROJECT_FIELDS);
}

/** A shared gezel's definition as this account may act on it, and what was left out. */
export function withoutSharedGezelAuthority(parsed: ParsedGezel): {
  parsed: ParsedGezel;
  ignored: string[];
} {
  const ignored = presentFields(parsed.frontmatter, REFUSED_GEZEL_FIELDS);
  if (ignored.length === 0) return { parsed, ignored };
  return {
    parsed: {
      ...parsed,
      frontmatter: without(parsed.frontmatter, Object.keys(REFUSED_GEZEL_FIELDS)),
    },
    ignored,
  };
}

/** Throws when a settings patch would set a refused field on a shared gezel. */
export function assertNoSharedGezelAuthority(patch: object): void {
  const present = presentFields(patch, REFUSED_GEZEL_FIELDS);
  if (present.length > 0) throw refusal('crew member', present, REFUSED_GEZEL_FIELDS);
}
