import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HandboekArticle, HandboekNarrationResponse } from '@bendyline/gezel';
import { createLogger } from '@bendyline/gezel';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { buildNarrationScript } from '@bendyline/squisq/narration';
import type { TextToSpeechProviderManager } from '../providers/audio/tts-manager.js';

const log = createLogger('handboek');

/**
 * Narration for handboek articles: kokoro TTS per doc block, cached on
 * disk under `~/.gezel/handboek/narration/` keyed by a content hash so
 * an article is only ever synthesized once per (text, voice, provider).
 * The cache is a handboek-owned carve-out (derived data, safe to
 * delete — see CLAUDE.md's Store carve-out list).
 *
 * Narration text comes from squisq's own `buildNarrationScript`, so the
 * audio matches the words the player's captions expect. Blocks the
 * script skips (pure-media, no spoken text) get a short silent segment
 * to keep the block↔segment mapping positional.
 */
const SILENCE_MS = 600;
const SAMPLE_RATE = 24_000;

export interface HandboekNarrator {
  manifest(article: HandboekArticle, opts?: { voice?: string }): Promise<HandboekNarrationResponse>;
  /** Absolute path of a cached narration WAV, or null when unknown. */
  audioPath(hash: string): string | null;
}

export function createHandboekNarrator(deps: {
  home: string;
  tts: TextToSpeechProviderManager;
}): HandboekNarrator {
  const dir = join(deps.home, 'handboek', 'narration');

  const pathFor = (hash: string) => join(dir, `${hash}.wav`);
  const metaPathFor = (hash: string) => join(dir, `${hash}.json`);

  async function ensureSegment(
    key: string,
    synthesize: () => Promise<{ wav: Buffer; durationMs: number; model: string; voice: string }>,
  ): Promise<{ hash: string; durationMs: number; model: string; voice: string }> {
    const hash = createHash('sha256').update(key).digest('hex');
    const metaPath = metaPathFor(hash);
    if (existsSync(pathFor(hash)) && existsSync(metaPath)) {
      try {
        const meta = JSON.parse(await readFile(metaPath, 'utf8')) as {
          durationMs: number;
          model: string;
          voice: string;
        };
        return { hash, ...meta };
      } catch {
        // Corrupt sidecar — fall through and resynthesize.
      }
    }
    const out = await synthesize();
    await mkdir(dir, { recursive: true });
    await writeFile(pathFor(hash), out.wav);
    await writeFile(
      metaPath,
      JSON.stringify({ durationMs: out.durationMs, model: out.model, voice: out.voice }),
      'utf8',
    );
    return { hash, durationMs: out.durationMs, model: out.model, voice: out.voice };
  }

  return {
    async manifest(article, opts) {
      const provider = await deps.tts.providerForModel(undefined);
      const doc = markdownToDoc(parseMarkdown(article.markdown), { articleId: article.id });
      const script = buildNarrationScript(doc);
      const textByBlock = new Map<string, string>();
      for (const range of script.blocks) {
        textByBlock.set(range.blockId, script.sourceText.slice(range.charStart, range.charEnd));
      }

      const segments: HandboekNarrationResponse['segments'] = [];
      let voice = opts?.voice ?? '';
      let model = '';
      for (const block of doc.blocks) {
        const text = textByBlock.get(block.id)?.trim();
        if (!text) {
          const silent = await ensureSegment(`v1|silence|${SILENCE_MS}`, async () => ({
            wav: silentWav(SILENCE_MS),
            durationMs: SILENCE_MS,
            model: 'silence',
            voice: 'silence',
          }));
          segments.push({
            blockId: block.id,
            hash: silent.hash,
            durationMs: silent.durationMs,
            silent: true,
          });
          continue;
        }
        const key = `v1|${provider.name}|${opts?.voice ?? 'default'}|${text}`;
        const seg = await ensureSegment(key, async () => {
          const started = Date.now();
          const out = await provider.synthesize({
            text,
            ...(opts?.voice ? { voice: opts.voice } : {}),
          });
          log.info(
            `[narration] ${article.id} block=${block.id} chars=${text.length} in ${Date.now() - started}ms`,
          );
          return {
            wav: out.wav,
            durationMs: out.meta.durationMs,
            model: out.meta.model,
            voice: out.meta.voice,
          };
        });
        voice = voice || seg.voice;
        model = model || seg.model;
        segments.push({ blockId: block.id, hash: seg.hash, durationMs: seg.durationMs });
      }
      return {
        articleId: article.id,
        voice: voice || 'default',
        model: model || provider.name,
        segments,
      };
    },

    audioPath(hash) {
      if (!/^[a-f0-9]{64}$/.test(hash)) return null;
      const p = pathFor(hash);
      return existsSync(p) ? p : null;
    },
  };
}

/** Minimal 16-bit PCM mono WAV of silence — no TTS round-trip needed. */
export function silentWav(durationMs: number): Buffer {
  const numSamples = Math.round((SAMPLE_RATE * durationMs) / 1000);
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}
