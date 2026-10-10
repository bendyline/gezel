import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { awakeNow } from '../suspend-clock.js';
import type { SpeechModelEntry, SpeechModelFile } from './catalog.js';
import { verifiedDownload, verifyFile } from './verified-download.js';

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

/** Never follow a link within a store, including a linked store root. */
async function safeDirectory(directory: string, create: boolean): Promise<boolean> {
  const absolute = resolve(directory);
  const parent = dirname(absolute);
  if (parent !== absolute && !(await safeDirectory(parent, create))) return false;
  try {
    const info = await lstat(absolute);
    if (
      process.platform === 'darwin' &&
      ['/var', '/tmp'].includes(absolute) &&
      (await realpath(absolute)) === `/private${absolute}`
    )
      return true;
    // System aliases (/var, /tmp on macOS) are resolved by callers before stores are configured.
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`Unsafe speech model directory: ${absolute}`);
  } catch (error) {
    if (code(error) !== 'ENOENT') throw error;
    if (!create) return false;
    await mkdir(absolute).catch((failure: unknown) => {
      if (code(failure) !== 'EEXIST') throw failure;
    });
    const info = await lstat(absolute);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`Unsafe speech model directory: ${absolute}`);
  }
  return true;
}

export interface SpeechAssetOptions {
  /** Shared between apps for the same user; null keeps all files private. */
  root: string | null;
  /** Legacy Gezel model roots, machine assets, and packaged voice directories. */
  candidates?: (model: SpeechModelEntry, file: SpeechModelFile) => readonly string[];
  fetchImpl?: typeof fetch;
}

/**
 * Verified, content-addressed speech files. Each installation owns hard links,
 * so removing one installation never unlinks another's files. On a different
 * volume we copy verified bytes (still no second download). Writers and GC
 * share a cross-process lock. A live download is never evicted by its age.
 */
export class SpeechAssetStore {
  private readonly verifiedFiles = new Map<string, string>();
  constructor(private readonly options: SpeechAssetOptions) {}

