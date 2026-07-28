import { describe, expect, it } from 'vitest';
import { FILE_MUTATION_TOOLS, SessionTelemetryTracker } from './session-telemetry.js';

const scope = (sessionId: string) => ({ sessionId, gezelId: 'g1', projectId: 'p1' });

describe('SessionTelemetryTracker', () => {
  it('accumulates stream + tool counters across turns within a session', () => {
    const t = new SessionTelemetryTracker();
    t.noteTurnStart(scope('s1'));
    t.noteDelta('s1', 10);
    t.noteDelta('s1', 5);
    t.noteWirePulse('s1');
    t.noteHeartbeat('s1');
    t.noteEnginePhase('s1', 'prefill');
    t.noteEnginePhase('s1', 'generating');
    t.noteToolCall('s1', { name: 'read_file', args: { path: 'a.txt' } });
    t.noteToolCall('s1', { name: 'write_file', args: { path: 'a.txt', content: 'x'.repeat(50) } });
    t.noteTurnEnd('s1');
    t.noteTurnStart(scope('s1'));
    t.noteDelta('s1', 3);

    const snap = t.snapshot('s1', true);
    expect(snap).not.toBeNull();
    expect(snap?.turnsStarted).toBe(2);
    expect(snap?.deltaChunks).toBe(3);
    expect(snap?.streamedContentChars).toBe(18);
    expect(snap?.wirePulses).toBe(1);
    expect(snap?.heartbeats).toBe(1);
    expect(snap?.enginePhaseEvents).toBe(2);
    expect(snap?.generationSpurts).toBe(1);
    expect(snap?.toolCalls).toBe(2);
    expect(snap?.toolArgChars).toBeGreaterThan(50);
    expect(snap?.fileMutations).toBe(1);
    expect(snap?.inflight).toBe(true);
    expect(snap?.lastProgressAt).not.toBeNull();
  });

  it('scopes currentTurn to the running turn and nulls it at turn end', () => {
    const t = new SessionTelemetryTracker();
    t.noteTurnStart(scope('s1'));
    t.noteDelta('s1', 4);
    t.noteToolCall('s1', { name: 'write_file', args: { path: 'x' } });
    expect(t.snapshot('s1', true)?.currentTurn).toMatchObject({
      streamedContentChars: 4,
      toolCalls: 1,
      fileMutations: 1,
    });
    t.noteTurnEnd('s1');
    expect(t.snapshot('s1', false)?.currentTurn).toBeNull();
    t.noteTurnStart(scope('s1'));
    expect(t.snapshot('s1', true)?.currentTurn).toMatchObject({
      streamedContentChars: 0,
      toolCalls: 0,
      fileMutations: 0,
    });
  });

  it('classifies exactly the mutation tool set as file mutations', () => {
    const t = new SessionTelemetryTracker();
    t.noteTurnStart(scope('s1'));
    for (const name of FILE_MUTATION_TOOLS) t.noteToolCall('s1', { name });
    t.noteToolCall('s1', { name: 'read_file' });
    t.noteToolCall('s1', { name: 'delete_path' });
    const snap = t.snapshot('s1', true);
    expect(snap?.fileMutations).toBe(FILE_MUTATION_TOOLS.size);
    expect(snap?.toolCalls).toBe(FILE_MUTATION_TOOLS.size + 2);
  });

  it('tracks gpu task lifecycle as an active flag', () => {
    const t = new SessionTelemetryTracker();
    t.noteTurnStart(scope('s1'));
    t.noteGpuSwap('s1', 'started', 'image_generation');
    expect(t.snapshot('s1', true)?.gpuTaskActive).toBe('image_generation');
    t.noteGpuSwap('s1', 'progress', 'image_generation');
    expect(t.snapshot('s1', true)?.gpuTaskActive).toBe('image_generation');
    t.noteGpuSwap('s1', 'ended', 'image_generation');
    const snap = t.snapshot('s1', true);
    expect(snap?.gpuTaskActive).toBeNull();
    expect(snap?.gpuEvents).toBe(3);
    expect(snap?.lastGpuActivityAt).not.toBeNull();
  });

  it('drops signals for sessions never started and after delete', () => {
    const t = new SessionTelemetryTracker();
    t.noteDelta('ghost', 100);
    t.noteToolCall('ghost', { name: 'write_file' });
    t.noteGpuSwap('ghost', 'started', 'image_generation');
    expect(t.snapshot('ghost', false)).toBeNull();

    t.noteTurnStart(scope('s1'));
    t.delete('s1');
    t.noteDelta('s1', 5);
    t.noteGpuSwap('s1', 'started', 'image_generation');
    expect(t.snapshot('s1', false)).toBeNull();
  });

  it('filters list() by project and gezel and marks inflight from the id set', () => {
    const t = new SessionTelemetryTracker();
    t.noteTurnStart({ sessionId: 's1', gezelId: 'g1', projectId: 'p1' });
    t.noteTurnStart({ sessionId: 's2', gezelId: 'g2', projectId: 'p2' });
    const all = t.list(new Set(['s2']));
    expect(all).toHaveLength(2);
    expect(all.find((s) => s.sessionId === 's2')?.inflight).toBe(true);
    expect(all.find((s) => s.sessionId === 's1')?.inflight).toBe(false);
    expect(t.list(new Set(), { projectId: 'p2' }).map((s) => s.sessionId)).toEqual(['s2']);
    expect(t.list(new Set(), { gezelId: 'g1' }).map((s) => s.sessionId)).toEqual(['s1']);
  });

  it('evicts the oldest-progress session at the cap', () => {
    const t = new SessionTelemetryTracker();
    for (let i = 0; i < 1000; i++) {
      t.noteTurnStart({ sessionId: `s${i}`, gezelId: 'g', projectId: 'p' });
    }
    t.noteDelta('s0', 1);
    t.noteTurnStart({ sessionId: 'overflow', gezelId: 'g', projectId: 'p' });
    expect(t.snapshot('overflow', false)).not.toBeNull();
    expect(t.snapshot('s0', false)).not.toBeNull();
    let tracked = 0;
    for (let i = 0; i < 1000; i++) if (t.snapshot(`s${i}`, false)) tracked++;
    expect(tracked).toBe(999);
  });

  it('survives non-serializable tool args', () => {
    const t = new SessionTelemetryTracker();
    t.noteTurnStart(scope('s1'));
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    t.noteToolCall('s1', { name: 'write_file', args: circular });
    const snap = t.snapshot('s1', true);
    expect(snap?.toolCalls).toBe(1);
    expect(snap?.fileMutations).toBe(1);
  });
});
