import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexRolloutTokens, keepCodexRollouts } from './codex-rollouts.ts';

const call = (last: [number, number, number], total: [number, number, number]) =>
  JSON.stringify({
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        last_token_usage: {
          input_tokens: last[0],
          cached_input_tokens: last[1],
          output_tokens: last[2],
        },
        total_token_usage: {
          input_tokens: total[0],
          cached_input_tokens: total[1],
          output_tokens: total[2],
        },
      },
    },
  });

describe('codex rollouts', () => {
  let home: string;
  let runDir: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'gezel-codex-home-'));
    runDir = await mkdtemp(join(tmpdir(), 'gezel-codex-run-'));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(runDir, { recursive: true, force: true });
  });

  it('keeps nothing when the trial never ran Codex', async () => {
    expect(await keepCodexRollouts(home, runDir)).toBe(0);
    expect(await codexRolloutTokens(runDir)).toBeNull();
  });

  it('keeps every session rollout and counts each model call once', async () => {
    const a = join(home, 'runtime/codex-cli/proj/sess-a/sessions/2026/11/10');
    const b = join(home, 'runtime/codex-cli/proj/sess-b/sessions/2026/11/10');
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await writeFile(
      join(a, 'rollout-1.jsonl'),
      [
        call([100, 50, 10], [100, 50, 10]),
        JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }),
        call([200, 150, 20], [300, 200, 30]),
        call([200, 150, 20], [300, 200, 30]),
        '{"type":"response_item"}',
        'not json',
      ].join('\n'),
    );
    // A resumed exec restarts its running total; each call still counts.
    await writeFile(join(b, 'rollout-2.jsonl'), call([40, 0, 4], [40, 0, 4]));
    await writeFile(join(home, 'runtime/codex-cli/proj/sess-a/config.toml'), '');

    expect(await keepCodexRollouts(home, runDir)).toBe(2);
    expect((await readdir(join(runDir, 'codex-rollouts'))).sort()).toEqual([
      'proj--sess-a--rollout-1.jsonl',
      'proj--sess-b--rollout-2.jsonl',
    ]);
    expect(await codexRolloutTokens(runDir)).toEqual({
      calls: 3,
      input: 340,
      cachedInput: 200,
      output: 34,
    });
  });
});
