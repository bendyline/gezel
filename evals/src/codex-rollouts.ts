import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';

/**
 * Codex CLI reports a turn's tokens only in `turn.completed`, so a turn that is
 * still running when the trial ends (the harness stops the daemon the moment the
 * task's checks pass) records nothing in Gezel's usage. On a task finished in one
 * Codex turn that is all of it: 59 of 108 outcome trials in the 2026-11-09 Sol run
 * showed zero tokens. Codex's own rollout logs a `token_count` after every model
 * call, so the trial keeps those files before its home is deleted.
 */
export async function keepCodexRollouts(trialHome: string, runDir: string): Promise<number> {
  const root = join(trialHome, 'runtime', 'codex-cli');
  let names: string[];
  try {
    names = await readdir(root, { recursive: true });
  } catch {
    return 0;
  }
  const rollouts = names.filter((n) => /^rollout-.*\.jsonl$/.test(basename(n)));
  if (rollouts.length === 0) return 0;
  const out = join(runDir, 'codex-rollouts');
  await mkdir(out, { recursive: true });
  for (const name of rollouts) {
    const from = join(root, name);
    // runtime/codex-cli/<projectId>/<sessionId>/sessions/<y>/<m>/<d>/rollout-*.jsonl
    const session = relative(root, dirname(from)).split(sep).slice(0, 2).join('--');
    await copyFile(from, join(out, `${session}--${basename(name)}`));
  }
  return rollouts.length;
}

export interface CodexTokens {
  calls: number;
  input: number;
  cachedInput: number;
  output: number;
}

/** Tokens over every model call in the kept rollouts, one `last_token_usage` per call. */
export async function codexRolloutTokens(runDir: string): Promise<CodexTokens | null> {
  const dir = join(runDir, 'codex-rollouts');
  let files: string[];
  try {
    files = (await readdir(dir)).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  const sum: CodexTokens = { calls: 0, input: 0, cachedInput: 0, output: 0 };
  for (const file of files) {
    let previousTotal = '';
    for (const line of (await readFile(join(dir, file), 'utf8')).split('\n')) {
      if (!line.includes('"token_count"')) continue;
      let event: {
        payload?: {
          type?: string;
          info?: {
            last_token_usage?: Partial<
              Record<'input_tokens' | 'cached_input_tokens' | 'output_tokens', number>
            >;
            total_token_usage?: unknown;
          } | null;
        };
      };
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const info = event.payload?.type === 'token_count' ? event.payload.info : null;
      if (!info?.last_token_usage) continue;
      // A repeated event carries the same running total; a new call always moves it.
      const total = JSON.stringify(info.total_token_usage ?? null);
      if (total === previousTotal) continue;
      previousTotal = total;
      sum.calls += 1;
      sum.input += info.last_token_usage.input_tokens ?? 0;
      sum.cachedInput += info.last_token_usage.cached_input_tokens ?? 0;
      sum.output += info.last_token_usage.output_tokens ?? 0;
    }
  }
  return sum;
}
