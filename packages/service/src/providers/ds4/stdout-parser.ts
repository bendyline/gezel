/**
 * Classify a single line of ds4-server stderr into a lifecycle phase +
 * human-readable detail. The ds4 sibling of llama.cpp's
 * `classifyStartupLine` — same `StartupPhase` contract, but matching
 * antirez's log wording instead of llama-server's.
 *
 * ds4-server logs are unconditional (its log "levels" only pick a TTY
 * color), so everything below is present on every run of the pinned
 * build. The formats come from the upstream source at the commit in
 * native/engines/ds4/VERSION:
 *
 *   server_log() lines — `MMDD HH:MM:SS ds4-server: <msg>`:
 *     - `ds4-server: chat ctx=0..7880:7880 TOOLS prefill chunk 512/7880
 *        (6.5%) chunk=39.35 t/s avg=39.35 t/s 13.013s` — every prefill
 *        batch, i.e. every few seconds. DS4 prefill on a long prompt
 *        runs for MINUTES (~39 tok/s SSD-streamed), so this is the
 *        single biggest user-facing win — without it the chat sits on
 *        a bare "Thinking it through" the whole time.
 *     - same shape with phase `tool checkpoint rebuild` — mid-turn KV
 *        restore from the disk checkpoint before a continuation.
 *     - `ds4-server: chat ctx=… gen=150 TOOLS decoding chunk=5.20 t/s
 *        avg=5.35 t/s 28.846s` — every 50 decode tokens (~10-35s at
 *        DS4 speeds).
 *     - `ds4-server: listening on http://127.0.0.1:52341` — ready.
 *
 *   raw core prints (no timestamp) during model load:
 *     - `ds4: metal prepared model tensor mappings 12.50 GiB` —
 *        cumulative mapping ticker, every ~10s on a pipe.
 *     - `ds4: warming mapped tensor pages: 81.20 GiB` /
 *       `ds4: warmed tensor pages in 93.001s (checksum=…)` — the
 *        minutes-long full-residency page warm.
 *     - `ds4: prefill layer 12/61`, `ds4: gpu streaming prefill token
 *        512/7880` — `\r`-repaint progress meters from non-server code
 *        paths; matched for robustness (the supervisor splits on `\r`).
 *
 * Same tolerance contract as the llama.cpp classifier: unknown lines
 * return null and flow to the raw log file; a format drift upstream
 * degrades us to "no phase detail", never a crash.
 */
import type { StartupPhase } from '../llama-cpp/stdout-parser.js';
import { parseMemorySize, stripLogPrefix } from '../llama-cpp/stdout-parser.js';

/** Strip server_log's `MMDD HH:MM:SS ` timestamp when present. */
function stripTimestamp(line: string): string {
  return line.replace(/^\d{4} \d{2}:\d{2}:\d{2} /, '');
}

/**
 * Format a tokens/sec figure the way a human scans it: one decimal
 * below 10 (DS4 decode runs 1-5 tok/s where "1 tok/s" vs "1.4 tok/s"
 * is a 40% difference), whole numbers above.
 */
function formatTps(tps: number): string {
  return tps < 10 ? tps.toFixed(1) : String(Math.round(tps));
}

const NUM = (n: number): string => n.toLocaleString('en-US');

/**
 * Pure classifier for ds4-server output. Returns a phase descriptor
 * when the line matches a known pattern, null otherwise. Caller (the
 * shared `LlamaCppProvider.onStdoutLine`) dedupes repeated identical
 * phases and accumulates `bufferBytes`.
 */
