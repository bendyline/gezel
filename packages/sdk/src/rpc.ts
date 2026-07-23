import { readFileSync, writeSync } from 'node:fs';
import { Socket } from 'node:net';

/**
 * Wire format for the fd-3 channel between ScriptRunner (parent) and a
 * sandboxed script (child). Newline-delimited JSON — one message per
 * line, JSON payload must not contain literal newlines (JSON.stringify
 * escapes them).
 *
 * The child's *init* message arrives on stdin (fd 0) instead of fd 3.
 * This lets the SDK resolve `gezel.input` synchronously at module load
 * time without threading async semantics through the rest of the
 * script.
 */

export interface InitMessage {
  input: unknown;
  runId: string;
  projectId: string;
  engagementMode: 'proactive' | 'scheduled' | 'reactive' | 'off';
  engagementFlags: {
    llmAllowed: boolean;
  };
}

interface RpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

interface RpcResponse {
  id: number;
  result?: unknown;
  error?: { message: string; code?: string };
}

interface RpcNotification {
  method: string;
  params?: unknown;
}

const DEFAULT_INIT: InitMessage = {
  input: undefined,
  runId: '',
  projectId: '',
  engagementMode: 'off',
  engagementFlags: { llmAllowed: false },
};

/**
 * Only read stdin synchronously when we're actually running inside a
 * ScriptRunner sandbox — signalled by the `GEZEL_SCRIPT_RUNTIME` env
 * var. Any other import context (tests, typechecks, REPL) gets a safe
 * default so the module never hangs on a TTY stdin.
 */
function readInitSync(): InitMessage {
  if (process.env.GEZEL_SCRIPT_RUNTIME !== '1') {
    return DEFAULT_INIT;
  }
  let raw = '';
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    return DEFAULT_INIT;
  }
  if (!raw) return DEFAULT_INIT;
  try {
    return JSON.parse(raw.trim()) as InitMessage;
  } catch {
    return DEFAULT_INIT;
  }
}

export class RpcClient {
  readonly init: InitMessage;

  private nextId = 0;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private buffer = '';
  private started = false;
  private _socket: Socket | null = null;

  constructor() {
    this.init = readInitSync();
  }

  /**
   * Lazy-create the read side. We use `net.Socket` for reads (it gives
   * us proper 'data' / 'end' events on POSIX socketpairs and Windows
   * named pipes) but **never** for writes — see `writeFrame` below.
   */
  private get socket(): Socket {
    if (!this._socket) {
      this._socket = new Socket({ fd: 3, readable: true, writable: true });
      this._socket.setEncoding('utf8');
      this._socket.unref();
    }
    return this._socket;
  }

  private updatePendingRef(): void {
    if (!this._socket) return;
    if (this.pending.size > 0) this._socket.ref();
    else this._socket.unref();
  }

  private ensureStarted(): void {
    if (this.started) return;
    this.started = true;
    this.socket.on('data', (chunk: string | Buffer) => {
      this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let newline = this.buffer.indexOf('\n');
      while (newline >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length > 0) {
          this.handleMessage(line);
        }
        newline = this.buffer.indexOf('\n');
      }
    });
    this.socket.on('error', (err) => {
      for (const pending of this.pending.values()) {
        pending.reject(err instanceof Error ? err : new Error(String(err)));
      }
      this.pending.clear();
    });
    this.socket.on('end', () => {
      const err = new Error('script RPC channel closed before all requests completed');
      for (const pending of this.pending.values()) {
        pending.reject(err);
      }
      this.pending.clear();
    });
    this.updatePendingRef();
  }

  private handleMessage(line: string): void {
    let parsed: RpcResponse;
    try {
      parsed = JSON.parse(line) as RpcResponse;
    } catch {
      return;
    }
    if (typeof parsed.id !== 'number') return;
    const pending = this.pending.get(parsed.id);
    if (!pending) return;
    this.pending.delete(parsed.id);
    this.updatePendingRef();
    if (parsed.error) {
      const err = new Error(parsed.error.message);
      (err as { code?: string }).code = parsed.error.code;
      pending.reject(err);
    } else {
      pending.resolve(parsed.result);
    }
  }

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    // Write the request first via fs.writeSync (synchronous, no userland
    // buffer) BEFORE creating the Socket on fd 3. On Windows, lazily
    // wrapping the inherited stdio fd in `net.Socket` and immediately
    // following with `fs.writeSync(3,...)` causes the parent's read of
    // that data to silently never fire — separating the writes from the
    // socket-init sidesteps it.
    const id = ++this.nextId;
    const req: RpcRequest = { id, method };
    if (params !== undefined) req.params = params;
    const payload = `${JSON.stringify(req)}\n`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        writeFrame(payload);
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      // Now that the bytes are on the wire, lazy-init the read side and
      // ref it so the loop stays alive until the parent's response
      // arrives.
      this.ensureStarted();
      this.updatePendingRef();
    });
  }

  notify(method: string, params?: unknown): void {
    const msg: RpcNotification = { method };
    if (params !== undefined) msg.params = params;
    // Write synchronously instead of going through the Socket. On
    // Windows, a Socket wrapping an inherited stdio fd buffers writes in
    // userland and only flushes them via libuv on the next loop tick.
    // When the script exits naturally after a fire-and-forget call (e.g.
    // `gezel.output(...); // done`), the unref'd socket lets the process
    // exit before that flush happens — the parent never sees the frame
    // and the run hangs at the runner's timeout. fs.writeSync blocks
    // until the OS pipe buffer accepts the bytes, so the data can't be
    // lost on exit. notify is fire-and-forget so we don't need the
    // socket's read side here at all.
    writeFrame(`${JSON.stringify(msg)}\n`);
  }
}

/**
 * Synchronous newline-framed write to fd 3. Bypasses the Socket-managed
 * write buffer so callers can rely on the data reaching the parent before
 * the next line of script runs. Throws on real I/O errors (e.g. fd 3
 * closed); callers convert those into rejected promises where applicable.
 */
function writeFrame(payload: string): void {
  // Encode once to bytes so writeSync can count them and re-issue if the
  // OS short-writes (rare on pipes but defined behavior).
  const buf = Buffer.from(payload, 'utf8');
  let offset = 0;
  while (offset < buf.length) {
    offset += writeSync(3, buf, offset, buf.length - offset);
  }
}
