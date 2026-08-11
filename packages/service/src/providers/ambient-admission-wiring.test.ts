import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LlamaCppProvider } from './llama-cpp/provider.js';
import { MlxProvider } from './mlx/provider.js';
import { OllamaProvider } from './ollama.js';
import { defaultAmbientQuietMs } from './queue.js';

/**
 * Wiring guard for ambient admission control (see the queue.ts class
 * header): every local single-GPU engine — the `ENRICH_LOCAL_PROVIDERS`
 * trio in index-store/enrich.ts — must arm the quiet-window gate on its
 * queue, or ambient chores (index enrichment, scheduler nudges, memory
 * extraction) can occupy the lane right before the user's next message.
 * Providers are constructed in external-baseUrl mode: no engine, no IO.
 */

let savedQuietMs: string | undefined;

beforeEach(() => {
  savedQuietMs = process.env.GEZEL_AMBIENT_QUIET_MS;
  delete process.env.GEZEL_AMBIENT_QUIET_MS;
});

afterEach(() => {
  if (savedQuietMs === undefined) delete process.env.GEZEL_AMBIENT_QUIET_MS;
  else process.env.GEZEL_AMBIENT_QUIET_MS = savedQuietMs;
});

describe('local engine queues arm ambient admission control by default', () => {
  it('llama-cpp', () => {
    const provider = new LlamaCppProvider({ baseUrl: 'http://llama.test' });
    expect(provider.queue.ambientQuietMs).toBe(defaultAmbientQuietMs());
    expect(provider.queue.ambientQuietMs).toBeGreaterThan(0);
  });

  it('mlx', () => {
    const provider = new MlxProvider({ baseUrl: 'http://mlx.test' });
    expect(provider.queue.ambientQuietMs).toBe(defaultAmbientQuietMs());
    expect(provider.queue.ambientQuietMs).toBeGreaterThan(0);
  });

  it('ollama', () => {
    const provider = new OllamaProvider({ baseUrl: 'http://ollama.test' });
    expect(provider.queue.ambientQuietMs).toBe(defaultAmbientQuietMs());
    expect(provider.queue.ambientQuietMs).toBeGreaterThan(0);
  });

  it('GEZEL_AMBIENT_QUIET_MS=0 reaches the queue and disables the gate', () => {
    process.env.GEZEL_AMBIENT_QUIET_MS = '0';
    const provider = new OllamaProvider({ baseUrl: 'http://ollama.test' });
    expect(provider.queue.ambientQuietMs).toBe(0);
  });
});
