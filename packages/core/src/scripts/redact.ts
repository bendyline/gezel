/**
 * Scrub known secret values from anything a run leaves behind.
 *
 * A script that resolves a credential (`http.authed`) hands the runtime the
 * secret's value, and every later log line, error and call summary may
 * carry it. The runtime redacts before persisting and before returning, so
 * the audit on disk and the record a model reads never hold the bytes.
 * Only known values are matched: the caller never adds arbitrary strings.
 */
import type { ScriptRun, ScriptRunCall } from '../schemas/script.js';

/** Replace any known secret value in `input` with `[REDACTED]`. */
export function redactString(input: string, secrets: ReadonlySet<string>): string {
  if (!input || secrets.size === 0) return input;
  let out = input;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    out = out.split(secret).join('[REDACTED]');
  }
  return out;
}

/** Recursively redact string values inside a plain object or array. */
export function redactObject<T>(value: T, secrets: ReadonlySet<string>): T {
  if (secrets.size === 0) return value;
  if (typeof value === 'string') return redactString(value, secrets) as T;
  if (Array.isArray(value)) return value.map((item) => redactObject(item, secrets)) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>))
      out[key] = redactObject(item, secrets);
    return out as T;
  }
  return value;
}

/** Redact a run record in place: its log, error, output and every call summary. */
export function redactScriptRun(run: ScriptRun, secrets: ReadonlySet<string>): void {
  if (secrets.size === 0) return;
  run.logs = redactString(run.logs, secrets);
  if (run.error) run.error = redactString(run.error, secrets);
  if (run.output !== undefined) run.output = redactObject(run.output, secrets);
  run.calls = run.calls.map((call) => {
    const out: ScriptRunCall = { ...call, argsSummary: redactString(call.argsSummary, secrets) };
    if (call.outputSummary !== undefined)
      out.outputSummary = redactString(call.outputSummary, secrets);
    if (call.error !== undefined) out.error = redactString(call.error, secrets);
    return out;
  });
}
