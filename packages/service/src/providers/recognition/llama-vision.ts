/**
 * LlamaVisionProvider — runs a small vision model on a dedicated
 * `llama-server` instance launched with `--model … --mmproj …`.
 *
 * Deliberately NOT the chat `ProviderPool`. Three reasons, in order of how
 * badly each would hurt:
 *
 *   1. Recognition runs *before* the chat model's turn, so pooling would
 *      serialize them through the same `CapacityBroker` — evict chat model,
 *      load vision model, evict it, reload chat model. Two cold starts on the
 *      exact turn the user is blocked on.
 *   2. An mmproj-backed server returns 501 on slot save/restore, which latches
 *      disk-KV prefix caching off process-wide (see the cache adapter's
 *      `slotActionsUnsupported`). Putting a vision model in the chat pool
 *      would degrade prompt caching for every model in it.
 *   3. Pool entries carry session affinity and KV state; a recognition call is
 *      a stateless one-shot with neither.
 *
 * Running a second `llama-server` alongside the chat one is already safe: the
 * orphan reaper consults a process-wide live-pid set precisely so a second
 * supervisor never reaps a live sibling.
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type ImageRecognition, createLogger, nowIso } from '@bendyline/gezel';
import type { RecognitionHealth } from '@bendyline/gezel';
import { readImageStaticMeta } from '../../index-store/image-meta.js';
import { resolveModelDirectory } from '../../models/model-id.js';
import {
  type ModelStorageRoots,
  assertModelStorePathSafe,
  findModelRoot,
  hashModelPayloadFiles,
  listOverlayModelIds,
  makeSharedModelReadable,
  modelExistsOnlyReadOnly,
  readOnlyModelError,
  verifyReadOnlyModelPayload,
} from '../../models/storage-roots.js';
import { downloadWithSha256 } from '../audio/whisper-cpp.js';
import type { NativeEngineSupervisor } from '../native/supervisor.js';
import { MODE_PROMPTS } from './prompts.js';
import type {
  InstalledRecognitionModelInfo,
  RecognitionProvider,
  RecognitionPullEvent,
  RecognitionPullSpec,
  RecognizeInput,
} from './types.js';

const log = createLogger('recognition');

const DEFAULT_TIMEOUT_MS = 90_000;

export interface LlamaVisionProviderOptions {
  baseUrl: string;
  modelsRoot: string;
  storageRoots?: ModelStorageRoots;
  modelId?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  supervisor?: NativeEngineSupervisor;
  configured?: boolean;
  /** Refuses the run when the broker can't spare the memory. */
  reserveMemory?: (bytes: number) => Promise<{ ok: true } | { ok: false; reason: string }>;
}

export class LlamaVisionProvider implements RecognitionProvider {
  readonly name = 'llama-cpp';
  private readonly baseUrl: string;
  private readonly modelsRoot: string;
  private readonly storageRoots: ModelStorageRoots;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly supervisor?: NativeEngineSupervisor;
  private readonly configured: boolean;
  private readonly modelId: string;

  constructor(opts: LlamaVisionProviderOptions) {
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
    this.modelId = opts.modelId ?? 'unknown';
  }

