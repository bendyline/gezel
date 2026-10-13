import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { RelevanceModelSpec } from '@bendyline/gezel';
import { safeJoin } from '../fs/safe-paths.js';
import { resolveModelDirectory } from '../models/model-id.js';
import { downloadWithSha256 } from '../providers/audio/whisper-cpp.js';

/**
 * Relevance models live under `<home>/engines/relevance-models/<id>/`, laid
 * out like their Hugging Face repo (config.json, tokenizer.json, onnx/…), so
 * transformers.js loads them from the absolute folder with no network at
 * search time. Every file is sha256-verified as it lands (`.partial`, then
 * rename), and `installed.json` is written last — its presence, plus every
 * file at its pinned size, is what "installed" means.
 */

const INSTALLED_MARKER = 'installed.json';

/**
 * `GEZEL_RELEVANCE_MODELS_DIR` points every daemon at one shared folder —
 * how evals, whose homes are fresh per trial, keep one verified copy instead
 * of downloading the model on every run (the `GEZEL_HF_CACHE_DIR` pattern).
 */
export function relevanceModelsRoot(home: string): string {
  const shared = process.env.GEZEL_RELEVANCE_MODELS_DIR?.trim();
  return shared || join(home, 'engines', 'relevance-models');
}

export function relevanceModelDir(home: string, id: string): string {
  return resolveModelDirectory(relevanceModelsRoot(home), id);
}

export async function installedRelevanceModel(
  home: string,
  spec: RelevanceModelSpec,
): Promise<boolean> {
  const dir = relevanceModelDir(home, spec.id);
  try {
    const marker = JSON.parse(await readFile(join(dir, INSTALLED_MARKER), 'utf8')) as {
      id?: string;
      revision?: string;
    };
    if (marker.id !== spec.id || marker.revision !== spec.source.revision) return false;
    for (const file of spec.files) {
      const target = safeJoin(dir, file.path);
      if (!target) return false;
      if ((await stat(target)).size !== file.bytes) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export type RelevanceInstallEvent =
  | { type: 'progress'; bytesDone: number; bytesTotal: number }
  | { type: 'done' }
  | { type: 'error'; error: string };

const inflight = new Map<string, Promise<void>>();

/**
 * Download and verify a model. One install per id at a time: a second caller
 * waits on the first and then sees the finished install. Downloads are the
 * caller's to gate on the security policy's `allowAppNetwork`.
 */
export async function* installRelevanceModel(
  home: string,
  spec: RelevanceModelSpec,
  opts: { fetchImpl?: typeof fetch } = {},
): AsyncGenerator<RelevanceInstallEvent> {
  if (await installedRelevanceModel(home, spec)) {
    yield { type: 'done' };
    return;
  }
  const running = inflight.get(spec.id);
  if (running) {
    await running.catch(() => {});
    yield (await installedRelevanceModel(home, spec))
      ? { type: 'done' }
      : { type: 'error', error: 'the concurrent install did not finish' };
    return;
  }
  let finish = (): void => {};
  inflight.set(
    spec.id,
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  try {
    const dir = relevanceModelDir(home, spec.id);
    await rm(join(dir, INSTALLED_MARKER), { force: true });
    const total = spec.files.reduce((sum, file) => sum + file.bytes, 0);
    let written = 0;
    for (const file of spec.files) {
      const dest = safeJoin(dir, file.path);
      if (!dest) {
        yield { type: 'error', error: `unsafe file path ${file.path}` };
        return;
      }
      await mkdir(dirname(dest), { recursive: true });
      const download = downloadWithSha256(opts.fetchImpl ?? fetch, {
        url: `https://huggingface.co/${spec.source.repo}/resolve/${spec.source.revision}/${file.path}`,
        destPath: dest,
        expectedSha256: file.sha256,
        approxSizeBytes: file.bytes,
        writtenSoFar: written,
        totalAllBytes: total,
      });
      for (;;) {
        const next = await download.next();
        if (next.done) {
          if (next.value.kind === 'error') {
            yield { type: 'error', error: `${file.path}: ${next.value.error}` };
            return;
          }
          written = next.value.writtenAll;
          break;
        }
        if (next.value.type === 'progress') {
          yield { type: 'progress', bytesDone: next.value.bytesWritten, bytesTotal: total };
        }
      }
    }
    await writeFile(
      join(dir, INSTALLED_MARKER),
      `${JSON.stringify({ id: spec.id, revision: spec.source.revision, installedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    yield { type: 'done' };
  } finally {
    inflight.delete(spec.id);
    finish();
  }
}

export async function removeRelevanceModel(home: string, id: string): Promise<void> {
  await rm(relevanceModelDir(home, id), { recursive: true, force: true });
}
