import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { CopilotAvailability } from '@bendyline/gezel';
import { createLogger } from '@bendyline/gezel';
import { checkInstallTree } from '../system-toolsets/install-health.js';
import { SYSTEM_TOOLSETS } from '../system-toolsets/manifest.js';
import { resolveInstalledSystemLibrary } from '../system-toolsets/resolve.js';
import { resolveCopilotCliPath } from './copilot-cli.js';

const log = createLogger('copilot-availability');

export const COPILOT_TOOLSET_ID = '@github/copilot-sdk';

/**
 * Cheap enough (a few `existsSync` walks plus one small JSON read) that the
 * TTL exists only to absorb config-polling bursts from the Settings UI, not
 * because the probe is expensive. Short, so a manual install outside the app
 * is picked up quickly.
 */
const TTL_MS = 10_000;

let cached: { at: number; home: string; value: CopilotAvailability } | null = null;

/**
 * Drop the memoized answer. Call after anything that changes the install on
 * disk — a completed on-demand install, or a removal.
 */
export function resetCopilotAvailabilityCache(): void {
  cached = null;
}

function pinnedEntry() {
  return SYSTEM_TOOLSETS.find((e) => e.toolsetId === COPILOT_TOOLSET_ID);
}

function pinnedVersion(): string {
  return pinnedEntry()?.version ?? '0.0.0';
}

/**
 * Does the managed install actually load, or does it merely exist?
 *
 * `resolveInstalledSystemLibrary` answers "is the directory there" — which
 * is the right question for *presence*, but a tree can be present and still
 * unloadable. Two known ways to get there:
 *
 *   - Installs from builds before the hoisted-linker fix left NTFS junctions
 *     pointing at the vanished staging directory (see install-health.ts).
 *     The boot bootstrap heals eager toolsets from exactly this state, but
 *     the on-demand Copilot SDK never passes through that code.
 *   - A truncated or partially-removed tree whose entry file is gone.
 *
 * Without this probe those installs reported `managed: 'current'` while the
 * provider's real `import()` threw ERR_MODULE_NOT_FOUND — so Settings said
 * "Installed" and Test connection said "isn't installed", with no repair
 * affordance anywhere. Returns a human-readable reason, or null if healthy.
 */
async function detectManagedDamage(installRoot: string): Promise<string | null> {
  const tree = await checkInstallTree(installRoot);
  if (!tree.ok) {
    return `dependency "${tree.missingDep}" cannot be resolved — the install tree is broken`;
  }
  const entryRel = pinnedEntry()?.entry;
  if (entryRel && !existsSync(join(installRoot, entryRel))) {
    return `entry file "${entryRel}" is missing from the install`;
  }
  return null;
}

/**
 * Can this device use GitHub Copilot, and how did we get there?
 *
 * Walks the same ladder as {@link resolveCopilotCliPath} in the same order,
 * so what the UI advertises and what the provider actually launches can never
 * disagree:
 *
 *   1. `COPILOT_CLI_PATH` — an explicit operator override.
 *   2. Our managed `~/.gezel/system-toolsets/` install.
 *   3. A Copilot CLI the user installed themselves and put on PATH.
 *
 * Rung 3 is the reason this function exists. Someone who ran
 * `npm i -g @github/copilot` already has everything Copilot needs, and
 * offering them a second ~40 MB copy of GitHub's proprietary CLI would be
 * both wasteful and confusing. `available` can therefore be true while
 * `managed` is `'absent'` — those are different questions.
 *
 * `managed: 'outdated'` means an install exists at a version this build
 * doesn't pin. That is a working Copilot plus an update affordance, never
 * "not installed" — see {@link resolveInstalledSystemLibrary}.
 *
 * `managed: 'damaged'` means the install is on disk but won't load (see
 * {@link detectManagedDamage}). It is reported with a `damagedReason` so the
 * Settings card can offer a repair, and it never satisfies `available`.
 */
export async function resolveCopilotAvailability(
  home: string,
  /**
   * Host overrides. Production passes nothing; tests drive the PATH rung
   * without touching the real environment. Not part of the cache key —
   * callers that vary them must {@link resetCopilotAvailabilityCache}.
   */
  opts: { env?: NodeJS.ProcessEnv; platform?: string; arch?: string } = {},
): Promise<CopilotAvailability> {
  if (cached && cached.home === home && Date.now() - cached.at < TTL_MS) {
    return cached.value;
  }
  const value = await probe(home, opts);
  cached = { at: Date.now(), home, value };
  return value;
}

async function probe(
  home: string,
  opts: { env?: NodeJS.ProcessEnv; platform?: string; arch?: string },
): Promise<CopilotAvailability> {
  const env = opts.env ?? process.env;
  const pinned = pinnedVersion();
  const installed = await resolveInstalledSystemLibrary(home, COPILOT_TOOLSET_ID);
  const damagedReason = installed ? await detectManagedDamage(installed.path) : null;
  const managed: CopilotAvailability['managed'] = !installed
    ? 'absent'
    : damagedReason
      ? 'damaged'
      : installed.matchesPin
        ? 'current'
        : 'outdated';
  if (installed && damagedReason) {
    log.warn(
      `[copilot] managed install at ${installed.path} is damaged (${damagedReason}); it will not be offered until repaired from Settings`,
    );
  }

  const base = {
    managed,
    pinnedVersion: pinned,
    updateAvailable: managed === 'outdated',
    ...(installed ? { installedVersion: installed.version, installDir: installed.path } : {}),
    ...(damagedReason ? { damagedReason } : {}),
  };

  const override = env.COPILOT_CLI_PATH;
  if (override) {
    return { ...base, available: true, source: 'env', cliPath: override };
  }

  // A damaged managed install never answers "available" — the provider's
  // import() of it would throw. Fall through to the PATH rung: a CLI the
  // user installed themselves may still carry the day.
  if (installed && !damagedReason) {
    return { ...base, available: true, source: 'managed' };
  }

  // No usable managed install — ask whether the user brought their own. Pass
  // `installRoot: null` so this is strictly the PATH rung; the managed rung
  // was already decided above.
  const onPath = resolveCopilotCliPath({
    installRoot: null,
    env,
    ...(opts.platform ? { platform: opts.platform } : {}),
    ...(opts.arch ? { arch: opts.arch } : {}),
  });
  if (onPath) {
    return { ...base, available: true, source: 'path', cliPath: onPath.path };
  }

  return { ...base, available: false, source: null };
}
