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

export function formatGb(bytes: number): string {
  return (bytes / 1e9).toFixed(2);
}
