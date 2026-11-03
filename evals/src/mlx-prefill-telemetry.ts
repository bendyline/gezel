import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

export interface MlxPrefillObservation {
  line: number;
  rx: string;
  sessionId: string;
  source: 'turn_stats' | 'first-token-detail';
  tokensPerSec: number;
  ttftMs?: number;
  cachedPromptTokens?: number;
}

/** Observed provider turns, NOT a token/duration-weighted aggregate of requests. */
export interface MlxPrefillTelemetry {
  source: MlxPrefillObservation['source'] | null;
  aggregation: 'median-observed-events';
  tokensPerSec: number | null;
  sampleCount: number;
  structuredSampleCount: number;
  firstTokenSampleCount: number;
  malformedLineCount: number;
  duplicateLineCount: number;
  observations: MlxPrefillObservation[];
}

const nonnegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function accumulator() {
  const observations: MlxPrefillObservation[] = [];
  const seen = new Set<string>();
  let malformedLineCount = 0;
  let duplicateLineCount = 0;
  return {
    add(line: string, lineNumber: number) {
      if (!line.trim()) return;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        malformedLineCount++;
        return;
      }
      if (!isRecord(record)) return;
      const event = record.event;
      if (
        !isRecord(event) ||
        event.provider !== 'mlx' ||
        typeof record.rx !== 'string' ||
        typeof record.sessionId !== 'string'
      )
        return;
      let source: MlxPrefillObservation['source'];
      let rate: unknown;
      if (event.type === 'turn_stats') {
        source = 'turn_stats';
        rate = event.promptTokensPerSec;
      } else if (event.type === 'engine_phase' && event.phase === 'generating') {
        // Historical recordings predate structured forwarding. Accept only the
        // provider's first-token diagnostic, never model text or progress prose.
        source = 'first-token-detail';
        const match =
          typeof event.detail === 'string'
            ? /^First token in [\d.]+s · prefill ([\d.]+) tok\/s$/.exec(event.detail)
            : null;
        rate = match ? Number(match[1]) : null;
      } else return;
      if (!nonnegative(rate) || rate === 0) return;
      // Only exact recorded duplicates are identifiable. Equal rates on separate
      // turns are real observations; a reconnect without event IDs cannot be deduped.
      const key = JSON.stringify([record.rx, record.sessionId, event]);
      if (seen.has(key)) {
        duplicateLineCount++;
        return;
      }
      seen.add(key);
      observations.push({
        line: lineNumber,
        rx: record.rx,
        sessionId: record.sessionId,
        source,
        tokensPerSec: rate,
        ...(nonnegative(event.ttftMs) ? { ttftMs: event.ttftMs } : {}),
        ...(nonnegative(event.cachedPromptTokens) && Number.isInteger(event.cachedPromptTokens)
          ? { cachedPromptTokens: event.cachedPromptTokens }
          : {}),
      });
    },
    finish(): MlxPrefillTelemetry {
      const structured = observations.filter((x) => x.source === 'turn_stats');
      const firstToken = observations.filter((x) => x.source === 'first-token-detail');
      // These describe different request boundaries. Never average both into
      // one estimate or substitute TTFT for pure prefill duration.
      const selected = structured.length ? structured : firstToken;
      const rates = selected.map((x) => x.tokensPerSec).sort((a, b) => a - b);
      const mid = Math.floor(rates.length / 2);
      return {
        source: selected[0]?.source ?? null,
        aggregation: 'median-observed-events',
        tokensPerSec: rates.length
          ? rates.length % 2
            ? rates[mid]!
            : (rates[mid - 1]! + rates[mid]!) / 2
          : null,
        sampleCount: rates.length,
        structuredSampleCount: structured.length,
        firstTokenSampleCount: firstToken.length,
        malformedLineCount,
        duplicateLineCount,
        observations,
      };
    },
  };
}

export function parseMlxPrefillTelemetry(jsonl: string): MlxPrefillTelemetry {
  const parser = accumulator();
  jsonl.split('\n').forEach((line, index) => parser.add(line, index + 1));
  return parser.finish();
}

/** Stream large eval recordings, retaining only the few relevant observations. */
export async function readMlxPrefillTelemetry(path: string): Promise<MlxPrefillTelemetry> {
  const parser = accumulator();
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  let lineNumber = 0;
  try {
    for await (const line of lines) parser.add(line, ++lineNumber);
    return parser.finish();
  } finally {
    lines.close();
    input.destroy();
  }
}
