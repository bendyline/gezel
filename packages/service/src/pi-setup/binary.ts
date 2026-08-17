import { runVersionProbe, which } from '../providers/codex-cli/binary.js';

/**
 * Non-throwing detection probe for the Settings card. Mirrors
 * `detectOpenCodeBinary`: the pi integration publishes files rather than
 * driving the CLI, so the only questions are "is it installed" and "what does
 * it call itself".
 */
export interface PiBinaryDetection {
  installed: boolean;
  path?: string;
  version?: string;
  error?: string;
}

const NOT_FOUND =
  'pi was not found on PATH. Install it from https://pi.dev, then re-check this card.';

export async function detectPiBinary(opts: {
  override?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<PiBinaryDetection> {
  const env = opts.env ?? process.env;
  const candidate = opts.override ?? which('pi', env.PATH ?? '', env.PATHEXT);
  if (!candidate) return { installed: false, error: NOT_FOUND };
  try {
    const version = await runVersionProbe(candidate);
    return { installed: true, path: candidate, version };
  } catch (error) {
    return {
      installed: false,
      path: candidate,
      error: `pi at ${candidate} is not executable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
