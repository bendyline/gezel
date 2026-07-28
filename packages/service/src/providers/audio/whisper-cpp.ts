/**
 * WhisperCppProvider — talks to a local `whisper-server` binary over
 * HTTP. The server speaks `POST /inference` with a multipart form
 * upload (`file=@audio.wav`) plus optional `language`, `prompt`,
 * `temperature`, `response_format`. We always request `json` so we
 * get `{ text, segments, language }` back in one parse.
 *
 * Lifecycle of the binary itself is the supervisor's concern — this
 * provider just calls `ensureRunning()` before each transcription and
 * marks activity afterwards, identical to how
 * `StableDiffusionCppProvider` delegates to `NativeEngineSupervisor`.
 *
 * Model management mirrors sd-cpp: weights live under
 * `<modelsRoot>/<id>/<filename>` alongside a `manifest.json`. The
 * narration MVP hard-codes a small catalog of Whisper GGML
 * conversions hosted on Hugging Face under `ggerganov/whisper.cpp`
 * (see `WHISPER_MODEL_CATALOG`); a future revision can route through
 * the proper catalog system instead.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  type ModelStorageRoots,
  findModelRoot,
  hashModelPayloadFiles,
  listOverlayModelIds,
  makeSharedModelReadable,
  modelExistsOnlyReadOnly,
  readOnlyModelError,
  verifyReadOnlyModelPayload,
} from '../../models/storage-roots.js';
import { downloadWithRetry } from '../../utils/download-with-retry.js';
import type { NativeEngineSupervisor } from '../native/supervisor.js';
import type {
  AudioEngineHealth,
  AudioModelPullEvent,
  AudioModelPullSpec,
  InstalledAudioModelInfo,
  SpeechToTextProvider,
  TranscribeInput,
  TranscribeOutput,
} from './types.js';

export interface WhisperCppProviderOptions {
  baseUrl: string;
  modelsRoot: string;
  storageRoots?: ModelStorageRoots;
  /** Per-request timeout in ms. Defaults to 5 minutes — long enough for
   *  small models on a 30-minute audio file on weak hardware. */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  supervisor?: NativeEngineSupervisor;
  configured?: boolean;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Whisper GGML conversions on Hugging Face. Sizes are approximate —
 * the actual bytes are verified by sha256 at pull time. SHA values
 * below are the published Hugging Face values; bumping a model means
 * editing both the URL/sha together.
 *
 * Why hard-code instead of going through `@bendyline/gezel-catalog`:
 * the audio MVP's three models don't justify the catalog manifest
 * round-trip (registering a new `audio-stt-model` kind, plumbing it
 * through `CatalogService`, etc.). When TTS / STT grow more variants,
 * promote this list into the catalog same way image-models are.
 */
export const WHISPER_MODEL_CATALOG: ReadonlyArray<{
  id: string;
  name: string;
  description: string;
  approxSizeBytes: number;
  downloadUrl: string;
  sha256: string;
  filename: string;
}> = [
  {
    id: 'whisper-tiny.en',
    name: 'Whisper Tiny (English)',
    description: 'Fastest English-only model. ~75MB. Good for short voice memos.',
    approxSizeBytes: 77_700_000,
    downloadUrl: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin',
    sha256: '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f',
    filename: 'ggml-tiny.en.bin',
  },
  {
    id: 'whisper-base.en',
    name: 'Whisper Base (English)',
    description: 'Recommended default. ~140MB. Realtime on most laptop CPUs.',
    approxSizeBytes: 147_900_000,
    downloadUrl: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
    sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002',
    filename: 'ggml-base.en.bin',
  },
  {
    id: 'whisper-small.en',
    name: 'Whisper Small (English)',
    description: 'Higher accuracy, ~466MB. Slower but better on hard audio.',
    approxSizeBytes: 487_700_000,
    downloadUrl: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin',
    sha256: 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d',
    filename: 'ggml-small.en.bin',
  },
];

export class WhisperCppProvider implements SpeechToTextProvider {
  readonly name = 'whisper-cpp';
  private readonly baseUrl: string;
  private readonly modelsRoot: string;
  private readonly storageRoots: ModelStorageRoots;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly supervisor?: NativeEngineSupervisor;
  private readonly configured: boolean;

  constructor(opts: WhisperCppProviderOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.modelsRoot = opts.modelsRoot;
    this.storageRoots = opts.storageRoots ?? {
      writableRoot: opts.modelsRoot,
      readOnlyRoots: [],
    };
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.supervisor = opts.supervisor;
    this.configured = opts.configured ?? true;
  }

