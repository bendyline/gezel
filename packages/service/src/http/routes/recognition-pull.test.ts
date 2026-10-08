import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { RecognitionPullEvent } from '../../providers/recognition/types.js';
import type { ServiceContext } from '../context.js';
import { recognitionRoutes } from './recognition.js';

/** A download that reports progress until released, then finishes. */
function slowPull() {
  let release!: () => void;
  const released = new Promise<void>((r) => {
    release = r;
  });
  const pullModel = vi.fn(async function* (id: string): AsyncIterable<RecognitionPullEvent> {
    yield { type: 'progress', bytesWritten: 10, totalBytes: 100 };
    await released;
    yield { type: 'progress', bytesWritten: 100, totalBytes: 100 };
    yield { type: 'done', id };
  });
  return { pullModel, release: () => release() };
}

function app(pullModel: ReturnType<typeof slowPull>['pullModel']) {
  const ctx = {
    recognition: { current: async () => ({ pullModel }) },
  } as unknown as ServiceContext;
  const a = new Hono();
  a.route('/', recognitionRoutes(ctx));
  return a;
}

async function events(res: Response): Promise<RecognitionPullEvent[]> {
  const text = await res.text();
  return text
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)) as RecognitionPullEvent);
}

describe('recognition model downloads', () => {
  it('runs one download per model, however many times it is started', async () => {
    const { pullModel, release } = slowPull();
    const a = app(pullModel);
    const id = 'granite-vision-4.1-4b-q4';

    const first = a.request(`/models/${id}/pull`, { method: 'POST' });
    const second = a.request(`/models/${id}/pull`, { method: 'POST' });
    await new Promise((r) => setTimeout(r, 20));
    release();

    const [one, two] = await Promise.all([first, second]);
    expect(pullModel).toHaveBeenCalledTimes(1);
    expect((await events(one)).at(-1)).toEqual({ type: 'done', id });
    expect((await events(two)).at(-1)).toEqual({ type: 'done', id });
  });

  it('cancels only when asked, not when the page goes away', async () => {
    const { pullModel } = slowPull();
    const a = app(pullModel);
    const id = 'granite-vision-4.1-4b-q4';

    const controller = new AbortController();
    void Promise.resolve(
      a.request(`/models/${id}/pull`, { method: 'POST', signal: controller.signal }),
    ).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();

    // Still running: a fresh start attaches instead of starting a second download.
    void Promise.resolve(a.request(`/models/${id}/pull`, { method: 'POST' })).catch(
      () => undefined,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(pullModel).toHaveBeenCalledTimes(1);

    const cancel = await a.request(`/models/${id}/pull`, { method: 'DELETE' });
    expect(await cancel.json()).toEqual({ cancelled: true });
  });
});
