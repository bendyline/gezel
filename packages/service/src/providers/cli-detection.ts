import { statSync } from 'node:fs';
import { which as whichClaude } from './anthropic-cli/binary.js';
import { which as whichCodex } from './codex-cli/binary.js';

/**
 * Snapshot of CLI-binary availability as the config endpoint surfaces it.
 * `installed === false` means neither the override path nor a PATH lookup
 * resolved to a file; the optional `error` explains an invalid override.
 * This is presence, not execution health — the provider test endpoint owns
 * that distinction.
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

/**
 * Cheap provider presence for passive config/usage reads.
 *
 * This deliberately does not execute either CLI. `/api/config` is read by
 * nearly every UI surface and by every CLI command's authorization check; a
 * real health probe here used to turn an otherwise idle startup into
 * `claude --version` plus four `codex` version/help subprocesses. Presence is
 * enough to decide whether a provider belongs in a picker. The existing
 * provider test routes and first real provider use still perform the full,
 * actionable health/capability probe.
 */
export function getCliPresence(
  config: {
    anthropicCli?: { binaryPath?: string };
    codexCli?: { binaryPath?: string };
  },
  env: NodeJS.ProcessEnv = process.env,
): CliDetections {
  return {
    anthropicCli: presence(
      'Claude CLI',
      config.anthropicCli?.binaryPath,
      whichClaude('claude', env.PATH ?? '', env.PATHEXT),
    ),
    codexCli: presence(
      'Codex CLI',
      config.codexCli?.binaryPath,
      whichCodex('codex', env.PATH ?? '', env.PATHEXT),
    ),
  };
}

function presence(
  label: string,
  override: string | undefined,
  onPath: string | null,
): CliDetectionView {
  const path = override ?? onPath;
  if (!path) return { installed: false };
  try {
    if (!statSync(path).isFile()) {
      return { installed: false, error: `${label} path is not a file: ${path}` };
    }
    return { installed: true, path };
  } catch (err) {
    return {
      installed: false,
      error: `${label} path is unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
