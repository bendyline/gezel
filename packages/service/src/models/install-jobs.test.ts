import { describe, expect, it, vi } from 'vitest';
import { buildChatModelInstallRegistries } from './install-jobs.js';

describe('chat model install jobs', () => {
  it('does not inspect or install an image reader when the caller suppresses companions', async () => {
    const readConfig = vi.fn();
    const recognition = {
      current: vi.fn(),
      reset: vi.fn(),
    };
    const llamaCppModels = {
      install: vi.fn(async function* () {
        yield { type: 'done' as const, id: 'chat-model' };
      }),
    };
    const registries = buildChatModelInstallRegistries({
      home: 'unused-when-companions-are-disabled',
      readConfig,
      llamaCppModels: llamaCppModels as never,
      ds4Models: { install: vi.fn() } as never,
      mlxModels: { install: vi.fn() } as never,
      recognition: recognition as never,
      onDone: vi.fn(),
    });
    const events: string[] = [];

    registries.llamaCpp.start('chat-model', {
      skipSha: false,
      includeMmproj: false,
      installCompanion: false,
    });
    registries.llamaCpp.subscribe('chat-model', (event) => events.push(event.type));

    await vi.waitFor(() => expect(registries.llamaCpp.get('chat-model')?.finished).toBe(true));
    expect(events).toEqual(['done']);
    expect(readConfig).not.toHaveBeenCalled();
    expect(recognition.current).not.toHaveBeenCalled();
  });
});
