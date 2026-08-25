import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  statuses: new Map<string, string>(),
  calls: [] as string[],
  fail: false,
}));

vi.mock('../api.js', () => ({
  api: {
    getTaskByRef: async (ref: string) => {
      state.calls.push(ref);
      if (state.fail) throw new Error('offline');
      return { ref, status: state.statuses.get(ref) ?? 'active' };
    },
  },
}));

const { useFinishedTaskRefs } = await import('./useFinishedTaskRefs.js');

describe('useFinishedTaskRefs', () => {
  beforeEach(() => {
    state.statuses = new Map();
    state.calls = [];
    state.fail = false;
  });

  it('reports the settled refs and leaves live ones out', async () => {
    state.statuses.set('p1/1', 'complete');
    state.statuses.set('p1/2', 'canceled');
    state.statuses.set('p1/3', 'paused');
    const { result } = renderHook(() => useFinishedTaskRefs(['p1/1', 'p1/2', 'p1/3']));
    await waitFor(() => expect(result.current.size).toBe(2));
    expect([...result.current].sort()).toEqual(['p1/1', 'p1/2']);
  });

  it('asks about each ref once, even as the caller rebuilds the array', async () => {
    state.statuses.set('p1/1', 'complete');
    const { result, rerender } = renderHook(({ refs }) => useFinishedTaskRefs(refs), {
      initialProps: { refs: ['p1/1'] },
    });
    await waitFor(() => expect(result.current.has('p1/1')).toBe(true));
    rerender({ refs: ['p1/1'] });
    await waitFor(() => expect(state.calls).toEqual(['p1/1']));
  });

  it('fails open — an unreadable task keeps its pill', async () => {
    state.fail = true;
    const { result } = renderHook(() => useFinishedTaskRefs(['p1/1']));
    await waitFor(() => expect(state.calls).toEqual(['p1/1']));
    expect(result.current.size).toBe(0);
  });

  it('re-asks about an unsettled task when the reset key bumps', async () => {
    state.statuses.set('p1/1', 'paused');
    const { result, rerender } = renderHook(({ key }) => useFinishedTaskRefs(['p1/1'], key), {
      initialProps: { key: 0 },
    });
    await waitFor(() => expect(state.calls).toEqual(['p1/1']));
    state.statuses.set('p1/1', 'complete');
    rerender({ key: 1 });
    await waitFor(() => expect(result.current.has('p1/1')).toBe(true));
    expect(state.calls).toEqual(['p1/1', 'p1/1']);
  });

  it('keeps a settled verdict across a reset instead of re-reading it', async () => {
    state.statuses.set('p1/1', 'complete');
    const { result, rerender } = renderHook(({ key }) => useFinishedTaskRefs(['p1/1'], key), {
      initialProps: { key: 0 },
    });
    await waitFor(() => expect(result.current.has('p1/1')).toBe(true));
    rerender({ key: 1 });
    await waitFor(() => expect(result.current.has('p1/1')).toBe(true));
    expect(state.calls).toEqual(['p1/1']);
  });
});
