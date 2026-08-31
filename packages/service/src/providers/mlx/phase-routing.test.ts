import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EnginePhaseEvent } from '../streaming-session.js';

import { MlxProvider } from './provider.js';

/**
 * A supervised engine has ONE stdout shared by every session running on it, so
 * a phase parsed from a log line reaches all of them. That is right for
 * whole-engine phases and wrong for per-request progress: with two sessions on
 * one engine, the one streaming its reply drew the other's prefill bar — at
 * the other's token total — and it flickered, because each of its own content
 * deltas cleared the bar that the neighbour's next `Prefill:` line re-drew.
 *
 * The sidecar now stamps each prefill marker with the owning `cache_id`, and
 * the fanout routes on it. Untagged phases still broadcast, so an engine that
 * doesn't emit the tag degrades to the old behaviour rather than going dark.
 */
interface FakeSession {
  seen: EnginePhaseEvent[];
  ownsCacheId(cacheId: string): boolean;
  publishEnginePhase(event: EnginePhaseEvent): void;
}

function session(id: string): FakeSession {
  const seen: EnginePhaseEvent[] = [];
  return {
    seen,
    ownsCacheId: (cacheId) => cacheId === id,
    publishEnginePhase: (event) => void seen.push(event),
  };
}

function providerWith(...sessions: FakeSession[]): MlxProvider {
  const p = new MlxProvider({ baseUrl: 'http://127.0.0.1:6229' });
  for (const s of sessions) p._registerActiveSession(s as never);
  return p;
}

describe('MLX engine-phase fanout', () => {
  it('delivers a tagged prefill marker only to its owner', () => {
    const a = session('sess-a');
    const b = session('sess-b');
    const p = providerWith(a, b);

    p.onStdoutLine('[mlx] Prefill:  46%|          | 28672/62915 [batched] cache=sess-b');

    expect(a.seen).toHaveLength(0);
    expect(b.seen.map((e) => e.progress)).toEqual([0.46]);
  });

  it('broadcasts untagged phases to every session', () => {
    const a = session('sess-a');
    const b = session('sess-b');
    const p = providerWith(a, b);

    // Engine-wide: both sessions are affected by the model loading.
    p.onStdoutLine('[mlx] Loading model from: /models/qwen');
    // Untagged prefill — an engine without the tag must not go dark.
    p.onStdoutLine('[mlx] Prefill:   9%|          | 2048/22528 [batched]');

    expect(a.seen.map((e) => e.phase)).toEqual(['loading_model', 'prefill']);
    expect(b.seen.map((e) => e.phase)).toEqual(['loading_model', 'prefill']);
  });

  it('does not dedupe two subs whose markers render identically', () => {
    const a = session('sess-a');
    const b = session('sess-b');
    const p = providerWith(a, b);

    // Same percentage and same totals — only the owner differs. Keying the
    // repeat-suppressor on detail alone dropped the second one, stalling that
    // session's bar at whatever it last saw.
    p.onStdoutLine('[mlx] Prefill:  50%|          | 1024/2048 [batched] cache=sess-a');
    p.onStdoutLine('[mlx] Prefill:  50%|          | 1024/2048 [batched] cache=sess-b');

    expect(a.seen).toHaveLength(1);
    expect(b.seen).toHaveLength(1);
  });

  it('catches a late joiner up on engine-wide phases only', () => {
    // A session registering mid-run replays the last phase so a chat opened
    // during a long weight load shows what the engine is doing. But a TAGGED
    // phase belongs to one session's prefill — replaying it is how a fresh
    // chat would inherit a neighbour's progress bar, which is the same
    // fanout bug one level removed.
    const a = session('sess-a');
    const p = providerWith(a);

    p.onStdoutLine('[mlx] Loading model from: /models/qwen');
    const late = session('sess-late');
    p._registerActiveSession(late as never);
    expect(late.seen.map((e) => e.phase)).toEqual(['loading_model']);

    const tagged = session('sess-tagged');
    p.onStdoutLine('[mlx] Prefill:  20%|          | 400/2048 [batched] cache=sess-a');
    p._registerActiveSession(tagged as never);
    expect(tagged.seen).toHaveLength(0);
  });

  it('drops a tagged marker no live session owns', () => {
    const a = session('sess-a');
    const p = providerWith(a);

    p.onStdoutLine('[mlx] Prefill:  10%|          | 200/2048 [batched] cache=sess-gone');

    expect(a.seen).toHaveLength(0);
  });
});

describe('the sidecar/parser format contract', () => {
  it('the emitter stamps each marker with its own sub and total', () => {
    // Nothing type-checks across the two languages: the sidecar's print and
    // the parser's regex have to agree by hand. Per-sub totals matter as much
    // as the tag — the old marker summed the whole wave, so even correctly
    // routed it would have shown one session the other's token count.
    const sidecar = readFileSync(
      join(import.meta.dirname, 'python', 'gezel_mlx_server.py'),
      'utf8',
    );
    const emitter = sidecar.slice(sidecar.indexOf('def _emit_prefill_liveness'));
    expect(emitter).toContain('[batched]{tag}');
    expect(emitter).toMatch(/tag = f" cache=\{cache_id\}" if cache_id else ""/);
    expect(emitter).toContain('self._prefill_meta.items()');
    // The untagged aggregate stays as the fallback, so a sidecar that cannot
    // name the owner still feeds the watchdog.
    expect(emitter).toContain('if not self._prefill_meta:');
  });
});
