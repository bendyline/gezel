import { describe, expect, it } from 'vitest';
import { LlamaCppProvider } from './llama-cpp/provider.js';
import { MlxProvider } from './mlx/provider.js';

/**
 * The background lane must be sized from the width the engine gate
 * actually enforces, not from the queue's deadlock reserve.
 *
 * Wild-caught: an MLX engine launched at `--max-concurrency 3` ran index
 * enrichment strictly one-at-a-time — one running, three queued, zero
 * chats — because `backgroundConcurrency` was derived as
 * `concurrency - interactiveConcurrency`, and `concurrency` is only ever
 * `interactiveConcurrency + 1`. That arithmetic yields 1 at every batch
 * width, so housekeeping stayed serial while two engine slots sat idle.
 *
 * These assertions are on the constructed queue rather than the helper,
 * because the helper was never the part that was wrong.
 */
describe('background lane sizing — provider wiring', () => {
  describe('MLX', () => {
    it('lets housekeeping use every engine slot but one', () => {
      const p = new MlxProvider({ baseUrl: 'http://mlx.test', batchMaxConcurrency: 3 });
      expect(p.batch?.maxConcurrency).toBe(3);
      expect(p.queue?.interactiveConcurrency).toBe(3);
      expect(p.queue?.backgroundConcurrency).toBe(2);
      // The deadlock reserve above the interactive cap is unchanged.
      expect(p.queue?.concurrency).toBe(4);
    });

    it('keeps a single-slot engine at one background chore', () => {
      // Width 1 is the case the reserve was designed for: admit the
      // mid-turn one-shot a foreground turn awaits, without ever running
      // a second concurrent generation.
      const p = new MlxProvider({ baseUrl: 'http://mlx.test' });
      expect(p.queue?.interactiveConcurrency).toBe(1);
      expect(p.queue?.backgroundConcurrency).toBe(1);
      expect(p.queue?.concurrency).toBe(2);
    });
  });

  describe('llama.cpp', () => {
    it('lets housekeeping use every engine slot but one when batching', () => {
      const p = new LlamaCppProvider({
        baseUrl: 'http://llama.test',
        concurrency: 4,
        batchMaxConcurrency: 4,
      });
      expect(p.queue?.interactiveConcurrency).toBe(4);
      expect(p.queue?.backgroundConcurrency).toBe(3);
    });

    it('is unchanged on the serial interactive path', () => {
      // interactive 1 / slots 4: the old expression already produced 3
      // here, so this pins that the fix did not move the unbatched path.
      const p = new LlamaCppProvider({ baseUrl: 'http://llama.test', concurrency: 4 });
      expect(p.queue?.interactiveConcurrency).toBe(1);
      expect(p.queue?.backgroundConcurrency).toBe(3);
    });

    it('is unchanged for a strictly-serial wrapper such as ds4', () => {
      const p = new LlamaCppProvider({
        baseUrl: 'http://ds4.test',
        concurrency: 1,
        reserveBackgroundSlot: false,
      });
      expect(p.queue?.concurrency).toBe(1);
      expect(p.queue?.backgroundConcurrency).toBe(1);
    });
  });
});
