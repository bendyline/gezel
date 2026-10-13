#!/usr/bin/env node
/**
 * `pnpm app:new`: build, then launch the dev Electron shell against a
 * brand-new GEZEL_HOME, so first-run flows run the way a new install sees
 * them without touching `~/.gezel-dev`.
 *
 * The home defaults to `~/.gezel-new` and is wiped at the start of every run.
 * `--keep` relaunches into the same home without wiping, for testing the
 * second launch after onboarding. `--home=<path>` picks another location.
 *
 * Wiping is guarded: only a directory this script created (it carries
 * MARKER_FILE) or an empty one, never a protected home, and never while a
 * Gezel instance still holds the home. GEZEL_HOME is deliberately not read as
 * the target: a shell that exports it for a real home must not turn this
 * command into an `rm -rf` of that home.
 *
 * In dev, Electron's userData follows the home (`<home>/.electron-userdata`),
 * so renderer state such as localStorage starts empty too. Model weights are
 * not shared; `GEZEL_READONLY_MODEL_HOMES=$HOME/.gezel-dev` lets the new home
 * read them instead of downloading (they are re-hashed once per wiped home).
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { spawnPnpm } from './pnpm-cli.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');

export const MARKER_FILE = '.gezel-new-home';
const USAGE = 'Usage: pnpm app:new [-- --keep] [-- --home=<path>]';

export function parseAppNewArgs(argv, home = homedir()) {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let requested = join(home, '.gezel-new');
  let keep = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--keep') keep = true;
    else if (arg.startsWith('--home=')) requested = arg.slice('--home='.length);
    else if (arg === '--home') requested = args[++i] ?? '';
    else throw new Error(`unknown argument ${arg}\n${USAGE}`);
  }
  // Shells do not expand `~` after `--home=`.
  if (requested === '~' || requested.startsWith('~/')) requested = join(home, requested.slice(1));
  if (!isAbsolute(requested)) {
    throw new Error(`--home must be an absolute path, got "${requested}"`);
  }
  return { home: resolve(requested), keep };
}

/** Throws when `target` is, or contains, a home this command must never wipe. */
export function assertWipeableLocation(target, options = {}) {
  const userHome = resolve(options.userHome ?? homedir());
  const protectedPaths = [
    userHome,
    join(userHome, '.gezel'),
    join(userHome, '.gezel-dev'),
    resolve(options.repoRoot ?? repoRoot),
  ];
  for (const path of protectedPaths) {
    const rel = relative(target, path);
    if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
      throw new Error(`refusing to use ${target}: it is or contains ${path}`);
    }
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readPid(path) {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** Chromium's SingletonLock is a symlink whose target ends in `-<pid>`. */
function readSingletonLockPid(path) {
  try {
    const pid = Number.parseInt(readlinkSync(path).split('-').pop() ?? '', 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/** The pid of a live Gezel instance (daemon or Electron) using `home`, if any. */
export function liveInstancePid(home, alive = isAlive) {
  const candidates = [
    readPid(join(home, 'runtime', 'lock')),
    readPid(join(home, 'runtime', 'pid')),
    readSingletonLockPid(join(home, '.electron-userdata', 'SingletonLock')),
  ];
  return candidates.find((pid) => pid !== null && pid !== process.pid && alive(pid)) ?? null;
}

/** Empty `home` (or create it) and mark it as ours. Refuses a foreign directory. */
export function resetHome(home) {
  if (existsSync(home)) {
    const entries = readdirSync(home);
    if (entries.length > 0 && !entries.includes(MARKER_FILE)) {
      throw new Error(
        `refusing to wipe ${home}: it was not created by pnpm app:new (no ${MARKER_FILE}). Remove it yourself or pick another --home.`,
      );
    }
    rmSync(home, { recursive: true, force: true });
  }
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, MARKER_FILE), 'Created by pnpm app:new; wiped on every run.\n');
}

function run(spawnChild) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawnChild();
    child.once('error', rejectRun);
    child.once('close', (code, signal) => resolveRun(signal ? 1 : (code ?? 1)));
  });
}

async function main() {
  const { home, keep } = parseAppNewArgs(process.argv.slice(2));
  assertWipeableLocation(home);

  const pid = liveInstancePid(home);
  if (pid !== null) {
    throw new Error(`Gezel is still running against ${home} (pid ${pid}). Quit it, then re-run.`);
  }

  if (keep) {
    mkdirSync(home, { recursive: true });
    console.log(`[app:new] reusing ${home}`);
  } else {
    resetHome(home);
    console.log(`[app:new] fresh home at ${home}`);
  }

  const env = { ...process.env, GEZEL_HOME: home };
  // Clears stale discovery files a --keep home may still hold, as `pnpm app` does.
  const fresh = spawnSync(process.execPath, [join(scriptsDir, 'dev-fresh-runtime.mjs')], {
    env,
    stdio: 'inherit',
  });
  if (fresh.status !== 0) return fresh.status ?? 1;

  const buildCode = await run(() =>
    spawnPnpm(['build'], { cwd: repoRoot, env: process.env, stdio: 'inherit' }),
  );
  if (buildCode !== 0) return buildCode;

  return run(() =>
    spawnPnpm(['--filter', '@bendyline/gezel-app', 'exec', 'electron', '.', '--no-sandbox'], {
      cwd: repoRoot,
      env,
      stdio: 'inherit',
    }),
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`[app:new] ${error?.message ?? error}`);
      process.exitCode = 1;
    },
  );
}