export function classifyDs4Line(rawLine: string): StartupPhase | null {
  const line = stripTimestamp(stripLogPrefix(rawLine));
  if (!line) return null;

  // Server is up and listening — the readiness probe (`GET /v1/models`)
  // corroborates. Model load happens BEFORE this line in ds4-server's
  // main(), so `ready` here really means "load finished, serving".
  if (/^ds4-server: listening on /.test(line)) {
    return { phase: 'ready', detail: 'Server ready' };
  }

  // Prompt prefill / mid-turn KV rebuild progress. One line per prefill
  // batch:
  //   `ds4-server: chat ctx=0..7880:7880 TOOLS prefill chunk 512/7880
  //    (6.5%) chunk=39.35 t/s avg=39.35 t/s 13.013s`
  // The optional flag words between `ctx=…` and the phase are
  // uppercase tokens (RESPPROTO TOOLS THINKING …); the phase string is
  // exactly `prefill` or `tool checkpoint rebuild`, so anchor on those.
  const prefillMatch = line.match(
    /^ds4-server: (?:chat|completion) ctx=\S+.*?\b(prefill|tool checkpoint rebuild) chunk (\d+)\/(\d+) \(([\d.]+)%\).*?\bavg=([\d.]+) t\/s/,
  );
  if (prefillMatch) {
    const current = Number.parseInt(prefillMatch[2]!, 10);
    const total = Number.parseInt(prefillMatch[3]!, 10);
    const avgTps = Number.parseFloat(prefillMatch[5]!);
    if (total > 0 && current >= 0 && current <= total) {
      const progress = current / total;
      const pctText = Math.round(progress * 100);
      const rebuild = prefillMatch[1] === 'tool checkpoint rebuild';
      const tpsText = Number.isFinite(avgTps) && avgTps > 0 ? ` · ${formatTps(avgTps)} tok/s` : '';
      return {
        phase: 'prefill',
        detail: rebuild
          ? `Restoring session context (${pctText}% · ${NUM(current)} / ${NUM(total)} tokens)`
          : `Processing prompt (${pctText}% · ${NUM(current)} / ${NUM(total)} tokens${tpsText})`,
        progress,
      };
    }
  }

  // Decode progress — every 50 generated tokens. Valuable during long
  // hidden-reasoning stretches where no visible delta reaches the UI:
  //   `ds4-server: chat ctx=7880..8030:150 gen=150 TOOLS decoding
  //    chunk=5.20 t/s avg=5.35 t/s 28.846s`
  const decodeMatch = line.match(
    /^ds4-server: (?:chat|completion) ctx=\S+ gen=(\d+)\b.*?\bdecoding\b.*?\bavg=([\d.]+) t\/s/,
  );
  if (decodeMatch) {
    const gen = Number.parseInt(decodeMatch[1]!, 10);
    const avgTps = Number.parseFloat(decodeMatch[2]!);
    const tpsText = Number.isFinite(avgTps) && avgTps > 0 ? ` · ${formatTps(avgTps)} tok/s` : '';
    return {
      phase: 'generating',
      detail: `${NUM(gen)} tokens${tpsText}`,
    };
  }

  // Model tensor mapping ticker (cumulative, so no bufferBytes — the
  // provider would sum every tick into a wildly inflated RAM total):
  //   `ds4: metal prepared model tensor mappings 12.50 GiB`
  const mappedMatch = line.match(/^ds4: \S+ prepared model tensor mappings ([\d.]+) GiB/);
  if (mappedMatch) {
    return {
      phase: 'loading_model',
      detail: `Mapping model tensors (${mappedMatch[1]} GiB)`,
    };
  }

  // Full-residency page warm — a single announce line, so its size IS
  // safe to count once toward the engine RAM figure:
  //   `ds4: warming mapped tensor pages: 81.20 GiB`
  const warmingMatch = line.match(/^ds4: warming mapped tensor pages: ([\d.]+) GiB/);
  if (warmingMatch) {
    const bytes = parseMemorySize(warmingMatch[1]!, 'GiB');
    return {
      phase: 'loading_model',
      detail: `Warming model pages (${warmingMatch[1]} GiB)`,
      ...(bytes !== null ? { bufferBytes: bytes } : {}),
    };
  }
  const warmedMatch = line.match(/^ds4: warmed tensor pages in ([\d.]+)s/);
  if (warmedMatch) {
    return {
      phase: 'loading_model',
      detail: `Warmed model pages in ${Math.round(Number.parseFloat(warmedMatch[1]!))}s`,
    };
  }

  // Core `\r`-repaint prefill meters (non-server code paths; matched
  // defensively — the supervisor splits `\r` repaints into lines):
  //   `ds4: prefill layer 12/61`  /  `ds4: gpu prefill layer 12/61`
  //   `ds4: gpu streaming prefill token 512/7880`
  const coreTokenMatch = line.match(/^ds4: .*?\bprefill token (\d+)\/(\d+)/);
  if (coreTokenMatch) {
    const current = Number.parseInt(coreTokenMatch[1]!, 10);
    const total = Number.parseInt(coreTokenMatch[2]!, 10);
    if (total > 0 && current >= 0 && current <= total) {
      return {
        phase: 'prefill',
        detail: `Processing prompt (${Math.round((current / total) * 100)}% · ${NUM(current)} / ${NUM(total)} tokens)`,
        progress: current / total,
      };
    }
  }
  const coreLayerMatch = line.match(/^ds4: .*?\bprefill layer (\d+)\/(\d+)/);
  if (coreLayerMatch) {
    const current = Number.parseInt(coreLayerMatch[1]!, 10);
    const total = Number.parseInt(coreLayerMatch[2]!, 10);
    if (total > 0 && current >= 0 && current <= total) {
      return {
        phase: 'prefill',
        detail: `Prefill layer ${current} / ${total}`,
        progress: current / total,
      };
    }
  }

  return null;
}
