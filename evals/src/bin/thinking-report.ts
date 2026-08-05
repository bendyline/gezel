/**
 * `pnpm --filter @bendyline/gezel-evals run thinking-report -- <runsDir...>`
 *
 * Thinking-cycle metrics for completed trials: how much a model reasons
 * relative to what it delivers, and how often the reasoning exhibits the
 * rumination pattern ("Wait...", "Hmm", "Actually, let me reconsider" —
 * 10+ cycles of self-doubt before acting). Wild-caught on qwen3.6-27b: a
 * klerk markdown+mermaid task spent most of its wall-clock in wait-loops.
 *
 * Sources, per trial dir:
 *   - `sessions/*.json` — persisted per-message `reasoning` (the visible
 *     floor: llama tool-loop iterations under-persist; MLX persists well).
 *   - `log.txt` perf line — engine-truth output tokens + decode rate, so
 *     the rumination tax shows up even where reasoning text was dropped.
 *
 * Output: one row per model×engine with totals, plus the worst offender
 * messages (trial, chars, hesitation count) for qualitative digging.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HESITATION =
  /\b[Ww]ait\b|\b[Hh]mm+\b|\b[Aa]ctually\b|[Ll]et me re(?:consider|think|check)|[Bb]ut wait|[Oo]n second thought|[Nn]o[,—-] (?:wait|that)/g;

interface Row {
  key: string;
  trials: number;
  passes: number;
  wallS: number;
  outTokens: number;
  asstMsgs: number;
  msgsWithReasoning: number;
  reasoningChars: number;
  visibleChars: number;
  hesitations: number;
  worst: Array<{ trial: string; chars: number; waits: number }>;
}

function* walkTrialDirs(root: string): Generator<string> {
  const st = statSync(root, { throwIfNoEntry: false });
  if (!st?.isDirectory()) return;
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    const s = statSync(p, { throwIfNoEntry: false });
    if (!s?.isDirectory()) continue;
    const hasResult = statSync(join(p, 'result.json'), { throwIfNoEntry: false })?.isFile();
    if (hasResult) yield p;
    else yield* walkTrialDirs(p);
  }
}

function trialEngineKey(trialDir: string): string {
  const name = trialDir.split('/').at(-1) ?? '';
  const engine = /-mlx-/.test(name) ? 'mlx' : /-ds4-/.test(name) ? 'ds4' : 'llama-cpp';
  // trial id shape: <scenario>-[engine-]<model>-<timestamp>-<rand>
  const m =
    /-(?:mlx-|ds4-)?((?:gemma|qwen|deepseek|laguna|ornith|talkie)[^/]*?)-\d{4}-\d{2}-\d{2}T/.exec(
      name,
    );
  return `${m?.[1] ?? 'unknown'} (${engine})`;
}

function main(roots: string[]): void {
  const rows = new Map<string, Row>();
  for (const root of roots) {
    // Key rows by root AND model×engine so A/B arms of the same model
    // stay separate columns instead of silently merging.
    const rootLabel = root.replace(/\/+$/, '').split('/').at(-1) ?? root;
    for (const trial of walkTrialDirs(root)) {
      const key = `${trialEngineKey(trial)} [${rootLabel}]`;
      let row = rows.get(key);
      if (!row) {
        row = {
          key,
          trials: 0,
          passes: 0,
          wallS: 0,
          outTokens: 0,
          asstMsgs: 0,
          msgsWithReasoning: 0,
          reasoningChars: 0,
          visibleChars: 0,
          hesitations: 0,
          worst: [],
        };
        rows.set(key, row);
      }
      row.trials += 1;
      try {
        const result = JSON.parse(readFileSync(join(trial, 'result.json'), 'utf8')) as {
          success?: boolean;
          durationMs?: number;
        };
        if (result.success) row.passes += 1;
        row.wallS += Math.round((result.durationMs ?? 0) / 1000);
      } catch {
        /* unreadable result — count the trial, skip its stats */
      }
      try {
        const log = readFileSync(join(trial, 'log.txt'), 'utf8');
        const perf = [...log.matchAll(/tokens from \S+ \([a-z-]+\): [\d,]+ in \/ ([\d,]+) out/g)].at(
          -1,
        );
        if (perf?.[1]) row.outTokens += Number(perf[1].replace(/,/g, ''));
      } catch {
        /* no log — fine */
      }
      const sessionsDir = join(trial, 'sessions');
      let sessionFiles: string[] = [];
      try {
        sessionFiles = readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));
      } catch {
        continue;
      }
      for (const f of sessionFiles) {
        let messages: Array<{ role?: string; reasoning?: string; content?: string }> = [];
        try {
          messages =
            (
              JSON.parse(readFileSync(join(sessionsDir, f), 'utf8')) as {
                messages?: typeof messages;
              }
            ).messages ?? [];
        } catch {
          continue;
        }
        for (const m of messages) {
          if (m.role !== 'assistant') continue;
          row.asstMsgs += 1;
          row.visibleChars += (m.content ?? '').length;
          const r = m.reasoning ?? '';
          if (!r) continue;
          row.msgsWithReasoning += 1;
          row.reasoningChars += r.length;
          const waits = r.match(HESITATION)?.length ?? 0;
          row.hesitations += waits;
          row.worst.push({ trial: trial.split('/').at(-1) ?? trial, chars: r.length, waits });
        }
      }
    }
  }

  for (const row of [...rows.values()].sort((a, b) => b.reasoningChars - a.reasoningChars)) {
    const hesPerK = row.reasoningChars > 0 ? (row.hesitations / row.reasoningChars) * 1000 : 0;
    const ratio = row.visibleChars > 0 ? row.reasoningChars / row.visibleChars : 0;
    console.log(`\n=== ${row.key}`);
    console.log(
      `  trials=${row.trials} passes=${row.passes} wall=${row.wallS}s outTokens=${row.outTokens.toLocaleString()}`,
    );
    console.log(
      `  asstMsgs=${row.asstMsgs} withReasoning=${row.msgsWithReasoning} reasoningChars=${row.reasoningChars.toLocaleString()} visibleChars=${row.visibleChars.toLocaleString()} (ratio ${ratio.toFixed(1)}x)`,
    );
    console.log(`  hesitations=${row.hesitations} (${hesPerK.toFixed(1)}/1K reasoning chars)`);
    const worst = row.worst.sort((a, b) => b.waits - a.waits).slice(0, 3);
    for (const w of worst) {
      console.log(`    worst: ${w.waits} waits in ${w.chars.toLocaleString()} chars — ${w.trial}`);
    }
  }
}

const roots = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (roots.length === 0) {
  console.error('usage: thinking-report <runsDir> [more...]');
  process.exit(2);
}
main(roots);
