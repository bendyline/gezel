import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { runTextProbe } from '../providers/codex-cli/binary.js';

/**
 * OpenCode auto-loads `{plugin,plugins}/*.{ts,js}` from each config directory
 * it knows about. `plugins` is the documented spelling.
 */
const PLUGIN_DIR_NAME = 'plugins';
export const OPENCODE_PLUGIN_FILE_NAME = 'gezel.js';

export interface OpenCodeConfigDir {
  dir: string;
  source: 'probe' | 'xdg' | 'default';
}

export interface ResolveOpenCodeConfigDirOptions {
  binaryPath?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  probe?: (path: string, args: string[]) => Promise<string>;
}

/**
 * Ask OpenCode where its config lives rather than reimplementing its
 * precedence. `opencode debug paths` prints one `key<space>value` line per
 * root and already accounts for `OPENCODE_CONFIG_DIR` and `XDG_CONFIG_HOME`.
 *
 * The probe inherits the daemon's environment, not the user's login shell, so
 * a shell-only `OPENCODE_CONFIG_DIR` still resolves to the default root. That
 * is why an install never blind-writes: the caller compares the resolved
 * directory against the file it already owns before touching anything.
 */
export async function resolveOpenCodeConfigDir(
  opts: ResolveOpenCodeConfigDirOptions,
): Promise<OpenCodeConfigDir> {
  const env = opts.env ?? process.env;
  const probe = opts.probe ?? runTextProbe;

  if (opts.binaryPath) {
    try {
      const dir = parseConfigPath(await probe(opts.binaryPath, ['debug', 'paths']));
      if (dir) return { dir, source: 'probe' };
    } catch {
      // An OpenCode too old for `debug paths`, or one that cannot start, still
      // reads the conventional location.
    }
  }

  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && isAbsolute(xdg)) return { dir: join(xdg, 'opencode'), source: 'xdg' };
  return { dir: join(opts.home ?? homedir(), '.config', 'opencode'), source: 'default' };
}

export function openCodePluginDir(configDir: string): string {
  return join(configDir, PLUGIN_DIR_NAME);
}

export function openCodePluginPath(configDir: string): string {
  return join(openCodePluginDir(configDir), OPENCODE_PLUGIN_FILE_NAME);
}

function parseConfigPath(output: string): string | null {
  for (const line of output.split('\n')) {
    const match = /^\s*config\s+(\S.*?)\s*$/.exec(line);
    if (!match?.[1]) continue;
    return isAbsolute(match[1]) ? match[1] : null;
  }
  return null;
}
