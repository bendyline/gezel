import type {
  NativeEngineName,
  NativeEngineResolveEvent,
  NativeEngineStatusResponse,
} from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { CliError } from './connection.js';
import { NATIVE_TOOLKIT } from './tui/bootstrap.js';

export const NATIVE_VARIANTS = ['cuda', 'vulkan', 'metal', 'cpu'] as const;
export type NativeVariant = (typeof NATIVE_VARIANTS)[number];

export type NativeCommandClient = Pick<GezelClient, 'ensureNativeEngine' | 'getNativeEngineStatus'>;

export interface NativeInstallOutput {
  /** Progress and verification details; callers may preserve carriage returns. */
  writeProgress(text: string): void;
}

export function parseNativeVariant(value: string | undefined): NativeVariant | undefined {
  if (value === undefined) return undefined;
  if ((NATIVE_VARIANTS as readonly string[]).includes(value)) return value as NativeVariant;
  throw new CliError(`--variant must be one of ${NATIVE_VARIANTS.join(', ')} (got "${value}")`);
}

/** A concise diagnostic summary for `gezel native status`. */
export function formatNativeStatus(status: NativeEngineStatusResponse): string {
  const installed = new Set(
    status.engines.filter((engine) => engine.installed).map((engine) => engine.name),
  );
  const toolkitInstalled = NATIVE_TOOLKIT.filter((engine) => installed.has(engine)).length;
  return [
    `release: native-v${status.release} (${status.pinned ? 'verified pin' : 'unpinned — downloads disabled'})`,
    `platform: ${status.platformKey ?? 'unsupported — downloads unavailable'}`,
    `llama backend: ${status.llamaBackend ?? 'automatic'}`,
    `toolkit: ${toolkitInstalled}/${NATIVE_TOOLKIT.length} installed`,
  ].join('\n');
}

/** Per-executable availability for `gezel native list`. */
export function formatNativeList(status: NativeEngineStatusResponse): string {
  const rows = status.engines.map((engine) => {
    const state = engine.installed ? 'installed' : 'missing';
    return `${engine.name.padEnd(18)}  ${state.padEnd(10)}${engine.path ? `  ${engine.path}` : ''}`;
  });
  return [
    `native-v${status.release} · ${status.platformKey ?? 'unsupported platform'} · ${status.pinned ? 'verified' : 'unpinned'}`,
    'engine              status      path',
    ...rows,
  ].join('\n');
}

/**
 * Ensure the complete first-run toolkit in its deliberate archive order.
 * Only llama-server has backend variants; the shared toolkit archive must
 * never receive a CUDA/Metal/Vulkan suffix.
 */
export async function installNativeToolkit(
  client: NativeCommandClient,
  options: {
    variant?: NativeVariant;
    output: NativeInstallOutput;
  },
): Promise<NativeEngineStatusResponse> {
  const status = await client.getNativeEngineStatus();
  if (!status.pinned) {
    throw new CliError(
      'native downloads are disabled because the connected service has no verified native release pin.',
    );
  }
  if (!status.platformKey) {
    throw new CliError(
      `native downloads are unavailable on ${process.platform}/${process.arch}: no supported build exists.`,
    );
  }

  const llamaVariant = options.variant ?? status.llamaBackend;
  for (const engine of NATIVE_TOOLKIT) {
    await ensureOneEngine(client, engine, llamaVariant, options.output);
  }
  return client.getNativeEngineStatus();
}

async function ensureOneEngine(
  client: NativeCommandClient,
  engine: NativeEngineName,
  llamaVariant: NativeVariant | undefined,
  output: NativeInstallOutput,
): Promise<void> {
  let terminalError: string | undefined;
  let progressLineOpen = false;
  const onEvent = (event: NativeEngineResolveEvent): void => {
    if (event.type === 'progress') {
      progressLineOpen = true;
      output.writeProgress(`\r${formatProgress(engine, event.bytesWritten, event.totalBytes)}`);
      return;
    }
    if (progressLineOpen) {
      output.writeProgress('\n');
      progressLineOpen = false;
    }
    switch (event.type) {
      case 'retrying':
        output.writeProgress(
          `${engine}: retry ${event.attempt}/${event.maxAttempts} in ${event.delayMs}ms — ${event.reason}\n`,
        );
        break;
      case 'verifying':
        output.writeProgress(`${engine}: verifying ${event.what}\n`);
        break;
      case 'done':
        output.writeProgress(
          `${engine}: ready${event.cached ? ' (cached)' : ` — ${event.binPath}`}\n`,
        );
        break;
      case 'error':
        terminalError = event.error;
        output.writeProgress(`${engine}: error — ${event.error}\n`);
        break;
    }
  };

  try {
    await client.ensureNativeEngine(
      engine,
      onEvent,
      engine === 'llama-server' ? llamaVariant : undefined,
    );
  } catch (error) {
    if (progressLineOpen) output.writeProgress('\n');
    throw new CliError(
      `native install failed for ${engine}: ${terminalError ?? errorMessage(error)}`,
    );
  }
  if (progressLineOpen) output.writeProgress('\n');
  if (terminalError) {
    throw new CliError(`native install failed for ${engine}: ${terminalError}`);
  }
}

function formatProgress(engine: NativeEngineName, written: number, total: number): string {
  if (total <= 0) return `${engine}: ${formatBytes(written)} downloaded`;
  const pct = Math.min(100, Math.floor((written / total) * 100));
  return `${engine}: ${String(pct).padStart(3)}%  ${formatBytes(written)}/${formatBytes(total)}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
