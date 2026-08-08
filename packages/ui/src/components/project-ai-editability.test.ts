import type { GezelSummary } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';
import {
  type AiProviderEditabilityConfig,
  projectEditableViaAiProvider,
  projectUsesCodex,
} from './project-ai-editability.js';

function gezel(id: string, overrides: Partial<GezelSummary> = {}): GezelSummary {
  return {
    id,
    name: id,
    updatedAt: '2026-08-07T00:00:00.000Z',
    ...overrides,
  };
}

function editable(
  config: AiProviderEditabilityConfig,
  globalGezels: GezelSummary[] = [],
  gezelIds: string[] = [],
  localGezels: GezelSummary[] = [],
): boolean {
  return projectEditableViaAiProvider({ gezelIds }, globalGezels, localGezels, config);
}

describe('projectEditableViaAiProvider', () => {
  it('treats an editable Codex or Claude CLI install default as implicit edit access', () => {
    expect(editable({ provider: 'codex-cli' })).toBe(true);
    expect(editable({ provider: 'anthropic-cli' })).toBe(true);
  });

  it('keeps explicit CLI plan mode read-only', () => {
    expect(editable({ provider: 'codex-cli', codexCli: { defaultPermissionMode: 'plan' } })).toBe(
      false,
    );
    expect(
      editable(
        {
          provider: 'ollama',
          anthropicCli: { defaultPermissionMode: 'acceptEdits' },
        },
        [gezel('claude', { provider: 'anthropic-cli', claudePermissionMode: 'plan' })],
        ['claude'],
      ),
    ).toBe(false);
  });

  it('lets the project Codex posture override install and legacy gezel defaults', () => {
    expect(
      projectEditableViaAiProvider({ gezelIds: [], codexPermissionMode: 'plan' }, [], [], {
        provider: 'codex-cli',
        codexCli: { defaultPermissionMode: 'full' },
      }),
    ).toBe(false);
    expect(
      projectEditableViaAiProvider({ gezelIds: [], codexPermissionMode: 'reviewed' }, [], [], {
        provider: 'codex-cli',
        codexCli: { defaultPermissionMode: 'plan' },
      }),
    ).toBe(true);
  });

  it('detects an assigned gezel override without counting unassigned gezels', () => {
    const config = { provider: 'ollama' } satisfies AiProviderEditabilityConfig;
    const codex = gezel('codex', { provider: 'codex-cli' });
    expect(editable(config, [codex])).toBe(false);
    expect(editable(config, [codex], ['codex'])).toBe(true);
  });

  it('detects project-local CLI gezels', () => {
    expect(
      editable(
        { provider: 'llama-cpp' },
        [],
        [],
        [gezel('local-claude', { provider: 'anthropic-cli' })],
      ),
    ).toBe(true);
  });

  it('only treats Copilot as implicit edit access when its built-in tools are enabled', () => {
    expect(editable({ provider: 'copilot', sandboxCopilot: true })).toBe(false);
    expect(editable({ provider: 'copilot', sandboxCopilot: false })).toBe(true);
    expect(
      editable(
        { provider: 'ollama', sandboxCopilot: true },
        [gezel('copilot', { provider: 'copilot', sandboxCopilot: false })],
        ['copilot'],
      ),
    ).toBe(true);
  });

  it('ignores fixed-function gezels because they do not run their configured provider', () => {
    expect(
      editable(
        { provider: 'ollama' },
        [
          gezel('renderer', {
            provider: 'codex-cli',
            fixedFunction: { tool: 'render_image', promptKey: 'prompt' },
          }),
        ],
        ['renderer'],
      ),
    ).toBe(false);
  });
});

describe('projectUsesCodex', () => {
  it('detects the install default and assigned Codex overrides', () => {
    expect(projectUsesCodex({ gezelIds: [] }, [], [], { provider: 'codex-cli' })).toBe(true);
    expect(
      projectUsesCodex(
        { gezelIds: ['builder'] },
        [gezel('builder', { provider: 'codex-cli' })],
        [],
        { provider: 'ollama' },
      ),
    ).toBe(true);
  });

  it('ignores unassigned and fixed-function Codex gezels', () => {
    const codex = gezel('codex', { provider: 'codex-cli' });
    const renderer = gezel('renderer', {
      provider: 'codex-cli',
      fixedFunction: { tool: 'render_image', promptKey: 'prompt' },
    });
    expect(projectUsesCodex({ gezelIds: [] }, [codex], [], { provider: 'ollama' })).toBe(false);
    expect(
      projectUsesCodex({ gezelIds: ['renderer'] }, [renderer], [], { provider: 'ollama' }),
    ).toBe(false);
  });
});
