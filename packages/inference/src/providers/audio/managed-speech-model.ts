import { randomUUID } from 'node:crypto';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type SpeechAssetStore,
  type SpeechModelEntry,
  downloadBytes,
  verifyFile,
} from '@bendyline/gezel/speech-models';
import type { AudioModelPullEvent, InstalledAudioModelInfo } from './types.js';

/** Inventory reads never download or publish an installation. */
export async function sharedSpeechModelInfo(
  assets: SpeechAssetStore,
  entry: SpeechModelEntry,
  root: string,
): Promise<InstalledAudioModelInfo | null> {
  let installedAt = '';
  for (const file of entry.files) {
    const local = join(root, entry.id, ...file.name.split('/'));
    const source =
      (await assets.find(entry, file)) ??
      ((await verifyFile(local, file.sha256, file.size)) ? local : null);
    if (!source) return null;
    installedAt ||= (await stat(source)).mtime.toISOString();
  }
  return { id: entry.id, name: entry.label, approxSizeBytes: downloadBytes(entry), installedAt };
}

/** Acquire this app's references and publish a Gezel-compatible manifest last. */
export async function ensureSpeechModel(
  assets: SpeechAssetStore,
  entry: SpeechModelEntry,
  root: string,
  download: boolean,
  onProgress?: (received: number, total: number) => void,
): Promise<boolean> {
  if (!download && !(await sharedSpeechModelInfo(assets, entry, root))) return false;
  let completed = 0;
  const total = downloadBytes(entry);
  for (const file of entry.files) {
    if (
      !(await assets.materialize(entry, file, join(root, entry.id, ...file.name.split('/')), {
        download,
        onProgress: (received) => onProgress?.(completed + received, total),
      }))
    )
      return false;
    completed += file.size;
  }
  const directory = join(root, entry.id);
  await mkdir(directory, { recursive: true });
  const manifest = {
    id: entry.id,
    name: entry.label,
    approxSizeBytes: total,
    installedAt: new Date().toISOString(),
    files: entry.files.map((file) => ({
      role: entry.kind === 'stt' ? 'weights' : file.name,
      filename: file.name,
      sha256: file.sha256,
    })),
    fileSha256: Object.fromEntries(entry.files.map((file) => [file.name, file.sha256])),
  };
  await writeSpeechMetadata(directory, 'manifest.json', JSON.stringify(manifest, null, 2));
  return true;
}

export async function writeSpeechMetadata(
  directory: string,
  name: string,
  bytes: string,
): Promise<void> {
  const temporary = join(directory, `${name}.${randomUUID()}.tmp`);
  await writeFile(temporary, bytes, { flag: 'wx' });
  await rename(temporary, join(directory, name));
}

/** Preserve byte-level progress while the shared installer coordinates another process. */
export async function* speechPullEvents(
  id: string,
  work: (progress: (received: number, total: number) => void) => Promise<unknown>,
): AsyncIterable<AudioModelPullEvent> {
  let latest: AudioModelPullEvent | undefined;
  let done = false;
  let error: unknown;
  let wake: (() => void) | undefined;
  const pending = work((bytesWritten, totalBytes) => {
    latest = { type: 'progress', bytesWritten, totalBytes };
    wake?.();
  })
    .catch((failure) => {
      error = failure;
    })
    .finally(() => {
      done = true;
      wake?.();
    });
  while (!done || latest) {
    if (latest) {
      const event = latest;
      latest = undefined;
      yield event;
    } else
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
  }
  await pending;
  if (error) yield { type: 'error', error: error instanceof Error ? error.message : String(error) };
  yield { type: 'done', id };
}
