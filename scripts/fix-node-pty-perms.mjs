#!/usr/bin/env node
/**
 * Restore the execute bit on node-pty's prebuilt `spawn-helper`
 * binaries. node-pty ships a per-platform helper executable
 * alongside the .node addon; pnpm's hard-linking into the virtual
 * store strips POSIX exec permissions (it preserves them only on
 * the "primary" file copy in some configurations), and node-pty's
 * own post-install hook only handles Windows. Without this fix,
 * `posix_spawnp failed` fires the first time `PersistentShell.start`
 * tries to fork bash. Idempotent: re-runs are a no-op when the bit
 * is already set, and any missing platform dirs are silently
 * skipped (we don't ship every platform's prebuild on every host).
 *
 * Hooked into the root `postinstall` script in `package.json` so it
 * runs after every `pnpm install` without requiring developers to
 * remember a separate command.
 */
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const pnpmRoot = join(repoRoot, 'node_modules', '.pnpm');

if (!existsSync(pnpmRoot)) {
  // Fresh repo with no node_modules yet — bootstrap will call pnpm
  // install which runs us again as `postinstall`. Nothing to do.
  process.exit(0);
}

let fixedCount = 0;
let scanCount = 0;

for (const entry of readdirSync(pnpmRoot)) {
  if (!entry.startsWith('node-pty@')) continue;
  const prebuildsDir = join(pnpmRoot, entry, 'node_modules', 'node-pty', 'prebuilds');
  if (!existsSync(prebuildsDir)) continue;
  for (const platformDir of readdirSync(prebuildsDir)) {
    const helperPath = join(prebuildsDir, platformDir, 'spawn-helper');
    if (!existsSync(helperPath)) continue;
    scanCount += 1;
    const st = statSync(helperPath);
    const wantedMode = st.mode | 0o111;
    if (st.mode === wantedMode) continue;
    chmodSync(helperPath, wantedMode);
    fixedCount += 1;
  }
}

if (fixedCount > 0) {
  console.log(
    `[fix-node-pty-perms] chmod +x applied to ${fixedCount}/${scanCount} spawn-helper binaries`,
  );
}
