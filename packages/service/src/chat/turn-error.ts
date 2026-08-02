import { type ChatTurnErrorDetail, redactCredentials } from '@bendyline/gezel';

/**
 * Classify a thrown error into the structured shape carried on the `error`
 * chat event and persisted alongside `ChatSession.lastTurnError`.
 *
 * Discrimination is duck-typed on a string `code` property rather than
 * `instanceof`, for three reasons: it avoids pulling whole provider modules
 * into the chat manager's error path just to reach a class, it survives an
 * error that crossed a serialization boundary, and Node's own errno-bearing
 * system errors classify for free.
 */

const MAX_DIAGNOSTIC_KEYS = 24;
const MAX_DIAGNOSTIC_VALUE = 120;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? redactCredentials(value) : undefined;
}

function classifyByName(name: unknown): string | undefined {
  return name === 'TurnAbortError' ? 'turn-aborted' : undefined;
}

/**
 * Copy only primitive values, bounded in both count and length. The source
 * (`NativeEngineLaunch.diagnostics`) is contractually free of prompts, tool
 * arguments, and secrets — the bounds are so a future producer cannot turn
 * this into a log tail by accident.
 */
function pickDiagnostics(value: unknown): ChatTurnErrorDetail['diagnostics'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, string | number | boolean> = {};
  let count = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (count >= MAX_DIAGNOSTIC_KEYS) break;
    if (typeof raw === 'number' || typeof raw === 'boolean') {
      out[key] = raw;
    } else if (typeof raw === 'string') {
      out[key] = redactCredentials(raw).slice(0, MAX_DIAGNOSTIC_VALUE);
    } else {
      continue;
    }
    count += 1;
  }
  return count > 0 ? out : undefined;
}

/**
 * Returns `undefined` — never `{}` — when nothing structured is knowable, so
 * the field stays absent rather than serializing an empty object into every
 * failed session record.
 */
export function describeTurnError(err: unknown): ChatTurnErrorDetail | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown>;

  // Node sets numeric codes on a few error kinds; only string codes are a
  // failure class.
  const code = str(e.code) ?? classifyByName(e.name);
  const engine = str(e.engine);
  const incidentId = str(e.incidentId);
  const panicKind = str(e.panicKind);
  const signal = typeof e.signal === 'string' ? e.signal.slice(0, 32) : undefined;
  const exitCode =
    typeof e.exitCode === 'number' || e.exitCode === null
      ? (e.exitCode as number | null)
      : undefined;
  const diagnostics = pickDiagnostics(e.diagnostics);

  const detail: ChatTurnErrorDetail = {
    ...(code ? { code } : {}),
    ...(engine ? { engine } : {}),
    ...(incidentId ? { incidentId } : {}),
    ...(panicKind ? { panicKind } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(signal ? { signal } : {}),
    ...(diagnostics ? { diagnostics } : {}),
  };
  return Object.keys(detail).length > 0 ? detail : undefined;
}
