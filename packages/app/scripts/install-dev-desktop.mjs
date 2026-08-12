#!/usr/bin/env node
/**
 * Install (or remove) a per-user `com.bendyline.gezel.dev.desktop` so
 * GNOME / KDE / any XDG-compliant Linux desktop renders a proper icon
 * and label for the dev Electron shell (`pnpm app`). Without it the
 * dock shows a generic placeholder because the window's app_id /
 * WM_CLASS (set in src/main.ts) has no matching `.desktop` file.
 *
 * Usage:
 *   node scripts/install-dev-desktop.mjs            # install
 *   node scripts/install-dev-desktop.mjs --remove   # uninstall
 *
 * What it does (install):
 *   1. Writes `~/.local/share/applications/com.bendyline.gezel.dev.desktop`. The
 *      file points `Exec=` at the repo's root `pnpm app` script and
 *      `Icon=` at the absolute path
 *      of `packages/app/assets/icon.png` so GNOME doesn't have to
 *      copy the icon into a theme dir.
 *   2. Sets `StartupWMClass=com.bendyline.gezel.dev` to match the app_id /
 *      WM_CLASS the running Electron window declares — this is the join
 *      key the dock uses to fuse the .desktop file with the actual window.
 *   3. Runs `update-desktop-database` if available, so the new entry
 *      is indexed immediately. Without that, GNOME may not pick up
 *      the file until a logout/login cycle.
 *
 * What it does (remove):
 *   1. Deletes the .desktop file if present.
 *   2. Refreshes the desktop database the same way.
 *
 * Packaged installs (.deb / .rpm) use the electron-builder-generated
 * `com.bendyline.gezel.desktop` instead — this script is a dev-only
 * convenience and deliberately uses a different basename
 * (`com.bendyline.gezel.dev`) so both can coexist on the same machine.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (platform() !== 'linux') {
  console.error('error: install-dev-desktop.mjs is Linux-only.');
  console.error(`       this host reports platform=${platform()}; nothing to do.`);
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const repoRoot = resolve(appDir, '..', '..');
const iconPath = join(appDir, 'assets', 'icon.png');

const xdgDataHome =
  process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.length > 0
    ? process.env.XDG_DATA_HOME
    : join(homedir(), '.local', 'share');
const applicationsDir = join(xdgDataHome, 'applications');
const desktopId = 'com.bendyline.gezel.dev';
const desktopFile = join(applicationsDir, `${desktopId}.desktop`);

const remove = process.argv.slice(2).some((a) => a === '--remove' || a === '-r');

if (remove) {
  if (existsSync(desktopFile)) {
    rmSync(desktopFile);
    console.log(`removed ${desktopFile}`);
  } else {
    console.log(`nothing to remove — ${desktopFile} does not exist.`);
  }
  refreshDatabase();
  process.exit(0);
}

if (!existsSync(iconPath)) {
  console.error(`error: icon not found at ${iconPath}`);
  console.error('       run `pnpm deps:install` from the repo root first.');
  process.exit(1);
}

// Exec= must be an absolute path to a binary; XDG forbids using a
// shell builtin or relying on PATH alone. Resolve `pnpm` once up front
// so the .desktop file works even from a launcher that strips PATH.
const pnpmBin = resolvePnpm();
if (!pnpmBin) {
  console.error('error: could not locate `pnpm` on PATH.');
  console.error('       install pnpm (or run `corepack enable pnpm`) before retrying.');
  process.exit(1);
}

mkdirSync(applicationsDir, { recursive: true });

// The %k field code expands to the .desktop file path on launch —
// not used here, kept implicit. `Exec=` must double-quote any path
// with spaces; we wrap pnpm + repoRoot defensively so a path like
// `/home/User Name/gh/gezel` doesn't blow up.
const exec = `${quote(pnpmBin)} --dir ${quote(repoRoot)} app`;

const contents = `[Desktop Entry]
Type=Application
Version=1.5
Name=Gezel (dev)
Comment=Gezel dev shell — runs from ${repoRoot}
GenericName=AI agents
Exec=${exec}
Icon=${iconPath}
Terminal=false
Categories=Office;
Keywords=ai;agents;gezel;copilot;
StartupNotify=true
StartupWMClass=${desktopId}
`;

writeFileSync(desktopFile, contents, { mode: 0o644 });
console.log(`installed ${desktopFile}`);
console.log(`  Exec=${exec}`);
console.log(`  Icon=${iconPath}`);
console.log(`  StartupWMClass=${desktopId}`);
refreshDatabase();
console.log('');
console.log('next: launch `pnpm app` from the repo root, or click "Gezel (dev)" in the app grid.');

// ── helpers ────────────────────────────────────────────────────────

function refreshDatabase() {
  // `update-desktop-database` indexes new .desktop files into the
  // shell's lookup tables. GNOME tolerates a missing run (it just
  // re-indexes on next login), but running it now means the dev
  // entry is usable immediately.
  const result = spawnSync('update-desktop-database', [applicationsDir], {
    stdio: 'inherit',
  });
  if (result.error || (result.status !== 0 && result.status !== null)) {
    console.log(
      '  (note: `update-desktop-database` failed or is not installed — the entry will be picked up after a logout/login or after the next time the shell rescans.)',
    );
  }
}

function resolvePnpm() {
  // `which pnpm` works in most shells but doesn't follow corepack's
  // shim layout on every distro. Prefer the env-injected
  // `npm_execpath`/`COREPACK_ENABLE_DOWNLOAD_PROMPT` set when this
  // script runs under pnpm itself, then fall back to PATH lookup.
  if (process.env.npm_execpath?.endsWith('pnpm')) return process.env.npm_execpath;
  const which = spawnSync('which', ['pnpm'], { encoding: 'utf8' });
  if (which.status === 0) {
    const out = which.stdout.trim();
    if (out) return out;
  }
  return null;
}

function quote(s) {
  // .desktop Exec key uses Bourne-shell-style quoting. Embedded
  // double-quotes / backslashes / dollar signs / backticks must each
  // be backslash-escaped per the XDG spec; spaces just need a wrapping
  // pair of double-quotes.
  const escaped = s.replace(/(["\\$`])/g, '\\$1');
  return /[\s"\\$`]/.test(s) ? `"${escaped}"` : s;
}
