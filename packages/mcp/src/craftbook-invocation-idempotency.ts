import { createHash } from 'node:crypto';

export interface RootTurnMessage {
  role: 'user' | 'assistant';
  at: string;
}

/**
 * Continuation prompts are not persisted as new user transcript messages, so
 * the latest persisted user-message index + timestamp is stable for the full
 * root turn and changes on the next real/injected send.
 */
export function rootTurnIdFromMessages(
  sessionId: string,
  messages: ReadonlyArray<RootTurnMessage>,
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'user') return `${sessionId}:${index}:${message.at}`;
  }
  return null;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function invocationSignature(invocation: Readonly<Record<string, unknown>>): string {
  return JSON.stringify(canonicalize(invocation));
}

/** Durable, opaque key passed to task creation for cross-process dedupe. */
export function rootTurnInvocationKey(
  rootTurnId: string,
  invocation: Readonly<Record<string, unknown>>,
): string {
  return `craftbook-root-v1:${createHash('sha256')
    .update(rootTurnId)
    .update('\n')
    .update(invocationSignature(invocation))
    .digest('hex')}`;
}

/**
 * Coalesces identical work within one root turn, including concurrent calls.
 * Rejections and non-cacheable results are evicted so a setup repair may be
 * retried. The bounded map prevents old transcript turn ids accumulating for
 * the lifetime of an MCP subprocess.
 */
export class RootTurnInvocationCache<T> {
  private readonly entries = new Map<string, Promise<T>>();

  constructor(private readonly maxEntries = 128) {}

  async run(args: {
    rootTurnId: string;
    invocation: Readonly<Record<string, unknown>>;
    execute: () => Promise<T>;
    cacheResult?: (value: T) => boolean;
  }): Promise<{ value: T; reused: boolean }> {
    const key = `${args.rootTurnId}\n${invocationSignature(args.invocation)}`;
    const existing = this.entries.get(key);
    if (existing) return { value: await existing, reused: true };

    const pending = args.execute();
    this.entries.set(key, pending);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }

    try {
      const value = await pending;
      if (args.cacheResult && !args.cacheResult(value)) this.entries.delete(key);
      return { value, reused: false };
    } catch (error) {
      this.entries.delete(key);
      throw error;
    }
  }
}
