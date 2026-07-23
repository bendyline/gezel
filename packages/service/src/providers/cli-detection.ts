import { detectClaudeBinary } from './anthropic-cli/binary.js';
import { detectCodexBinary } from './codex-cli/binary.js';

/**
 * Snapshot of CLI-binary availability as the config endpoint surfaces it.
 * `installed === false` means neither the override path nor a PATH lookup
 * resolved to an executable; the optional `error` is the underlying probe
 * failure (useful in Settings: "claude at /usr/local/bin/claude is not
 * executable: ENOENT" lands the user on the right diagnostic faster than
 * a bare "not installed").
 */
export interface CliDetectionView {
  installed: boolean;
  path?: string;
  version?: string;
  error?: string;
}

export interface CliDetections {
  anthropicCli: CliDetectionView;
  codexCli: CliDetectionView;
}

interface CacheEntry {
  /** The override path the cached probe was run with — invalidates on change. */
  override: string | undefined;
  result: CliDetectionView;
  expiresAt: number;
}

const TTL_MS = 60_000;

let claudeCache: CacheEntry | null = null;
let codexCache: CacheEntry | null = null;

/**
 * Probe both CLI binaries with a 60s in-memory TTL. The probe spawns
 * `<bin> --version` per provider on a cache miss, which is fast (~100ms)
 * but not free, so we don't want to do it on every config GET — the
 * Settings UI polls config across most user interactions. A 60s TTL is
 * the right tradeoff: a user who installs the CLI mid-session sees it
 * light up within a minute, and the steady-state cost is one `which`
 * walk per provider per minute.
 *
 * The cache key is the override path: a config edit that changes
 * `anthropicCli.binaryPath` invalidates the affected entry on the next
 * call without needing an explicit reset.
 */
export async function getCliDetections(config: {
  anthropicCli?: { binaryPath?: string };
  codexCli?: { binaryPath?: string };
}): Promise<CliDetections> {
  const now = Date.now();
  const anthropicOverride = config.anthropicCli?.binaryPath;
  const codexOverride = config.codexCli?.binaryPath;

  const [anthropicCli, codexCli] = await Promise.all([
    probeWithCache('claude', claudeCache, anthropicOverride, now, () =>
      detectClaudeBinary(anthropicOverride ? { override: anthropicOverride } : {}),
    ).then((entry) => {
      claudeCache = entry;
      return entry.result;
    }),
    probeWithCache('codex', codexCache, codexOverride, now, () =>
      detectCodexBinary(codexOverride ? { override: codexOverride } : {}),
    ).then((entry) => {
      codexCache = entry;
      return entry.result;
    }),
  ]);

  return { anthropicCli, codexCli };
}

async function probeWithCache(
  _label: string,
  cached: CacheEntry | null,
  override: string | undefined,
  now: number,
  probe: () => Promise<CliDetectionView>,
): Promise<CacheEntry> {
  if (cached && cached.override === override && cached.expiresAt > now) {
    return cached;
  }
  const result = await probe();
  return { override, result, expiresAt: now + TTL_MS };
}

/** Test-only escape hatch — clears the cache so repeat probes happen fresh. */
export function resetCliDetectionCache(): void {
  claudeCache = null;
  codexCache = null;
}
