/**
 * Runs the MLX sidecar's python suites so they actually gate.
 *
 * Until now nothing executed them: `cache_seed_test.py` says so in its own
 * docstring ("No pytest harness is wired for the MLX python sidecar"), and the
 * companion vitest files pin only the *wiring* by reading the source. That was
 * a reasonable call when every suite needed mlx installed — a CI runner has no
 * MLX venv, so executing them would have failed everywhere.
 *
 * The tool-call converter changed that: `tool_call_stream.py` and
 * `tool_args_json.py` are pure-stdlib, so their suites run on a bare python3.
 * The differential halves that DO need `mlx_vlm` raise `_ReferenceUnavailable`
 * and report themselves as skipped, so the same command is meaningful on a
 * laptop with the venv and on a runner without it.
 *
 * Deliberately does not fail when python3 is missing: this is a sidecar for an
 * Apple-silicon-only engine, and a Linux CI box without python should not turn
 * the whole service suite red. It logs instead, so a silent skip is visible.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const PYTHON_DIR = fileURLToPath(new URL('./python', import.meta.url));

/** Suites that must pass with nothing but the standard library. */
const STDLIB_SUITES = [
  'tool_call_stream_test.py',
  'tool_args_json_test.py',
  'tool_args_json_fuzz_test.py',
];

function python3(): string | null {
  for (const candidate of ['python3', '/usr/bin/python3']) {
    try {
      execFileSync(candidate, ['--version'], { stdio: 'pipe' });
      return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

describe('MLX sidecar python suites', () => {
  const py = python3();

  for (const suite of STDLIB_SUITES) {
    it(`passes: ${suite}`, () => {
      const path = `${PYTHON_DIR}/${suite}`;
      expect(existsSync(path), `${suite} is missing`).toBe(true);
      if (!py) {
        console.warn(`[mlx-python] no python3 on PATH — ${suite} not executed`);
        return;
      }
      let output = '';
      try {
        output = execFileSync(py, [path], {
          cwd: PYTHON_DIR,
          encoding: 'utf8',
          timeout: 120_000,
        });
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string };
        throw new Error(`${suite} failed:\n${e.stdout ?? ''}\n${e.stderr ?? ''}`.slice(0, 4_000));
      }
      // A suite that skipped EVERYTHING would pass vacuously; require that at
      // least one case actually ran, so a broken import cannot read as green.
      expect(output, `${suite} ran no cases`).toMatch(/PASS /);
    });
  }
});
