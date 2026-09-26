import type { AppToolDefinition } from '@bendyline/gezel-app-sdk/browser';

/**
 * Plumbing shared by every document tool: budgets, argument readers, and
 * the one-at-a-time queue Office.js batches go through.
 */

/** Characters a tool result may carry; under the relay's 80k cap with room for JSON framing. */
export const RESULT_CHAR_BUDGET = 60_000;
/** Cells one spreadsheet read or write may touch. */
export const MAX_CELLS = 5_000;
/** Longest text one insert may carry. */
export const MAX_INSERT_CHARS = 50_000;

export const READ_TIMEOUT_MS = 20_000;
export const WRITE_TIMEOUT_MS = 60_000;

/** A document tool: an app tool plus what it needs from the host. */
export interface PaneTool extends AppToolDefinition {
  /** Changes the document. Withdrawn while edits are turned off. */
  write?: boolean;
  /** Office.js requirement set this tool needs at runtime. */
  requires?: { set: string; version: string };
}

export class ToolInputError extends Error {}

export function readString(
  args: Record<string, unknown>,
  name: string,
  opts: { required?: boolean; max?: number } = {},
): string | undefined {
  const value = args[name];
  if (value === undefined || value === null || value === '') {
    if (opts.required) throw new ToolInputError(`"${name}" is required.`);
    return undefined;
  }
  if (typeof value !== 'string') throw new ToolInputError(`"${name}" must be a string.`);
  if (opts.max !== undefined && value.length > opts.max) {
    throw new ToolInputError(
      `"${name}" is too long (${value.length} characters; at most ${opts.max}).`,
    );
  }
  return value;
}

export function readInt(
  args: Record<string, unknown>,
  name: string,
  opts: { min: number; max: number; fallback: number },
): number {
  const value = args[name];
  if (value === undefined || value === null) return opts.fallback;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n))
    throw new ToolInputError(`"${name}" must be a whole number.`);
  if (n < opts.min || n > opts.max) {
    throw new ToolInputError(`"${name}" must be between ${opts.min} and ${opts.max}.`);
  }
  return n;
}

export function readBool(args: Record<string, unknown>, name: string, fallback: boolean): boolean {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ToolInputError(`"${name}" must be true or false.`);
}

export function readEnum<T extends string>(
  args: Record<string, unknown>,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = args[name];
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value))
    return value as T;
  throw new ToolInputError(`"${name}" must be one of: ${allowed.join(', ')}.`);
}

/** Clip a string to `max` characters, saying so. */
export function clip(
  text: string,
  max: number = RESULT_CHAR_BUDGET,
): { text: string; truncated: boolean } {
  return text.length > max
    ? { text: text.slice(0, max), truncated: true }
    : { text, truncated: false };
}

export function toJson(value: unknown): string {
  return JSON.stringify(value);
}

let tail: Promise<unknown> = Promise.resolve();

/**
 * Run Office.js batches one at a time. Two tool calls arriving together
 * would otherwise interleave against the same selection.
 */
export function runSerial<T>(fn: () => Promise<T>): Promise<T> {
  const next = tail.then(fn, fn);
  tail = next.catch(() => undefined);
  return next;
}
