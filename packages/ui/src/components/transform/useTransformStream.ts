import type { TransformStreamEvent, TransformTextRequest } from '@bendyline/gezel';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';

export interface TransformStreamState {
  phase: 'idle' | 'queued' | 'streaming' | 'done' | 'error';
  /** Klerk metacommentary — reasoning deltas where the provider has them. */
  thinking: string;
  /** Live output preview. The `result` is authoritative, not this. */
  outputPreview: string;
  result: string | null;
  error: string | null;
}

const IDLE: TransformStreamState = {
  phase: 'idle',
  thinking: '',
  outputPreview: '',
  result: null,
  error: null,
};

function reduce(prev: TransformStreamState, event: TransformStreamEvent): TransformStreamState {
  switch (event.type) {
    case 'status':
      return { ...prev, phase: event.phase === 'queued' ? 'queued' : 'streaming' };
    case 'thinking-delta':
      return { ...prev, phase: 'streaming', thinking: prev.thinking + event.text };
    case 'output-delta':
      return { ...prev, phase: 'streaming', outputPreview: prev.outputPreview + event.text };
    case 'done':
      return { ...prev, phase: 'done', result: event.text };
    case 'error':
      return { ...prev, phase: 'error', error: event.error };
  }
}

/**
 * Drive one `POST /api/ai/transform` SSE run. Closing the dialog (unmount)
 * aborts the stream client-side; the server-side one-shot finishes in the
 * background queue — same contract as icon/about generation.
 */
export function useTransformStream(): {
  state: TransformStreamState;
  start: (body: TransformTextRequest) => void;
  reset: () => void;
} {
  const [state, setState] = useState<TransformStreamState>(IDLE);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback((body: TransformTextRequest) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setState({ ...IDLE, phase: 'streaming' });
    void api
      .transformTextStream(
        body,
        (event) => setState((prev) => reduce(prev, event)),
        controller.signal,
      )
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setState((prev) => ({
          ...prev,
          phase: 'error',
          error: err instanceof Error ? err.message : String(err),
        }));
      });
  }, []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setState(IDLE);
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  return { state, start, reset };
}
