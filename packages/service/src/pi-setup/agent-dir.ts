import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** pi auto-loads `{plugin,plugins}`-style globs from this directory. */
const EXTENSION_DIR_NAME = 'extensions';
export const PI_EXTENSION_FILE_NAME = 'gezel.js';

export interface PiAgentDir {
  dir: string;
  source: 'override' | 'env' | 'default';
}

/**
 * Resolve pi's agent directory — the root holding `models.json`, `settings.json`
 * and the auto-loaded `extensions/`.
 *
 * pi has no "print my paths" command, so this reads the documented env var and
 * falls back to the conventional location. The daemon does not inherit the
 * user's login shell, so a `PI_CODING_AGENT_DIR` exported only in `~/.zshrc` is
 * invisible here and resolution lands on the default. That is why `source` is
 * reported all the way to the confirmation dialog rather than swallowed: an
 * install into a root pi never reads would otherwise look like success.
 */
export function resolvePiAgentDir(opts: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  override?: string;
}): PiAgentDir {
  if (opts.override) return { dir: opts.override, source: 'override' };
  const env = opts.env ?? process.env;
  const configured = env.PI_CODING_AGENT_DIR;
  if (configured && isAbsolute(configured)) return { dir: configured, source: 'env' };
  return { dir: join(opts.home ?? homedir(), '.pi', 'agent'), source: 'default' };
}

export function piExtensionDir(agentDir: string): string {
  return join(agentDir, EXTENSION_DIR_NAME);
}

export function piExtensionPath(agentDir: string): string {
  return join(piExtensionDir(agentDir), PI_EXTENSION_FILE_NAME);
}
