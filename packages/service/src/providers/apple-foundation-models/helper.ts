import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  type AppleFoundationModelsHello,
  AppleFoundationModelsHelloSchema,
  type AppleFoundationModelsUsage,
  AppleFoundationModelsUsageSchema,
  type NativeTool,
  type NativeToolCall,
  type NativeToolReply,
  createAwakeTimeout,
  createLogger,
} from '@bendyline/gezel';

const log = createLogger('apple-fm');

const STDIN_CLOSE_GRACE_MS = 2_000;
const KILL_GRACE_MS = 2_000;

/** What the helper reports about Apple's on-device model on this Mac. */
export type AppleFmHello = AppleFoundationModelsHello;

export interface AppleFmGenerateRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  tools?: NativeTool[];
  maxTokens: number;
  contextSize: number;
}

export interface AppleFmGenerateHandlers {
  onDelta(text: string): void;
  onUsage?(usage: AppleFoundationModelsUsage): void;
  onToolCall(call: Omit<NativeToolCall, 'requestId'>): Promise<NativeToolReply>;
}

/** A coded failure from the helper (the codes are the shared Swift adapter's). */
export class AppleFmError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AppleFmError';
  }
}

type StopReason = 'stop' | 'length' | 'cancelled';

interface Pending {
  kind: 'generate' | 'count';
  resolve(value: StopReason | number): void;
  reject(error: Error): void;
  handlers?: AppleFmGenerateHandlers;
  cancelled?: boolean;
}

/**
 * The `gezel-apple-fm` child process, shared by every Apple on-device session.
 * Apple runs the model in its own system service, so the helper holds no model
 * memory and one process multiplexes all requests by id. Closing its stdin is
 * the whole shutdown protocol: the helper cancels what it is running and exits.
 */
export class AppleFmHelper {
  private child: ChildProcess | null = null;
  private hello: Promise<AppleFmHello> | null = null;
  private helloWaiter: {
    resolve(hello: AppleFmHello): void;
    reject(error: Error): void;
  } | null = null;
  private readonly pending = new Map<string, Pending>();
  private nextId = 0;
  private readonly spawn: typeof nodeSpawn;

  constructor(
    private readonly opts: {
      binaryPath: string;
      spawnImpl?: typeof nodeSpawn;
    },
  ) {
    this.spawn = opts.spawnImpl ?? nodeSpawn;
  }

  /** Coalesces concurrent probes, but never caches OS readiness across requests. */
  ready(): Promise<AppleFmHello> {
    this.ensureChild();
    if (this.hello) return this.hello;
    const budget = createAwakeTimeout(15_000);
    const onTimeout = () => {
      this.failAll(
        new AppleFmError('TIMEOUT', 'Apple on-device AI did not answer its readiness check.'),
      );
      void this.shutdown();
    };
    budget.signal.addEventListener('abort', onTimeout, { once: true });
    const pending = new Promise<AppleFmHello>((resolve, reject) => {
      this.helloWaiter = { resolve, reject };
      this.write({ type: 'hello' });
    });
    this.hello = pending;
    const cleanup = () => {
      budget.signal.removeEventListener('abort', onTimeout);
      budget.dispose();
      if (this.hello === pending) this.hello = null;
    };
    void pending.then(cleanup, cleanup);
    return pending;
  }

  /**
   * One generation. Tool calls made by Apple's own tool loop arrive through
   * `handlers.onToolCall`; its reply (or rejection) goes straight back to the
   * helper. Aborting `signal` cancels the generation; the result is then
   * `'cancelled'` with whatever text already streamed.
   */
  async generate(
    request: AppleFmGenerateRequest,
    handlers: AppleFmGenerateHandlers,
    signal?: AbortSignal,
  ): Promise<StopReason> {
    await this.ready();
    if (signal?.aborted) return 'cancelled';
    const id = `g${++this.nextId}`;
    let cancelBudget: ReturnType<typeof createAwakeTimeout> | undefined;
    const onAbort = () => {
      const pending = this.pending.get(id);
      if (pending) pending.cancelled = true;
      this.write({ type: 'cancel', id });
      // A stuck SDK must not hold the provider queue forever after cancellation.
      cancelBudget = createAwakeTimeout(5_000);
      cancelBudget.signal.addEventListener('abort', () => void this.shutdown(), { once: true });
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      return (await new Promise<StopReason | number>((resolve, reject) => {
        this.pending.set(id, { kind: 'generate', resolve, reject, handlers });
        this.write({ type: 'generate', id, ...request });
      })) as StopReason;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      cancelBudget?.dispose();
    }
  }