  async transcribe(input: TranscribeInput): Promise<TranscribeOutput> {
    const started = Date.now();

    let baseUrl = this.baseUrl;
    if (this.supervisor) {
      const launch = await this.supervisor.ensureRunning();
      baseUrl = launch.baseUrl.replace(/\/+$/, '');
    }

    let bytes: Buffer;
    let mime: string;
    let filename: string;
    if ('path' in input.audio) {
      bytes = await readFile(input.audio.path);
      filename = basename(input.audio.path);
      mime = guessMime(filename);
    } else {
      bytes = input.audio.data;
      mime = input.audio.mimeType || 'audio/wav';
      filename = `audio.${mime.split('/')[1] ?? 'wav'}`;
    }

    const form = new FormData();
    form.set('file', new Blob([new Uint8Array(bytes)], { type: mime }), filename);
    form.set('response_format', 'json');
    if (input.language) form.set('language', input.language);
    if (input.model) form.set('model', input.model);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${baseUrl}/inference`, {
        method: 'POST',
        body: form,
        signal: ctrl.signal,
      });
    } catch (err) {
      if (ctrl.signal.aborted) {
        throw new Error(`whisper-server did not respond within ${this.timeoutMs / 1000}s`);
      }
      throw new Error(
        `whisper-server unreachable at ${baseUrl}. Is the audio engine enabled in Settings? (${err instanceof Error ? err.message : String(err)})`,
      );
    } finally {
      clearTimeout(timer);
      this.supervisor?.markUsed();
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `whisper-server returned ${res.status} ${res.statusText}: ${text.slice(0, 300)}`,
      );
    }

    const payload = (await res.json()) as {
      text?: string;
      language?: string;
      segments?: Array<{ start?: number; end?: number; text?: string }>;
    };

    const text = (payload.text ?? '').trim();
    const out: TranscribeOutput = {
      text,
      durationMs: Date.now() - started,
    };
    if (payload.language) out.language = payload.language;
    if (Array.isArray(payload.segments) && payload.segments.length > 0) {
      out.segments = payload.segments
        .filter(
          (s): s is { start: number; end: number; text: string } =>
            typeof s.start === 'number' && typeof s.end === 'number' && typeof s.text === 'string',
        )
        .map((s) => ({ start: s.start, end: s.end, text: s.text.trim() }));
    }
    return out;
  }

  async listInstalledModels(): Promise<InstalledAudioModelInfo[]> {
    const entries = await listOverlayModelIds(this.storageRoots);
    const out: InstalledAudioModelInfo[] = [];
    for (const id of entries) {
      try {
        const root = await findModelRoot(this.storageRoots, id);
        if (!root) continue;
        const raw = await readFile(join(root, id, 'manifest.json'), 'utf8');
        const parsed = JSON.parse(raw) as Partial<InstalledAudioModelInfo> & {
          fileSha256?: Record<string, string>;
        };
        if (!parsed.id || !parsed.name || !parsed.installedAt) continue;
        if (!(await verifyReadOnlyModelPayload(this.storageRoots, root, id, parsed.fileSha256))) {
          continue;
        }
        out.push({
          id: parsed.id,
          name: parsed.name,
          approxSizeBytes: parsed.approxSizeBytes ?? 0,
          installedAt: parsed.installedAt,
        });
      } catch {
        /* skip malformed entries */
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  async *pullModel(id: string, spec: AudioModelPullSpec): AsyncIterable<AudioModelPullEvent> {
    const itemDir = join(this.modelsRoot, id);
    await mkdir(itemDir, { recursive: true });

    const totalAllBytes = spec.files.reduce((n, f) => n + f.approxSizeBytes, 0);
    let writtenAll = 0;

    for (const file of spec.files) {
      const filename = filenameForRole(file.role, file.downloadUrl);
      const destPath = join(itemDir, filename);
      const result = yield* downloadWithSha256(this.fetchImpl, {
        url: file.downloadUrl,
        destPath,
        expectedSha256: file.sha256,
        approxSizeBytes: file.approxSizeBytes,
        writtenSoFar: writtenAll,
        totalAllBytes,
      });
      if (result.kind === 'error') {
        yield { type: 'error', error: `${file.role}: ${result.error}` };
        yield { type: 'done', id };
        return;
      }
      writtenAll = result.writtenAll;
    }

    const fileSha256 = await hashModelPayloadFiles(itemDir);
    await writeFile(
      join(itemDir, 'manifest.json'),
      JSON.stringify(
        {
          id,
          name: spec.name,
          approxSizeBytes: totalAllBytes,
          files: spec.files.map((f) => ({
            role: f.role,
            filename: filenameForRole(f.role, f.downloadUrl),
            sha256: f.sha256.toLowerCase(),
          })),
          fileSha256,
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      'utf8',
    );
    await makeSharedModelReadable(itemDir);

    yield { type: 'progress', bytesWritten: writtenAll, totalBytes: totalAllBytes };
    yield { type: 'done', id };
  }

  async deleteModel(id: string): Promise<void> {
    if (await modelExistsOnlyReadOnly(this.storageRoots, id)) {
      throw readOnlyModelError(id);
    }
    await rm(join(this.modelsRoot, id), { recursive: true, force: true });
  }

  async health(): Promise<AudioEngineHealth> {
    if (!this.configured) {
      return {
        status: 'not-configured',
        baseUrl: this.baseUrl,
        error:
          'whisper.cpp engine is not wired up. Build the binary or pull a model from Settings → Audio.',
      };
    }
    const installed = await this.listInstalledModels();
    if (installed.length === 0) {
      return {
        status: 'no-model',
        baseUrl: this.baseUrl,
        error: 'No STT model is available locally. Download one from Settings → Audio.',
      };
    }
    if (this.supervisor) {
      // Engine is configured + has a model; the supervisor will lazy-start
      // on the next transcribe. Don't probe eagerly — same reasoning as
      // sd-cpp's health(): a Settings open shouldn't pay a cold-start.
      return { status: 'ok', baseUrl: this.baseUrl };
    }
    return await probeReachable(this.fetchImpl, this.baseUrl);
  }

  async shutdown(): Promise<void> {
    await this.supervisor?.stop();
  }
}

/**
 * Resolve the on-disk filename for a downloaded file. Whisper today
 * is a single-file pull (`weights`), so `filenameForRole` mostly just
 * returns the URL's basename. Defined as a helper so Kokoro / future
 * multi-file pulls (e.g. `voice:af_heart`) can reuse the convention.
 */
function filenameForRole(role: string, url: string): string {
  const base = extractFilename(url);
  if (role === 'weights') return base;
  // Voice files etc. — keep the role in the filename so the manifest
  // and disk layout are self-describing.
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot) : '';
  const safeRole = role.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return `${safeRole}${ext}`;
}

function extractFilename(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    return last && last.length > 0 ? last : 'weights.bin';
  } catch {
    return 'weights.bin';
  }
}

function guessMime(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.m4a') || lower.endsWith('.mp4')) return 'audio/mp4';
  if (lower.endsWith('.ogg') || lower.endsWith('.oga')) return 'audio/ogg';
  if (lower.endsWith('.flac')) return 'audio/flac';
  if (lower.endsWith('.webm')) return 'audio/webm';
  return 'application/octet-stream';
}

async function probeReachable(
  fetchImpl: typeof fetch,
  baseUrl: string,
): Promise<AudioEngineHealth> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    const res = await fetchImpl(`${baseUrl}/`, { method: 'GET', signal: ctrl.signal });
    void res.body?.cancel?.().catch(() => {});
    return { status: 'ok', baseUrl };
  } catch (err) {
    return {
      status: 'unreachable',
      baseUrl,
      error: ctrl.signal.aborted
        ? `whisper-server did not respond within 2s at ${baseUrl}`
        : err instanceof Error
          ? err.message
          : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Stream a URL to disk with sha256 verification, yielding cumulative
 * progress events. Shared with KokoroProvider via a sibling import —
 * exported so we don't duplicate the logic.
 */
export async function* downloadWithSha256(
  fetchImpl: typeof fetch,
  opts: {
    url: string;
    destPath: string;
    expectedSha256: string;
    approxSizeBytes: number;
    writtenSoFar: number;
    totalAllBytes: number;
  },
): AsyncGenerator<
  AudioModelPullEvent,
  { kind: 'ok'; writtenAll: number; actualSize: number } | { kind: 'error'; error: string }
> {
  const { url, destPath, expectedSha256, totalAllBytes } = opts;
  let writtenAll = opts.writtenSoFar;
  const tmpPath = `${destPath}.partial`;
  const download = downloadWithRetry({
    url,
    destPath,
    approxSizeBytes: opts.approxSizeBytes,
    fetchImpl,
  });
  let writtenThisFile = 0;
  while (true) {
    const next = await download.next();
    if (next.done) {
      if (next.value.kind === 'aborted') return { kind: 'error', error: 'download aborted' };
      if (next.value.kind === 'error') return { kind: 'error', error: next.value.error };
      writtenThisFile = next.value.bytesWritten;
      writtenAll = opts.writtenSoFar + writtenThisFile;
      break;
    }
    if (next.value.type === 'progress') {
      writtenThisFile = next.value.bytesWritten;
      writtenAll = opts.writtenSoFar + writtenThisFile;
      yield { type: 'progress', bytesWritten: writtenAll, totalBytes: totalAllBytes };
    }
  }

  const hasher = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(tmpPath);
    stream.on('data', (chunk) => hasher.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  const actual = hasher.digest('hex');
  if (actual !== expectedSha256.toLowerCase()) {
    await rm(tmpPath, { force: true });
    return {
      kind: 'error',
      error: `sha256 mismatch: expected ${expectedSha256}, got ${actual}`,
    };
  }

  await rm(destPath, { force: true });
  await rename(tmpPath, destPath);
  return { kind: 'ok', writtenAll, actualSize: writtenThisFile };
}

// Local type to describe what Node's fetch returns — avoids importing dom types.
interface ReadableStream<T> {
  getReader(): {
    read(): Promise<{ value: T | undefined; done: boolean }>;
  };
}