  private blob(file: Pick<SpeechModelFile, 'sha256'>): string | null {
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error('Invalid speech asset pin.');
    }
    return this.options.root ? join(this.options.root, file.sha256) : null;
  }

  private async verified(candidate: string, file: SpeechModelFile): Promise<boolean> {
    if (!(await safeDirectory(dirname(candidate), false))) return false;
    const info = await lstat(candidate).catch((error: unknown) => {
      if (code(error) === 'ENOENT') return null;
      throw error;
    });
    if (!info?.isFile() || info.size !== file.size) return false;
    const identity = `${file.sha256}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (this.verifiedFiles.get(candidate) === identity) return true;
    const valid = await verifyFile(candidate, file.sha256, file.size);
    if (valid) this.verifiedFiles.set(candidate, identity);
    return valid;
  }

  async find(model: SpeechModelEntry, file: SpeechModelFile): Promise<string | null> {
    if (!Number.isSafeInteger(file.size) || file.size < 1)
      throw new Error('Invalid speech asset size.');
    const blob = this.blob(file);
    const candidates = [...(blob ? [blob] : []), ...(this.options.candidates?.(model, file) ?? [])];
    for (const candidate of candidates) {
      if (await this.verified(candidate, file)) return candidate;
    }
    return null;
  }

  async materialize(
    model: SpeechModelEntry,
    file: SpeechModelFile,
    destination: string,
    options: {
      download: boolean;
      signal?: AbortSignal;
      onProgress?: (received: number, total: number) => void;
    },
  ): Promise<boolean> {
    const blob = this.blob(file);
    const run = async () => {
      options.signal?.throwIfAborted();
      const local = await this.verified(destination, file);
      let source = await this.find(model, file);
      if (!source && local) source = destination;
      if (!source && !options.download) return false;
      await safeDirectory(dirname(destination), true);
      if (blob) {
        if (source !== blob) {
          if (source) await this.publish(source, blob);
          else
            await verifiedDownload({
              ...file,
              destination: blob,
              ...options,
              fetchImpl: this.options.fetchImpl,
            });
        }
        await this.publish(blob, destination);
      } else if (!local) {
        if (source) await this.publish(source, destination);
        else
          await verifiedDownload({
            ...file,
            destination,
            ...options,
            fetchImpl: this.options.fetchImpl,
          });
      }
      options.onProgress?.(file.size, file.size);
      return true;
    };
    return blob ? this.lock(file, run, options.signal) : run();
  }

  /** Atomic replacement only; never truncate bytes that may have other links. */
  private async publish(source: string, destination: string): Promise<void> {
    if (source === destination) return;
    const [a, b] = await Promise.all([
      stat(source),
      lstat(destination).catch((error: unknown) => {
        if (code(error) === 'ENOENT') return null;
        throw error;
      }),
    ]);
    if (b?.isSymbolicLink()) throw new Error('Refusing a linked speech model file.');
    if (b && a.dev === b.dev && a.ino === b.ino) return;
    await safeDirectory(dirname(destination), true);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await link(source, temporary).catch(async (error: unknown) => {
        if (!['EXDEV', 'EPERM', 'ENOTSUP', 'EACCES'].includes(code(error) ?? '')) throw error;
        await copyFile(source, temporary, constants.COPYFILE_EXCL);
      });
      await rename(temporary, destination);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  /** Call after unlinking this app's files. Only unreferenced cache entries are removed. */
  async collect(file: Pick<SpeechModelFile, 'sha256'>): Promise<void> {
    const blob = this.blob(file);
    if (!blob || !(await safeDirectory(dirname(blob), false))) return;
    await this.lock(file, async () => {
      const info = await lstat(blob).catch((error: unknown) => {
        if (code(error) === 'ENOENT') return null;
        throw error;
      });
      if (info?.isFile() && info.nlink === 1) await rm(blob);
    });
  }

  private async lock<T>(
    file: Pick<SpeechModelFile, 'sha256'>,
    run: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const blob = this.blob(file)!;
    await safeDirectory(dirname(blob), true);
    const directory = `${blob}.lock`;
    const token = `${process.pid}-${randomUUID()}`;
    const staging = `${blob}.${token}.lock-init`;
    await mkdir(staging);
    const started = awakeNow();
    let acquired = false;
    try {
      await writeFile(join(staging, token), '', { flag: 'wx' });
      for (;;) {
        signal?.throwIfAborted();
        // Publish a NONEMPTY directory atomically. A stale-lock reaper can
        // only remove an empty directory, never a newly acquired lock.
        try {
          await rename(staging, directory);
          acquired = true;
          break;
        } catch (error) {
          if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(code(error) ?? '')) throw error;
        }
        const info = await lstat(directory).catch((error: unknown) => {
          if (code(error) === 'ENOENT') return null;
          throw error;
        });
        if (!info) {
          if (awakeNow() - started > 30 * 60_000)
            throw new Error('Unable to acquire the speech asset lock.');
          await delay(100, undefined, { signal });
          continue;
        }
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error('Unsafe speech asset lock.');
        const owners = await readdir(directory).catch((error: unknown) => {
          if (code(error) === 'ENOENT') return [] as string[];
          throw error;
        });
        for (const owner of owners) {
          const match = /^(\d+)-[a-f0-9-]+$/.exec(owner);
          if (!match) throw new Error('Invalid speech asset lock owner.');
          let alive = true;
          try {
            process.kill(Number(match[1]), 0);
          } catch (error) {
            alive = code(error) !== 'ESRCH';
          }
          if (!alive) await rm(join(directory, owner), { force: true });
        }
        await rmdir(directory).catch((error: unknown) => {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(code(error) ?? '')) throw error;
        });
        if (awakeNow() - started > 30 * 60_000)
          throw new Error(
            'Timed out waiting for another app to finish downloading this speech model.',
          );
        await delay(100, undefined, { signal });
      }
      return await run();
    } finally {
      if (acquired) {
        await rm(join(directory, token), { force: true });
        await rmdir(directory).catch((error: unknown) => {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(code(error) ?? '')) throw error;
        });
      } else await rm(staging, { recursive: true, force: true });
    }
  }
}

/** Only trusted main-process configuration supplies these locations. No service is started. */
export function speechAssetOptions(options: {
  home: string;
  env?: NodeJS.ProcessEnv;
  sharedAssets?: string | null;
}): SpeechAssetOptions {
  const env = options.env ?? {};
  const shared =
    options.sharedAssets === null ? null : (options.sharedAssets ?? env.GEZEL_SHARED_ASSETS_DIR);
  const homes = [
    options.home,
    ...(env.GEZEL_READONLY_MODEL_HOMES?.split(delimiter) ?? []).filter(isAbsolute),
  ];
  const root =
    env.GEZEL_SYSTEM_SCOPE === '1' && shared && isAbsolute(shared)
      ? join(shared, 'models', 'speech-assets')
      : join(options.home, 'engines', 'speech-assets');
  return {
    root,
    candidates: (model, file) => {
      const engine = model.kind === 'stt' ? 'whisper-cpp' : 'kokoro';
      const result = homes.flatMap((home) => [
        join(home, 'engines', engine, 'models', model.id, ...file.name.split('/')),
        join(home, 'engines', 'speech-assets', file.sha256),
        ...(model.kind === 'tts'
          ? [
              join(
                home,
                'engines',
                'hf-cache',
                'onnx-community',
                'Kokoro-82M-v1.0-ONNX-timestamped',
                ...file.name.split('/'),
              ),
              ...(file.name.startsWith('voices/')
                ? [join(home, 'service', 'node_modules', 'kokoro-js', ...file.name.split('/'))]
                : []),
            ]
          : []),
      ]);
      if (shared && isAbsolute(shared))
        result.push(
          join(shared, 'models', engine, model.id, ...file.name.split('/')),
          join(shared, 'models', 'speech-assets', file.sha256),
        );
      return result.filter((candidate) => candidate !== join(root, file.sha256));
    },
  };
}

/** Matches the installer-owned public assets directory; never the private service home. */
export function defaultSharedSpeechAssetsDir(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | null {
  const configured = env.GEZEL_SYSTEM_SERVICE_HOME?.trim();
  if (configured && isAbsolute(configured)) return join(configured, 'assets');
  if (platform === 'darwin') return '/Library/Application Support/Gezel/assets';
  if (platform === 'linux') return '/var/lib/gezel/assets';
  if (platform === 'win32')
    return win32.join(env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData', 'Gezel', 'assets');
  return null;
}