  /** Exact prompt tokens (tool definitions included); needs macOS 26.4. */
  async countTokens(
    messages: AppleFmGenerateRequest['messages'],
    tools: NativeTool[] = [],
  ): Promise<number> {
    await this.ready();
    const id = `c${++this.nextId}`;
    const budget = createAwakeTimeout(15_000);
    const onTimeout = () => {
      this.pending.get(id)?.reject(new AppleFmError('TIMEOUT', 'Apple token counting timed out.'));
      this.pending.delete(id);
    };
    budget.signal.addEventListener('abort', onTimeout, { once: true });
    try {
      return (await new Promise<StopReason | number>((resolve, reject) => {
        this.pending.set(id, { kind: 'count', resolve, reject });
        this.write({ type: 'count', id, messages, tools });
      })) as number;
    } finally {
      budget.signal.removeEventListener('abort', onTimeout);
      budget.dispose();
    }
  }

  async shutdown(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.failAll(new AppleFmError('SHUTDOWN', 'Apple on-device AI is shutting down.'));
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve());
      try {
        child.stdin?.end();
      } catch {
        /* already closed */
      }
      setTimeout(() => child.kill('SIGTERM'), STDIN_CLOSE_GRACE_MS).unref?.();
      setTimeout(() => child.kill('SIGKILL'), STDIN_CLOSE_GRACE_MS + KILL_GRACE_MS).unref?.();
    });
  }

  private ensureChild(): void {
    if (this.child) return;
    const child = this.spawn(this.opts.binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    this.hello = null;
    createInterface({ input: child.stdout! }).on('line', (line) => {
      if (this.child === child) this.onLine(line);
    });
    child.stderr?.on('data', (chunk: Buffer) => log.warn(`helper: ${String(chunk).trim()}`));
    child.stdin?.on('error', () => {
      /* surfaced through 'exit' */
    });
    child.on('error', (error) => this.onExit(child, `could not start (${error.message})`));
    child.on('exit', (code, signal) => this.onExit(child, `exited (${signal ?? code})`));
  }

  private onExit(child: ChildProcess, detail: string): void {
    if (this.child !== child) return;
    this.child = null;
    this.hello = null;
    log.warn(`gezel-apple-fm ${detail}`);
    this.failAll(new AppleFmError('HELPER_EXITED', `Apple on-device AI helper ${detail}.`));
  }

  private failAll(error: Error): void {
    this.hello = null;
    this.helloWaiter?.reject(error);
    this.helloWaiter = null;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) entry.reject(error);
  }

  private write(message: Record<string, unknown>): void {
    try {
      this.child?.stdin?.write(`${JSON.stringify(message)}\n`);
    } catch {
      /* the exit handler fails whatever was waiting */
    }
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = typeof message.id === 'string' ? message.id : '';
    switch (message.type) {
      case 'hello': {
        const parsed = AppleFoundationModelsHelloSchema.safeParse(message);
        if (parsed.success) this.helloWaiter?.resolve(parsed.data);
        else
          this.helloWaiter?.reject(
            new AppleFmError('PROTOCOL', 'Invalid Apple model readiness response.'),
          );
        this.helloWaiter = null;
        return;
      }
      case 'delta':
        if (!this.pending.get(id)?.cancelled)
          this.pending.get(id)?.handlers?.onDelta(String(message.text ?? ''));
        return;
      case 'usage': {
        const parsed = AppleFoundationModelsUsageSchema.safeParse(message);
        if (parsed.success) this.pending.get(id)?.handlers?.onUsage?.(parsed.data);
        return;
      }
      case 'tool_call': {
        const entry = this.pending.get(id);
        const callId = String(message.callId ?? '');
        if (!entry?.handlers || entry.cancelled) {
          this.write({ type: 'tool_result', id, callId, error: 'Request ended' });
          return;
        }
        Promise.resolve()
          .then(() => {
            if (this.pending.get(id) !== entry || entry.cancelled) throw new Error('Request ended');
            return entry.handlers!.onToolCall({
              callId,
              name: String(message.name ?? ''),
              arguments: String(message.arguments ?? '{}'),
            });
          })
          .then(
            (reply) => {
              if (this.pending.get(id) === entry)
                this.write({ type: 'tool_result', id, callId, ...reply });
            },
            (error: unknown) => {
              if (this.pending.get(id) !== entry) return;
              this.write({
                type: 'tool_result',
                id,
                callId,
                error: error instanceof Error ? error.message : String(error),
              });
            },
          );
        return;
      }
      case 'done': {
        const entry = this.pending.get(id);
        this.pending.delete(id);
        const reason = message.stopReason;
        entry?.resolve(reason === 'length' || reason === 'cancelled' ? reason : 'stop');
        return;
      }
      case 'count': {
        const entry = this.pending.get(id);
        this.pending.delete(id);
        if (
          typeof message.tokens === 'number' &&
          Number.isSafeInteger(message.tokens) &&
          message.tokens >= 0
        )
          entry?.resolve(message.tokens);
        else entry?.reject(new AppleFmError('PROTOCOL', 'Invalid Apple token count.'));
        return;
      }
      case 'error': {
        const entry = this.pending.get(id);
        this.pending.delete(id);
        entry?.reject(
          new AppleFmError(
            String(message.code ?? 'INFERENCE_FAILED'),
            String(message.message ?? ''),
          ),
        );
        return;
      }
    }
  }
}
