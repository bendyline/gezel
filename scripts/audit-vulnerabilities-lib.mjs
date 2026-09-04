const ENDPOINT = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
const TRANSIENT_STATUSES = new Set([408, 425, 429]);
const SEVERITY_ORDER = ['info', 'low', 'moderate', 'high', 'critical'];

/**
 * Query npm's advisory API with a small, bounded retry budget.
 *
 * The audit remains fail-closed: a persistent registry outage rejects after
 * the final attempt. Retries only cover timeouts, transport failures, rate
 * limits, and server errors; malformed responses and caller errors surface
 * immediately.
 */
export async function requestAdvisories(
  packages,
  {
    fetchImpl = fetch,
    maxAttempts = 3,
    timeoutMs = 30_000,
    baseDelayMs = 1_000,
    sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
    random = Math.random,
    warn = console.warn,
  } = {},
) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts must be a positive integer');
  }

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'gezel-production-audit/1',
        },
        body: JSON.stringify(packages),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        await response.body?.cancel();
        const error = new Error(`npm bulk advisory endpoint returned HTTP ${response.status}`);
        if (!isTransientStatus(response.status)) throw error;
        error.transient = true;
        throw error;
      }

      return await readAdvisories(response);
    } catch (error) {
      if (!isTransientError(error)) throw error;
      lastError = error;
    }

    if (attempt < maxAttempts) {
      const delayMs = retryDelayMs(baseDelayMs, attempt, random);
      warn(
        `npm advisory request attempt ${attempt}/${maxAttempts} failed (${describeError(lastError)}); retrying in ${delayMs} ms`,
      );
      await sleep(delayMs);
    }
  }

  throw new Error(
    `npm bulk advisory request failed after ${maxAttempts} attempts: ${describeError(lastError)}`,
    { cause: lastError },
  );
}

function isTransientStatus(status) {
  return TRANSIENT_STATUSES.has(status) || status >= 500;
}

function isTransientError(error) {
  if (!error || typeof error !== 'object') return false;
  return (
    error.transient === true ||
    error.name === 'TimeoutError' ||
    error.name === 'AbortError' ||
    error.name === 'TypeError'
  );
}

function retryDelayMs(baseDelayMs, attempt, random) {
  const exponential = baseDelayMs * 2 ** (attempt - 1);
  const jitter = 0.9 + random() * 0.2;
  return Math.max(0, Math.round(exponential * jitter));
}

function describeError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error ?? 'unknown error');
}

async function readAdvisories(response) {
  const maxBytes = 10 * 1024 * 1024;
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new Error('npm bulk advisory response exceeded 10 MiB');
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBytes) {
    throw new Error('npm bulk advisory response exceeded 10 MiB');
  }
  const body = JSON.parse(text);
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('npm bulk advisory endpoint returned an invalid response');
  }
  const unique = new Map();
  for (const [packageName, entries] of Object.entries(body)) {
    if (!Array.isArray(entries)) throw new Error('npm returned an invalid advisory group');
    for (const advisory of entries) {
      if (!advisory || typeof advisory !== 'object') {
        throw new Error('npm returned an invalid advisory');
      }
      const normalized = { ...advisory, name: advisory.name ?? packageName };
      const key = `${normalized.id ?? ''}\0${normalized.name}\0${normalized.url ?? ''}`;
      unique.set(key, normalized);
    }
  }
  return [...unique.values()].sort(
    (a, b) => severityOf(b) - severityOf(a) || String(a.name).localeCompare(String(b.name)),
  );
}

function severityOf(advisory) {
  const index = SEVERITY_ORDER.indexOf(String(advisory.severity ?? '').toLowerCase());
  return index < 0 ? Number.POSITIVE_INFINITY : index;
}
