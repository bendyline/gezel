import type { GezmodelEngine } from '@bendyline/gezel';
import type { LlamaCppInstallEvent, MlxInstallEvent } from '@bendyline/gezel-client';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { CliError } from './connection.js';

export type ModelPullClient = Pick<
  GezelClient,
  'installDs4Model' | 'installLlamaCppModel' | 'installMlxModel'
>;

/**
 * Download one catalog chat model into the connected daemon, on one progress
 * line rewritten in place. Shared by `model pull`, `model export`, and the
 * craftbook setup in `gezel do`. The daemon owns the download job, so an
 * interrupted command leaves it running; running the command again joins it.
 */
export async function pullChatModel(
  client: ModelPullClient,
  engine: GezmodelEngine,
  id: string,
  writeProgress: (text: string) => void,
): Promise<void> {
  let lastPct = -1;
  let pullError: string | undefined;
  // MLX repos are multi-file, so the SSE carries cumulative `*All` totals
  // while the GGUF engines report a single file. Render whichever arrives.
  const onEvent = (ev: MlxInstallEvent | LlamaCppInstallEvent): void => {
    if (ev.type === 'progress') {
      const written = 'bytesWrittenAll' in ev ? ev.bytesWrittenAll : ev.bytesWritten;
      const total = 'totalBytesAll' in ev ? ev.totalBytesAll : (ev.totalBytes ?? 0);
      const pct = total > 0 ? Math.floor((written / total) * 100) : 0;
      if (pct === lastPct) return;
      lastPct = pct;
      writeProgress(
        `\rdownloading ${id} (${engine}): ${String(pct).padStart(3)}%  ${formatGb(written)}/${formatGb(total)} GB`,
      );
    } else if (ev.type === 'retrying') {
      writeProgress(`\n  retry ${ev.attempt}/${ev.maxAttempts}: ${ev.reason}\n`);
    } else if (ev.type === 'error') {
      pullError = ev.error;
      writeProgress('\n');
    } else if (ev.type === 'done' && !pullError) {
      writeProgress(`\rdownloaded ${id} (${engine})${' '.repeat(48)}\n`);
    }
  };

  if (engine === 'mlx') await client.installMlxModel(id, onEvent);
  else if (engine === 'ds4') await client.installDs4Model(id, onEvent);
  else await client.installLlamaCppModel(id, onEvent);

  if (pullError) throw new CliError(`download failed: ${pullError}`);
}

/**
 * Wait for the MLX Python environment a download starts installing alongside
 * the weights. It needs torch, transformers and scipy, which take minutes on
 * a first install and outlast a small model's download, so the first `gezel
 * run` used to sit silent for about five minutes doing it (2026-10-13 npm
 * audit). A failure is reported, not thrown: the first chat retries it.
 */
export async function waitForMlxRuntime(
  client: Pick<GezelClient, 'getMlxRuntimeStatus'>,
  writeProgress: (text: string) => void,
  options: { pollMs?: number; now?: () => number } = {},
): Promise<'ready' | 'error' | 'idle'> {
  const pollMs = options.pollMs ?? 1_000;
  const now = options.now ?? Date.now;
  const started = now();
  let shown = false;
  for (;;) {
    const status = await client.getMlxRuntimeStatus();
    if (status.phase === 'provisioning') {
      const elapsed = Math.round((now() - started) / 1000);
      writeProgress(
        `\rpreparing the MLX Python runtime (one-time, a few minutes): ${Math.floor(elapsed / 60)}m ${String(elapsed % 60).padStart(2, '0')}s`,
      );
      shown = true;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    if (status.phase === 'error') {
      writeProgress(
        `${shown ? '\n' : ''}MLX runtime setup failed; the first chat will retry it: ${status.error ?? 'unknown error'}\n`,
      );
      return 'error';
    }
    if (shown) writeProgress(`\rMLX runtime ready${' '.repeat(56)}\n`);
    return status.phase === 'ready' ? 'ready' : 'idle';
  }
}

export function formatGb(bytes: number): string {
  return (bytes / 1e9).toFixed(2);
}
