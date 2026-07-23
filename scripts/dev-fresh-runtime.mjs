#!/usr/bin/env node
/**
 * Pre-launch hook for `pnpm app` (dev mode): clear any stale daemon
 * discovery state under `~/.gezel-dev/runtime/` so the supervisor
 * always starts from a clean slate after a rebuild.
 *
 * Why: `pnpm app` rebuilds the workspace before launching Electron, but
 * if a previous run left a gezeld daemon alive (or its runtime files
 * lingering), the supervisor's local-adopt branch picks it up and the
 * fresh UI ends up talking to old service code. The supervisor itself
 * has a dev-mode mtime check that catches this case at adopt time, but
 * clearing the runtime dir up-front makes the failure mode impossible
 * — the supervisor can't adopt what isn't there.
 *
 * Best-effort: SIGTERM any pid in `runtime/pid` before removing the
 * directory, so we don't leak orphan daemons that would race the next
 * boot for the same `~/.gezel-dev` state. Failures here are silent —
 * worst case the supervisor's mtime check catches the stale daemon a
 * moment later.
 *
 * Honors `GEZEL_HOME` if set (advanced users running `pnpm app` against
 * a non-default home directory). Otherwise targets the dev default.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = process.env.GEZEL_HOME ?? join(homedir(), '.gezel-dev');
const runtimeDir = join(home, 'runtime');
const pidFile = join(runtimeDir, 'pid');

if (existsSync(pidFile)) {
  try {
    const raw = readFileSync(pidFile, 'utf8').trim();
    const pid = Number.parseInt(raw, 10);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`[pnpm app] terminated stale dev daemon pid=${pid}`);
      } catch {
        /* already dead — fine */
      }
    }
  } catch {
    /* unreadable pid file — fall through to rmSync */
  }
}

if (existsSync(runtimeDir)) {
  rmSync(runtimeDir, { recursive: true, force: true });
}
