/**
 * Reusable Zod preprocessors for the structural args local models
 * (Qwen 3.6 27B at heavy quant in particular) routinely emit as
 * JSON-stringified strings instead of real objects/arrays.
 *
 * Symptom shape:
 *   ✗  `assignee: '{"kind":"gezel","gezelId":"leo"}'`
 *   ✓  `assignee: {kind:"gezel", gezelId:"leo"}`
 *
 * Without coercion, Zod's object/array validators reject the string
 * and the model gets a "expected object, received string" error it
 * can't easily diagnose — leading to the infinite-retry loop where
 * the model keeps re-emitting the same wrong shape and re-reading
 * the same error.
 *
 * The JSON coercers parse strings that *look like* the target shape
 * (start with `{` for object, `[` for array). Anything else passes
 * through unchanged for the inner schema to validate. `coerceStringArray`
 * additionally accepts shell-ish argv strings for execution tools where
 * local models often emit `args: "--flag value"` instead of
 * `args: ["--flag", "value"]`.
 *
 * Used in the MCP `server.ts` for tools whose args have non-trivial
 * structure (`ask_user_question.choices`, `create_task.assignee` /
 * `phases` / `template` / `fanout`, etc.). Cheap to wrap; no-op when
 * the model passes the right shape.
 */
import { z } from 'zod';

/**
 * Coerce a JSON-stringified object into an object before validation.
 * Strings that don't start with `{` (or fail to parse) pass through
 * untouched so the inner schema can produce its own error.
 */
export function coerceJsonObject<T extends z.ZodTypeAny>(inner: T) {
  return z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    const trimmed = v.trim();
    if (!trimmed.startsWith('{')) return v;
    try {
      return JSON.parse(trimmed);
    } catch {
      return v;
    }
  }, inner);
}

/**
 * Coerce a JSON-stringified array into an array before validation.
 * Strings that don't start with `[` (or fail to parse) pass through
 * untouched.
 */
export function coerceJsonArray<T extends z.ZodTypeAny>(inner: T) {
  return z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    const trimmed = v.trim();
    if (!trimmed.startsWith('[')) return v;
    try {
      return JSON.parse(trimmed);
    } catch {
      return v;
    }
  }, inner);
}

/**
 * Coerce a JSON-stringified array or shell-ish argv string into an array.
 * Used only for `args` fields whose semantics are already "list of argv
 * strings"; object-like strings intentionally pass through to fail.
 */
export function coerceStringArray<T extends z.ZodTypeAny>(inner: T) {
  return z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    const trimmed = v.trim();
    if (trimmed.length === 0) return [];
    if (trimmed.startsWith('[')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return v;
      }
    }
    if (trimmed.startsWith('{')) return v;
    return splitArgv(trimmed);
  }, inner);
}

function splitArgv(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const ch of input) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        out.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }

  if (escaping) current += '\\';
  if (current.length > 0) out.push(current);
  return out;
}
