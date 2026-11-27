/**
 * Claude Code permission rules that keep its own file tools out of the files
 * under the Gezel home that hold credentials: the person's own token and the
 * session configs in `runtime/`, app and account tokens, add-in secrets and
 * the file-backed keyring. Read rules also cover Grep and Glob.
 *
 * A backstop, not a boundary: a shell reads files without asking these rules,
 * which is why the shell itself follows the security policy's
 * `allowAgentShell`. The rest of the home (a project's internal workspace,
 * its artifacts) stays readable.
 */

import { isAbsolute } from 'node:path';

const CREDENTIAL_ENTRIES = [
  'runtime/**',
  'integrations/**',
  'tokens.json',
  'accounts.json',
  'account-sessions.json',
  'secrets.enc',
  'secrets.key',
  'config.json',
] as const;

/**
 * An absolute path in Claude Code's rule form: `//` then the path with
 * forward slashes. Claude Code matches Windows paths in POSIX form, so
 * `C:\Users\me` is `//c/Users/me`.
 */
export function claudeAbsoluteRulePath(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const drive = /^([a-zA-Z]):\/(.*)$/.exec(slashed);
  if (drive) return `//${drive[1]!.toLowerCase()}/${drive[2]}`;
  return `/${slashed.startsWith('/') ? slashed : `/${slashed}`}`;
}

/**
 * Claude Code's own project settings, at any depth below the working folder.
 * A hook written there runs as the person the next time Claude Code starts in
 * that folder; the worker loads only user settings (`--setting-sources
 * user`), and these rules keep Claude's file tools from planting one for the
 * person's own sessions. `Edit` rules cover every built-in tool that edits.
 */
export const CLAUDE_PROJECT_SETTINGS_DENY_RULES: readonly string[] = [
  'Edit(**/.claude/settings.json)',
  'Edit(**/.claude/settings.local.json)',
];

/**
 * Files and folders a cloud model may not read: connector data the person
 * keeps on models on this computer, in any project. A rule covers a folder
 * and everything below it.
 */
export function claudeKeptLocalDenyRules(paths: readonly string[]): string[] {
  return paths
    .filter((path) => isAbsolute(path))
    .map(claudeAbsoluteRulePath)
    .flatMap((path) => [`Read(${path})`, `Read(${path}/**)`]);
}

export function claudeCredentialDenyRules(gezelHome: string | undefined): string[] {
  if (!gezelHome || !isAbsolute(gezelHome)) return [];
  const root = claudeAbsoluteRulePath(gezelHome);
  return CREDENTIAL_ENTRIES.flatMap((entry) => [
    `Read(${root}/${entry})`,
    `Edit(${root}/${entry})`,
  ]);
}
