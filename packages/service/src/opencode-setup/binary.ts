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
  'OpenCode was not found on PATH. Install it from https://opencode.ai, then re-check this card.';

export async function detectOpenCodeBinary(opts: {
  override?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<OpenCodeBinaryDetection> {
  const env = opts.env ?? process.env;
  const candidate = opts.override ?? which('opencode', env.PATH ?? '', env.PATHEXT);
  if (!candidate) return { installed: false, error: NOT_FOUND };
  try {
    const version = await runVersionProbe(candidate);
    return { installed: true, path: candidate, version };
  } catch (error) {
    return {
      installed: false,
      path: candidate,
      error: `OpenCode at ${candidate} is not executable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
