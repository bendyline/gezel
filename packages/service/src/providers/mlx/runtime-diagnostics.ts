/** Read a process's resident-set size (bytes) via `ps` for engine telemetry. */
export async function readProcessRssBytes(pid: number): Promise<number | null> {
  const { spawn } = await import('node:child_process');
  return await new Promise<number | null>((resolve) => {
    try {
      const proc = spawn('ps', ['-o', 'rss=', '-p', String(pid)], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let stdout = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      proc.on('error', () => resolve(null));
      proc.on('close', (code) => {
        if (code !== 0) return resolve(null);
        const kb = Number.parseInt(stdout.trim(), 10);
        if (!Number.isFinite(kb) || kb <= 0) return resolve(null);
        resolve(kb * 1024);
      });
    } catch {
      resolve(null);
    }
  });
}

/** Translate known mlx_vlm response shapes into user-actionable errors. */
export function translateMlxHttpError(status: number, statusText: string, body: string): string {
  if (/Repository Not Found for url/i.test(body) || /401 Client Error/i.test(body)) {
    return (
      "[Mac AI] The engine couldn't load this model. Try, in order:\n" +
      '  1. Settings → This Mac → Delete the local model, then download it again (in case the on-disk files are incomplete).\n' +
      '  2. Settings → This Mac → Advanced → Reset venv (in case mlx-vlm is too old for this architecture).\n' +
      '  3. Restart gezel and retry.'
    );
  }
  if (/Received \d+ parameters not in model/i.test(body)) {
    return (
      "[Mac AI] The on-device runtime doesn't recognize this model's architecture.\n" +
      'Settings → This Mac → Advanced → Reset venv, then retry. If it still fails, the catalog entry may need a newer mlx-vlm.'
    );
  }
  if (/out of memory|mps backend|allocation failed/i.test(body)) {
    return (
      '[Mac AI] Not enough unified memory to load this model.\n' +
      'Try the E2B variant, close other memory-heavy apps, or restart this Mac to release cached memory.'
    );
  }
  if (/FileNotFoundError|No such file or directory/i.test(body)) {
    const filename = body.match(/['"]?([^'"\s]+\.(?:json|safetensors|jinja|model))['"]?/)?.[1];
    return `[Mac AI] The local model is missing a file the engine needs${filename ? ` (\`${filename}\`)` : ''}.\nSettings → This Mac → Delete the local model, then download it again.`;
  }
  const detail = tryParseJsonDetail(body) ?? body.slice(0, 200);
  return `[Mac AI] engine returned ${status} ${statusText}: ${detail}`;
}

/** Detect an engine-side HTTP response stream closing mid-flight. */
export function isMidStreamConnectionDrop(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return false;
  const haystacks: string[] = [err.message];
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) haystacks.push(cause.message);
  const causeCode =
    cause && typeof cause === 'object' && 'code' in cause
      ? String((cause as { code: unknown }).code)
      : '';
  if (causeCode) haystacks.push(causeCode);
  const blob = haystacks.join(' ').toLowerCase();
  return (
    /\bterminated\b/.test(blob) ||
    blob.includes('other side closed') ||
    blob.includes('premature close') ||
    blob.includes('und_err_socket') ||
    blob.includes('econnreset')
  );
}

/** Format a tokens-per-second number for the in-chat status line. */
export function formatTps(rate: number): string {
  if (rate >= 10) return rate.toFixed(0);
  return rate.toFixed(1);
}

export function buildPreFirstByteAbortMessage(
  lastPrefill: { progress: number; detail: string; at: number } | null,
  busyElsewhere?: { detail: string; secondsAgo: number } | null,
): string {
  // Checked first, and only when THIS request saw no prefill of its own:
  // an engine that was demonstrably prefilling someone else's turn is
  // neither loading nor unhealthy, and saying so sends the reader to
  // Settings → On-device to restart a perfectly good engine. Wild-caught
  // on a restart that resumed four sessions at once — one turn waited
  // 10m36s behind a neighbour's 124s prefill and was told the model might
  // be sick.
  if (!lastPrefill && busyElsewhere) {
    const what = busyElsewhere.detail ? ` (${busyElsewhere.detail})` : '';
    return `[Mac AI] no first byte — the engine was busy with another session's turn${what} ${busyElsewhere.secondsAgo}s ago and never got to this one. It is not stuck or unhealthy: retry, and if several gezels are working at once expect them to take turns on one engine.`;
  }
  if (lastPrefill && lastPrefill.progress > 0) {
    const pct = Math.round(lastPrefill.progress * 100);
    const detail = lastPrefill.detail ? ` (${lastPrefill.detail})` : '';
    return `[Mac AI] aborting — prefill stalled at ${pct}%${detail}. The prompt may be too large for this model's effective speed. Try a shorter prompt, retry, or restart the engine in Settings → On-device.`;
  }
  if (lastPrefill?.detail) {
    return `[Mac AI] aborting — still prefilling ${lastPrefill.detail} when the budget ran out. The prompt is large for this model's prefill speed; retry (the cache is warm now) or pick a faster/smaller model.`;
  }
  return '[Mac AI] no first byte from the engine; aborting (model is loading slowly or mlx_vlm.server is unhealthy). Retry the turn; if it keeps happening, restart the engine in Settings → On-device.';
}

/** Build the user-facing message for an engine stream that died mid-turn. */
export function buildMidStreamDropMessage(
  charsReceived: number,
  plannedStop: boolean,
  engineStillRunning?: boolean,
): string {
  const got = charsReceived > 0 ? `after ${charsReceived} chars` : 'before any output';
  if (plannedStop) {
    return `[Mac AI] this turn stopped ${got} because Gezel unloaded the on-device engine while it was answering. Changing your settings restarts chat sessions so the new settings apply, and unloading a model in Settings → On-device or quitting the app does the same. The model didn't crash — send the message again to redo this turn.`;
  }
  if (engineStillRunning) {
    return `[Mac AI] the connection to the on-device engine dropped ${got}, but the engine is still running — so it did not crash or run out of memory. Something closed the HTTP request underneath the turn. Send the message again; if it keeps happening at roughly the same elapsed time each turn, that points at a timeout rather than the model, so capture the service log for that window.`;
  }
  return `[Mac AI] the on-device engine dropped the connection mid-turn (${got}). This usually means the mlx server crashed, ran out of memory, or was restarted while the turn was streaming — this turn's work was lost. Retry the turn; if it keeps happening, restart the engine in Settings → On-device.`;
}

/** Estimate request tokens from message bodies and serialized tool schemas. */
export function estimatePromptTokens(messages: unknown, tools: unknown): number {
  let chars = 0;
  try {
    chars += JSON.stringify(messages)?.length ?? 0;
  } catch {
    /* circular or unstringifiable */
  }
  if (tools) {
    try {
      chars += JSON.stringify(tools)?.length ?? 0;
    } catch {
      /* circular or unstringifiable */
    }
  }
  return Math.ceil(chars / 4);
}

export const PRE_FIRST_BYTE_BASE_MS = 300_000;
const PRE_FIRST_BYTE_BASELINE_TOKENS = 8_000;
const PRE_FIRST_BYTE_MS_PER_1K_TOKENS = 12_000;
const PRE_FIRST_BYTE_CAP_MS = 900_000;

/** Scale the pre-first-byte watchdog for slow, large-context MLX prefills. */
export function computePreFirstByteBudgetMs(approxPromptTokens: number): number {
  const over = Math.max(0, approxPromptTokens - PRE_FIRST_BYTE_BASELINE_TOKENS);
  const scaled = PRE_FIRST_BYTE_BASE_MS + (over / 1000) * PRE_FIRST_BYTE_MS_PER_1K_TOKENS;
  return Math.min(PRE_FIRST_BYTE_CAP_MS, Math.round(scaled));
}

function tryParseJsonDetail(body: string): string | null {
  try {
    const obj = JSON.parse(body) as unknown;
    if (obj && typeof obj === 'object' && 'detail' in obj && typeof obj.detail === 'string') {
      return obj.detail.slice(0, 200);
    }
  } catch {
    /* not JSON */
  }
  return null;
}
