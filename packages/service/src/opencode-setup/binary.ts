import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';
import { runVersionProbe, which } from '../providers/codex-cli/binary.js';

/**
 * Non-throwing detection probe for the Settings card. Mirrors
 * `detectCodexBinary`, minus the capability probes: the OpenCode integration
 * publishes a config file rather than driving the CLI, so the only questions
 * are "is it installed" and "what does it call itself".
 */
export interface OpenCodeBinaryDetection {
  installed: boolean;
  path?: string;
  version?: string;
  error?: string;
}

const NOT_FOUND =
  'OpenCode was not found on this computer. Install it from https://opencode.ai, then re-check this card.';

interface OpenCodeBinaryCandidateOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}

/**
 * Locations used by OpenCode's own installer plus conventional package-manager
 * locations which a desktop-launched daemon commonly does not inherit in PATH.
 * Keep PATH lookup separate and first: an executable the user deliberately put
 * there should win over an older installer copy.
 */
export function openCodeBinaryCandidates(opts: OpenCodeBinaryCandidateOptions = {}): string[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const path = platform === 'win32' ? win32 : posix;
  const names =
    platform === 'win32'
      ? ['opencode', 'opencode.exe', 'opencode.cmd', 'opencode.bat']
      : ['opencode'];
  const dirs: string[] = [];

  const addAbsolute = (dir: string | undefined): void => {
    if (dir && path.isAbsolute(dir)) dirs.push(dir);
  };

  // OpenCode documents these in priority order for its installer. The current
  // curl installer uses ~/.opencode/bin, while older/newer versions may honor
  // the two environment overrides and ~/bin.
  addAbsolute(env.OPENCODE_INSTALL_DIR);
  addAbsolute(env.XDG_BIN_DIR);
  addAbsolute(path.join(home, 'bin'));
  addAbsolute(path.join(home, '.opencode', 'bin'));
  addAbsolute(path.join(home, '.local', 'bin'));

  if (platform === 'darwin') {
    addAbsolute('/opt/homebrew/bin');
    addAbsolute('/usr/local/bin');
  } else if (platform === 'linux') {
    addAbsolute('/usr/local/bin');
    addAbsolute('/usr/bin');
    addAbsolute('/snap/bin');
    addAbsolute('/home/linuxbrew/.linuxbrew/bin');
  } else if (platform === 'win32') {
    // Direct installer, Scoop, npm, Chocolatey, and WinGet defaults. Prefer
    // environment-provided roots, but retain their ordinary fallbacks for a
    // GUI process whose PATH was created before the package manager ran.
    addAbsolute(path.join(env.SCOOP ?? path.join(home, 'scoop'), 'shims'));
    addAbsolute(env.APPDATA ? path.join(env.APPDATA, 'npm') : undefined);
    addAbsolute(
      env.ChocolateyInstall
        ? path.join(env.ChocolateyInstall, 'bin')
        : env.ProgramData
          ? path.join(env.ProgramData, 'chocolatey', 'bin')
          : undefined,
    );
    addAbsolute(
      env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links') : undefined,
    );
  }

  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      const key = platform === 'win32' ? candidate.toLowerCase() : candidate;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(candidate);
      }
    }
  }
  return candidates;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export async function detectOpenCodeBinary(opts: {
  override?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}): Promise<OpenCodeBinaryDetection> {
  const env = opts.env ?? process.env;
  const onPath = opts.override ? null : which('opencode', env.PATH ?? '', env.PATHEXT);
  const candidates = opts.override
    ? [opts.override]
    : [
        ...(onPath ? [onPath] : []),
        ...openCodeBinaryCandidates({ env, home: opts.home, platform: opts.platform }).filter(
          isFile,
        ),
      ];

  let lastFailure: { path: string; error: unknown } | null = null;
  for (const candidate of candidates) {
    try {
      const version = await runVersionProbe(candidate);
      return { installed: true, path: candidate, version };
    } catch (error) {
      lastFailure = { path: candidate, error };
    }
  }

  if (!lastFailure) return { installed: false, error: NOT_FOUND };
  return {
    installed: false,
    path: lastFailure.path,
    error: `OpenCode at ${lastFailure.path} is not executable: ${
      lastFailure.error instanceof Error ? lastFailure.error.message : String(lastFailure.error)
    }`,
  };
}
