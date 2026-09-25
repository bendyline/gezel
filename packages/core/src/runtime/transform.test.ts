import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isSuspendMonitorRunning,
  resetSuspendClockForTests,
  startSuspendMonitor,
} from '../suspend-clock.js';
import {
  buildRewritePrompt,
  buildTransformPrompt,
  oneShotSystemMessage,
} from '../transform/index.js';
import type { PortableInference } from './product-service.js';
import {
  type PortableTransformTarget,
  portableRewriteText,
  portableTransformText,
} from './transform.js';

const target: PortableTransformTarget = {
  gezelId: 'configured-klerk',
  about: 'You are the configured editor. Keep the author’s voice.',
  providerId: 'llama-cpp',
  modelId: 'pinned-model',
  contextSize: 8192,
  maxTokens: 1024,
};
const opts = { mode: 'rewrite' as const, text: 'A rough paragraph.' };
function setup(generate: PortableInference['generate']) {
  const inference: PortableInference = {
    providers: vi.fn(async () => []),
    generate: vi.fn(generate),
    cancel: vi.fn(async () => {}),
  };
  const resolveKlerk = vi.fn(async () => target);
  return { inference, resolveKlerk };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
afterEach(() => {
  resetSuspendClockForTests();
  vi.useRealTimers();
});

describe('portable shared text transforms', () => {
  it('uses the configured persona, exact desktop prompt, pinned model and requested budgets', async () => {
    const { inference, resolveKlerk } = setup(async (request, delta) => {
      expect(request).toMatchObject({
        providerId: target.providerId,
        modelId: target.modelId,
        contextSize: 8192,
        maxTokens: 1024,
      });
      expect(request.messages).toEqual([
        { role: 'system', content: oneShotSystemMessage(target.about) },
        { role: 'user', content: buildTransformPrompt(opts) },
      ]);
      delta({ requestId: 'other-turn', delta: 'unrelated' });
      for (const text of ['<thi', 'nk>plan', '</think>', 'Clear ', 'paragraph.'])
        delta({ requestId: request.requestId, delta: text });
      return {
        text: '<think>private plan</think>\n```markdown\nClear paragraph.\n```',
        stopReason: 'stop',
      };
    });
    const thinking = vi.fn();
    const output = vi.fn();
    await expect(
      portableTransformText(inference, opts, {
        resolveKlerk,
        hooks: { onThinking: thinking, onOutput: output },
      }),
    ).resolves.toBe('Clear paragraph.');
    expect(thinking.mock.calls.flat().join('')).toBe('plan');
    expect(output.mock.calls.flat().join('')).toBe('Clear paragraph.');
    expect(inference.providers).not.toHaveBeenCalled();
    expect(inference.cancel).not.toHaveBeenCalled();
  });

  it('uses desktop persona framing and leaves an existing host suspension monitor running', async () => {
    vi.useFakeTimers();
    startSuspendMonitor();
    const baseline = vi.getTimerCount();
    const { inference } = setup(async (request) => {
      expect(request.messages[0]!.content).toBe(oneShotSystemMessage('Exact persona.'));
      return { text: 'Finished.', stopReason: 'stop' };
    });
    await expect(
      portableTransformText(inference, opts, {
        resolveKlerk: async () => ({ ...target, about: '  Exact persona.\n\n' }),
      }),
    ).resolves.toBe('Finished.');
    expect(isSuspendMonitorRunning()).toBe(true);
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it('preserves insert context and legacy complete-document rewrite prompts', async () => {
    const { inference, resolveKlerk } = setup(async () => ({
      text: 'Clean copy.',
      stopReason: 'stop',
    }));
    const insert = {
      mode: 'insert' as const,
      text: '',
      instruction: 'add a bridge',
      textBefore: 'Before.',
      textAfter: 'After.',
      context: 'about' as const,
    };
    await portableTransformText(inference, insert, { resolveKlerk });
    expect(vi.mocked(inference.generate).mock.calls[0]![0].messages[1]!.content).toBe(
      buildTransformPrompt(insert),
    );
    const legacy = { text: 'Whole document', isSelection: false, context: 'generic' as const };
    await portableRewriteText(inference, legacy, { resolveKlerk });
    expect(vi.mocked(inference.generate).mock.calls[1]![0].messages[1]!.content).toBe(
      buildRewritePrompt(legacy),
    );
    expect(buildRewritePrompt(legacy)).toContain('COMPLETE document');
  });

  it.each(['length', 'cancelled'] as const)(
    'never reports a %s partial result as a completed edit',
    async (stopReason) => {
      const { inference, resolveKlerk } = setup(async () => ({ text: 'Partial', stopReason }));
      await expect(portableTransformText(inference, opts, { resolveKlerk })).rejects.toThrow(
        stopReason === 'length' ? 'reply limit' : 'stopped',
      );
    },
  );

  it('does not resolve a persona or start inference for an already cancelled request', async () => {
    const { inference, resolveKlerk } = setup(async () => ({ text: '', stopReason: 'stop' }));
    const signal = AbortSignal.abort();
    await expect(
      portableTransformText(inference, opts, { resolveKlerk, signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(resolveKlerk).not.toHaveBeenCalled();
    expect(inference.generate).not.toHaveBeenCalled();
  });

  it('waits for native release on cancellation and ignores late deltas', async () => {
    const started = deferred<void>();
    const generation = deferred<{ text: string; stopReason: 'stop' }>();
    const release = deferred<void>();
    let emit!: Parameters<PortableInference['generate']>[1];
    let id = '';
    const { inference, resolveKlerk } = setup(async (request, delta) => {
      id = request.requestId;
      emit = delta;
      started.resolve();
      return generation.promise;
    });
    vi.mocked(inference.cancel).mockImplementation(() => release.promise);
    const controller = new AbortController();
    const output = vi.fn();
    let finished = false;
    const pending = portableTransformText(inference, opts, {
      resolveKlerk,
      signal: controller.signal,
      hooks: { onOutput: output },
    });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    void pending.catch(() => {
      finished = true;
    });
    await started.promise;
    controller.abort();
    await Promise.resolve();
    expect(inference.cancel).toHaveBeenCalledWith(id);
    expect(finished).toBe(false);
    emit({ requestId: id, delta: 'late text' });
    expect(output).not.toHaveBeenCalled();
    release.resolve();
    await assertion;
    generation.resolve({ text: 'late result', stopReason: 'stop' });
  });

  it('cancels the exact request at its deadline without retrying or changing models', async () => {
    vi.useFakeTimers();
    const started = deferred<void>();
    const generation = deferred<{ text: string; stopReason: 'stop' }>();
    const { inference, resolveKlerk } = setup(async () => {
      started.resolve();
      return generation.promise;
    });
    const pending = portableTransformText(inference, opts, {
      resolveKlerk,
      timeoutMs: 25,
      requestId: 'timed-transform',
    });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await started.promise;
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(inference.cancel).toHaveBeenCalledWith('timed-transform');
    expect(inference.generate).toHaveBeenCalledOnce();
    generation.resolve({ text: 'late result', stopReason: 'stop' });
  });

  it('credits device sleep before enforcing the remaining awake budget and disposes its clocks', async () => {
    vi.useFakeTimers();
    const started = deferred<void>();
    const generation = deferred<{ text: string; stopReason: 'stop' }>();
    const { inference, resolveKlerk } = setup(async () => {
      started.resolve();
      return generation.promise;
    });
    const pending = portableTransformText(inference, opts, {
      resolveKlerk,
      timeoutMs: 10_000,
      requestId: 'sleeping-transform',
    });
    const assertion = expect(pending).rejects.toThrow('the machine slept');
    await started.promise;
    await vi.advanceTimersByTimeAsync(3_000);
    vi.setSystemTime(Date.now() + 900_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(inference.cancel).not.toHaveBeenCalled();
    expect(isSuspendMonitorRunning()).toBe(true);
    await vi.advanceTimersByTimeAsync(7_000);
    await assertion;
    expect(inference.cancel).toHaveBeenCalledExactlyOnceWith('sleeping-transform');
    expect(isSuspendMonitorRunning()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    generation.resolve({ text: 'discard', stopReason: 'stop' });
  });

  it('still cancels immediately after device sleep and holds the engine release barrier', async () => {
    vi.useFakeTimers();
    const started = deferred<void>();
    const generation = deferred<{ text: string; stopReason: 'stop' }>();
    const release = deferred<void>();
    const { inference, resolveKlerk } = setup(async () => {
      started.resolve();
      return generation.promise;
    });
    vi.mocked(inference.cancel).mockImplementation(() => release.promise);
    const controller = new AbortController();
    let finished = false;
    const pending = portableTransformText(inference, opts, {
      resolveKlerk,
      signal: controller.signal,
      requestId: 'cancel-after-sleep',
    });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    void pending.catch(() => {
      finished = true;
    });
    await started.promise;
    vi.setSystemTime(Date.now() + 900_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(inference.cancel).not.toHaveBeenCalled();
    controller.abort();
    await Promise.resolve();
    expect(inference.cancel).toHaveBeenCalledExactlyOnceWith('cancel-after-sleep');
    expect(finished).toBe(false);
    expect(isSuspendMonitorRunning()).toBe(true);
    release.resolve();
    await assertion;
    expect(isSuspendMonitorRunning()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    generation.resolve({ text: 'discard', stopReason: 'stop' });
  });

  it('keeps admission held if cancellation fails until the native generation settles', async () => {
    const started = deferred<void>();
    const generation = deferred<{ text: string; stopReason: 'stop' }>();
    const { inference, resolveKlerk } = setup(async () => {
      started.resolve();
      return generation.promise;
    });
    vi.mocked(inference.cancel).mockRejectedValue(new Error('no release confirmation'));
    const controller = new AbortController();
    let finished = false;
    const pending = portableTransformText(inference, opts, {
      resolveKlerk,
      signal: controller.signal,
    });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    void pending.catch(() => {
      finished = true;
    });
    await started.promise;
    controller.abort();
    await Promise.resolve();
    await Promise.resolve();
    expect(finished).toBe(false);
    generation.resolve({ text: 'discard', stopReason: 'stop' });
    await assertion;
  });

  it('rejects oversized input before inference and propagates model errors without fallback', async () => {
    const { inference, resolveKlerk } = setup(async () => {
      throw new Error('Pinned model missing');
    });
    await expect(
      portableTransformText(inference, { ...opts, text: 'x'.repeat(256 * 1024) }, { resolveKlerk }),
    ).rejects.toThrow('input size');
    expect(inference.generate).not.toHaveBeenCalled();
    await expect(portableTransformText(inference, opts, { resolveKlerk })).rejects.toThrow(
      'Pinned model missing',
    );
    expect(inference.generate).toHaveBeenCalledOnce();
  });
});
