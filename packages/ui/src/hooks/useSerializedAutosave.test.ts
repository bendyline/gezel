import { describe, expect, it, vi } from 'vitest';
import { SerializedAutosaveController } from './useSerializedAutosave.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SerializedAutosaveController', () => {
  it('keeps an idle lane idle on a no-op update (editor mount emissions)', () => {
    const save = vi.fn<(value: string) => Promise<string>>();
    const controller = new SerializedAutosaveController({
      resourceKey: 'document:about.md',
      initialValue: 'original',
      save,
    });
    expect(controller.getSnapshot().phase).toBe('idle');

    // Editors re-emit their initial content at mount; a value equal to the
    // baseline must neither flash "saved" (no write ever happened) nor
    // schedule one.
    controller.update('original');
    expect(controller.getSnapshot()).toMatchObject({ phase: 'idle', dirty: false });
    expect(save).not.toHaveBeenCalled();

    // A real edit still dirties, and settling back after a save shows saved.
    controller.update('edited');
    expect(controller.getSnapshot().phase).toBe('dirty');
  });

  it('serializes requests and coalesces edits made while a save is in flight', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const save = vi
      .fn<(value: string) => Promise<string>>()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const controller = new SerializedAutosaveController({
      resourceKey: 'document:mission.md',
      initialValue: 'original',
      save,
    });

    controller.update('older edit');
    const drained = controller.flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenLastCalledWith('older edit');

    controller.update('newest edit');
    expect(save).toHaveBeenCalledTimes(1);

    first.resolve('older response');
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenLastCalledWith('newest edit');
    expect(controller.getAcknowledgedValue()).toBe('older edit');

    second.resolve('newest response');
    await expect(drained).resolves.toBe('newest response');
    expect(controller.getAcknowledgedValue()).toBe('newest edit');
    expect(controller.getSnapshot()).toMatchObject({ phase: 'saved', dirty: false, error: null });
  });

  it('does not acknowledge a failed write and retries the same dirty value', async () => {
    const save = vi
      .fn<(value: string) => Promise<string>>()
      .mockRejectedValueOnce(new Error('daemon unavailable'))
      .mockResolvedValueOnce('ok');
    const controller = new SerializedAutosaveController({
      resourceKey: 'gezel:g1:about',
      initialValue: 'original',
      save,
    });

    controller.update('unsaved');
    await expect(controller.flush()).rejects.toThrow('daemon unavailable');
    expect(controller.getAcknowledgedValue()).toBe('original');
    expect(controller.getDesiredValue()).toBe('unsaved');
    expect(controller.getSnapshot()).toMatchObject({ phase: 'error', dirty: true });

    await expect(controller.retry()).resolves.toBe('ok');
    expect(save).toHaveBeenNthCalledWith(2, 'unsaved');
    expect(controller.getAcknowledgedValue()).toBe('unsaved');
    expect(controller.getSnapshot()).toMatchObject({ phase: 'saved', dirty: false, error: null });
  });

  it('emits a saved event only for the latest value in a drain', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    const controller = new SerializedAutosaveController({
      resourceKey: 'project:p1:about',
      initialValue: 'original',
      save: vi
        .fn<(value: string) => Promise<string>>()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise),
    });
    const savedValues: string[] = [];
    controller.subscribe((_snapshot, event) => {
      if (event?.type === 'saved') savedValues.push(event.value);
    });

    controller.update('intermediate');
    const drained = controller.flush();
    controller.update('final');
    first.resolve('intermediate response');
    await vi.waitFor(() => expect(controller.getAcknowledgedValue()).toBe('intermediate'));
    expect(savedValues).toEqual([]);

    second.resolve('final response');
    await drained;
    expect(savedValues).toEqual(['final']);
  });

  it('keeps a revert dirty until it restores the acknowledged value after an in-flight save', async () => {
    const older = deferred<string>();
    const restore = deferred<string>();
    const save = vi
      .fn<(value: string) => Promise<string>>()
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => restore.promise);
    const controller = new SerializedAutosaveController({
      resourceKey: 'document:revert.md',
      initialValue: 'original',
      save,
    });

    controller.update('temporary edit');
    const drained = controller.flush();
    controller.update('original');

    expect(controller.getSnapshot()).toMatchObject({ phase: 'saving', dirty: true });
    expect(save).toHaveBeenCalledTimes(1);

    older.resolve('temporary response');
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save).toHaveBeenLastCalledWith('original');
    expect(controller.getSnapshot()).toMatchObject({ phase: 'saving', dirty: true });

    restore.resolve('restored response');
    await drained;
    expect(controller.getSnapshot()).toMatchObject({ phase: 'saved', dirty: false });
    expect(controller.getAcknowledgedValue()).toBe('original');
  });

  it('reasserts a reverted value after an ambiguous failure of the in-flight edit', async () => {
    const failedEdit = deferred<string>();
    const save = vi
      .fn<(value: string) => Promise<string>>()
      .mockImplementationOnce(() => failedEdit.promise)
      .mockResolvedValueOnce('restored');
    const controller = new SerializedAutosaveController({
      resourceKey: 'document:ambiguous-revert.md',
      initialValue: 'original',
      save,
    });

    controller.update('temporary edit');
    const failedDrain = controller.flush();
    controller.update('original');
    failedEdit.reject(new Error('response lost'));

    await expect(failedDrain).rejects.toThrow('response lost');
    expect(controller.getSnapshot()).toMatchObject({ phase: 'error', dirty: true });

    await controller.retry();
    expect(save).toHaveBeenNthCalledWith(2, 'original');
    expect(controller.getSnapshot()).toMatchObject({ phase: 'saved', dirty: false });
  });
});
