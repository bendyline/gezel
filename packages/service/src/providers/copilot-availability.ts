import type { CopilotAvailability } from '@bendyline/gezel';
import { SYSTEM_TOOLSETS } from '../system-toolsets/manifest.js';
import { resolveInstalledSystemLibrary } from '../system-toolsets/resolve.js';
import { resolveCopilotCliPath } from './copilot-cli.js';

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

function pinnedVersion(): string {
  return SYSTEM_TOOLSETS.find((e) => e.toolsetId === COPILOT_TOOLSET_ID)?.version ?? '0.0.0';
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
  const managed: CopilotAvailability['managed'] = !installed
    ? 'absent'
    : installed.matchesPin
      ? 'current'
      : 'outdated';

  const base = {
    managed,
    pinnedVersion: pinned,
    updateAvailable: managed === 'outdated',
    ...(installed ? { installedVersion: installed.version, installDir: installed.path } : {}),
  };

  const override = env.COPILOT_CLI_PATH;
  if (override) {
    return { ...base, available: true, source: 'env', cliPath: override };
  }

  if (installed) {
    return { ...base, available: true, source: 'managed' };
  }

  // No managed install — ask whether the user brought their own. Pass
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
