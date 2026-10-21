import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { HarnessClientId, HarnessLaunchSpec } from '@bendyline/gezel';
import { writeFileAtomic } from '@bendyline/gezel-inference/internal/fs/atomic';
import { which } from '../providers/anthropic-cli/binary.js';

/**
 * The command every outside app's MCP config runs to reach Gezel's tools:
 * `<node> ~/.gezel/integrations/mcp/launch.mjs --harness <client>`. Both
 * halves stay put across updates. `launch.mjs` imports whatever server
 * `current.json` names, and Gezel rewrites `current.json` at every start
 * from its own `require.resolve` — never from an assumed `~/.gezel/service`,
 * which an adopted machine-wide tree leaves stale (the autostart lesson).
 */

const LAUNCHER = `#!/usr/bin/env node
// Written by Gezel. Starts the Gezel tools server for an outside AI app.
// Gezel rewrites current.json beside this file whenever its install moves.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
let entry;
try {
  entry = JSON.parse(readFileSync(join(here, 'current.json'), 'utf8')).entry;
} catch {}
if (typeof entry !== 'string' || !entry) {
  process.stderr.write("Gezel's tools are not set up on this computer. Open Gezel: Settings > Integrations.\\n");
  process.exit(1);
}
await import(pathToFileURL(entry).href);
`;

export function harnessLauncherDir(home: string): string {
  return join(home, 'integrations', 'mcp');
}

export interface HarnessLauncher {
  /** Absolute path of the Node that runs the launcher, or null when none was found. */
  node: string | null;
  launcherPath: string;
  entry: string;
}

/**
 * The Node an outside app should start. Configs need an absolute path: a GUI
 * app's PATH is rarely the shell's. Electron's own binary is never it, since
 * the embedded service may be running inside one.
 */
export function resolveHarnessNode(opts: {
  home: string;
  env?: NodeJS.ProcessEnv;
  execPath?: string;
  isElectron?: boolean;
  platform?: NodeJS.Platform;
}): string | null {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const nodeName = platform === 'win32' ? 'node.exe' : 'node';
  const pinned = env.GEZEL_NODE_PATH;
  if (pinned && existsSync(pinned)) return pinned;
  const isElectron = opts.isElectron ?? Boolean(process.versions.electron);
  if (!isElectron) return opts.execPath ?? process.execPath;
  const bundled = join(opts.home, 'bin', nodeName);
  if (existsSync(bundled)) return bundled;
  return which('node', env.PATH ?? '', env.PATHEXT);
}

export function resolveHarnessEntry(): string {
  return createRequire(import.meta.url).resolve('@bendyline/gezel-mcp/dist/harness.js');
}

/** Write the launcher and point it at this install's server. Idempotent. */
export async function ensureHarnessLauncher(opts: {
  home: string;
  entry?: string;
  node?: string | null;
}): Promise<HarnessLauncher> {
  const dir = harnessLauncherDir(opts.home);
  await mkdir(dir, { recursive: true });
  const launcherPath = join(dir, 'launch.mjs');
  const entry = opts.entry ?? resolveHarnessEntry();
  const current = await readFile(launcherPath, 'utf8').catch(() => null);
  if (current !== LAUNCHER) await writeFile(launcherPath, LAUNCHER, { mode: 0o755 });
  const pointerPath = join(dir, 'current.json');
  const pointer = `${JSON.stringify({ entry }, null, 2)}\n`;
  if ((await readFile(pointerPath, 'utf8').catch(() => null)) !== pointer) {
    await writeFileAtomic(pointerPath, pointer);
  }
  const node = opts.node === undefined ? resolveHarnessNode({ home: opts.home }) : opts.node;
  return { node, launcherPath, entry };
}

/**
 * The launch command for one app. VS Code and Cursor substitute
 * `${workspaceFolder}` themselves; the server ignores the literal when they
 * do not. Claude Desktop names its project, having no folder.
 */
export function harnessLaunchSpec(
  launcher: HarnessLauncher,
  client: HarnessClientId,
  opts: { projectId?: string; workspaceFolderVariable?: boolean } = {},
): HarnessLaunchSpec | null {
  if (!launcher.node) return null;
  return {
    command: launcher.node,
    args: [
      launcher.launcherPath,
      '--harness',
      client,
      ...(opts.projectId ? ['--project', opts.projectId] : []),
      ...(opts.workspaceFolderVariable ? ['--folder', '${workspaceFolder}'] : []),
    ],
  };
}