  async recognize(input: RecognizeInput): Promise<ImageRecognition> {
    const started = Date.now();
    const meta = readImageStaticMeta(input.bytes);
    // Static metadata is the floor: whatever happens next, the caller gets
    // format, dimensions, and any embedded generation prompt.
    const base: ImageRecognition = {
      schemaVersion: 1,
      sha256: meta.sha256,
      meta,
      modes: [input.mode],
      engine: 'llama-cpp',
      modelId: this.modelId,
      status: 'static-only',
      durationMs: 0,
      at: nowIso(),
    };

    try {
      const launch = await this.supervisor?.ensureRunning();
      const text = await this.complete(input, launch?.baseUrl ?? this.baseUrl);
      const done: ImageRecognition = {
        ...base,
        status: 'ok',
        durationMs: Date.now() - started,
      };
      if (input.mode === 'ocr') done.ocrText = text;
      else if (input.mode === 'extract') {
        try {
          done.structured = { data: JSON.parse(text) };
        } catch {
          // Grammar-constrained decode should make this unreachable; if the
          // server ignored `response_format`, keep the text rather than
          // failing the turn.
          done.status = 'partial';
          done.description = text;
          done.failureReason = 'model did not return valid JSON';
        }
      } else done.description = text;
      return done;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`recognition failed (${input.mode}): ${message}`);
      return {
        ...base,
        status: 'failed',
        failureReason: message,
        durationMs: Date.now() - started,
      };
    } finally {
      this.supervisor?.markUsed();
    }
  }

  private async complete(input: RecognizeInput, baseUrl: string): Promise<string> {
    const prompt = MODE_PROMPTS[input.mode];
    const body: Record<string, unknown> = {
      messages: [
        { role: 'system', content: prompt.system },
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt.user },
            {
              type: 'image_url',
              image_url: {
                url: `data:${input.mimeType};base64,${input.bytes.toString('base64')}`,
              },
            },
          ],
        },
      ],
      max_tokens: prompt.maxTokens,
      // Description and transcription are both recall tasks; sampling
      // creativity here shows up as invented UI labels.
      temperature: 0.1,
      stream: false,
    };
    if (input.mode === 'extract' && input.schema) {
      // llama-server compiles this into a decode-time grammar, so output
      // either parses or the request fails. No JSON repair layer needed.
      body.response_format = { type: 'json_schema', json_schema: { schema: input.schema } };
    }

    const res = await this.fetchImpl(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(input.timeoutMsOverride ?? this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`vision engine returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('vision engine returned an empty response');
    return text;
  }

  async listInstalledModels(): Promise<InstalledRecognitionModelInfo[]> {
    const entries = await listOverlayModelIds(this.storageRoots);
    const out: InstalledRecognitionModelInfo[] = [];
    for (const id of entries) {
      try {
        const root = await findModelRoot(this.storageRoots, id);
        if (!root) continue;
        const raw = await readFile(join(root, id, 'manifest.json'), 'utf8');
        const parsed = JSON.parse(raw) as {
          id?: string;
          name?: string;
          approxSizeBytes?: number;
          installedAt?: string;
          files?: Array<{ role: string; filename: string }>;
          fileSha256?: Record<string, string>;
        };
        if (!parsed.id || !parsed.name || !parsed.installedAt) continue;
        if (!(await verifyReadOnlyModelPayload(this.storageRoots, root, id, parsed.fileSha256))) {
          continue;
        }
        const weights = parsed.files?.find((f) => f.role === 'weights');
        const mmproj = parsed.files?.find((f) => f.role === 'mmproj');
        // A vision model without its projector is just a small text model —
        // treat a half-finished install as absent rather than advertising it.
        if (!weights || !mmproj) continue;
        out.push({
          id: parsed.id,
          name: parsed.name,
          approxSizeBytes: parsed.approxSizeBytes ?? 0,
          installedAt: parsed.installedAt,
          weightsPath: join(root, id, weights.filename),
          mmprojPath: join(root, id, mmproj.filename),
        });
      } catch {
        /* skip malformed entries */
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  async *pullModel(id: string, spec: RecognitionPullSpec): AsyncIterable<RecognitionPullEvent> {
    const itemDir = join(this.modelsRoot, id);
    await mkdir(this.modelsRoot, { recursive: true });
    await assertModelStorePathSafe(this.modelsRoot, itemDir);
    await mkdir(itemDir, { recursive: true });
    await assertModelStorePathSafe(this.modelsRoot, itemDir);
    const totalAllBytes = spec.files.reduce((n, f) => n + f.approxSizeBytes, 0);
    let writtenAll = 0;
    const verifiedDigests: Record<string, string> = {};

    for (const file of spec.files) {
      const result = yield* downloadWithSha256(this.fetchImpl, {
        url: file.downloadUrl,
        destPath: join(itemDir, file.filename),
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
      // downloadWithSha256 just proved the published file matches this digest.
      // Reuse it below instead of silently reading multi-gigabyte weights and
      // projector files from disk for a second full hash pass.
      verifiedDigests[file.filename] = file.sha256.toLowerCase();
    }

    // Written last, so an interrupted pull leaves no manifest and the model
    // reads as not-installed rather than installed-and-broken.
    const fileSha256 = await hashModelPayloadFiles(itemDir, verifiedDigests);
    await writeFile(
      join(itemDir, 'manifest.json'),
      `${JSON.stringify(
        {
          id,
          name: spec.name,
          approxSizeBytes: totalAllBytes,
          files: spec.files.map((f) => ({
            role: f.role,
            filename: f.filename,
            sha256: f.sha256.toLowerCase(),
          })),
          fileSha256,
          installedAt: nowIso(),
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    await makeSharedModelReadable(itemDir);

    yield { type: 'progress', bytesWritten: writtenAll, totalBytes: totalAllBytes };
    yield { type: 'done', id };
  }

  async deleteModel(id: string): Promise<void> {
    const itemDir = resolveModelDirectory(this.modelsRoot, id);
    if (await modelExistsOnlyReadOnly(this.storageRoots, id)) {
      throw readOnlyModelError(id);
    }
    await rm(itemDir, { recursive: true, force: true });
  }

  async health(): Promise<RecognitionHealth> {
    if (!this.configured) {
      return {
        state: 'not-configured',
        detail: 'The llama.cpp engine binary is not available on this device.',
      };
    }
    const installed = await this.listInstalledModels();
    if (installed.length === 0) {
      return {
        state: 'no-model',
        detail: 'No image-recognition model is installed yet.',
      };
    }
    // Don't probe — opening Settings shouldn't pay a cold start. The
    // supervisor lazy-starts on the first real recognition.
    return { state: 'ok', modelId: this.modelId };
  }

  async shutdown(): Promise<void> {
    await this.supervisor?.stop();
  }
}
