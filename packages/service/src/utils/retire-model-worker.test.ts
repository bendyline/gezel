import type { Worker } from 'node:worker_threads';
import { describe, expect, it, vi } from 'vitest';
import { retireModelWorker } from './retire-model-worker.js';

function fakeWorker() {
  const terminate = vi.fn(async () => 1);
  return { worker: { terminate } as unknown as Worker, terminate };
}

describe('retiring a model worker at shutdown', () => {
  it('terminates an idle worker at once', async () => {
    const { worker, terminate } = fakeWorker();
    expect(await retireModelWorker(worker, () => true, 1_000)).toBe(true);
    expect(terminate).toHaveBeenCalledOnce();
  });

  it('waits for in-flight work before terminating', async () => {
    // Terminating mid-run — or mid-load of onnxruntime — aborts the process.
    const { worker, terminate } = fakeWorker();
    let busy = true;
    setTimeout(() => {
      busy = false;
    }, 60);
    const retired = retireModelWorker(worker, () => !busy, 1_000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(terminate).not.toHaveBeenCalled();
    expect(await retired).toBe(true);
    expect(terminate).toHaveBeenCalledOnce();
  });

  it('never terminates a worker that is still busy when the wait runs out', async () => {
    const { worker, terminate } = fakeWorker();
    expect(await retireModelWorker(worker, () => false, 50)).toBe(false);
    expect(terminate).not.toHaveBeenCalled();
  });
});
