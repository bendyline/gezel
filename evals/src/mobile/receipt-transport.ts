import { spawn } from 'node:child_process';

/** Bound an atomic test-receipt write and reap its transport before releasing an eval lease. */
export async function writeNativeReceipt(
  executable: string,
  argv: string[],
  encoded: string,
  options: { signal: AbortSignal; timeoutMs?: number },
): Promise<void> {
  options.signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, argv, { stdio: ['pipe', 'ignore', 'pipe'] });
    let failure: Error | undefined;
    let stderr = '';
    const stop = (reason: unknown) => {
      failure ??= reason instanceof Error ? reason : new Error(String(reason));
      // This is only the receipt transport, never the native instrumentation or app.
      child.kill('SIGKILL');
    };
    const abort = () => stop(options.signal.reason ?? new Error('Native receipt write aborted'));
    const timeout = setTimeout(
      () => stop(new Error('Native receipt write timed out')),
      options.timeoutMs ?? 10000,
    );
    options.signal.addEventListener('abort', abort, { once: true });
    child.stderr.on('data', (bytes: Buffer) => {
      stderr = (stderr + bytes.toString()).slice(-8192);
    });
    child.once('error', stop);
    child.stdin.once('error', stop);
    child.once('close', (code) => {
      clearTimeout(timeout);
      options.signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(stderr || `Native receipt write exited ${code}`));
      else resolve();
    });
    child.stdin.end(encoded);
    if (options.signal.aborted) abort();
  });
}
