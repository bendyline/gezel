import { describe, expect, it } from 'vitest';
import { AnthropicCliProvider } from './anthropic-cli/provider.js';
import { CodexCliProvider } from './codex-cli/provider.js';
import { CopilotProvider } from './copilot.js';
import { ExternalToolsUnsupportedError, type LLMProvider, type SessionOpts } from './types.js';

/**
 * Providers that can't advertise-but-not-execute caller-supplied tools
 * must refuse `SessionOpts.externalTools` loudly at createSession —
 * BEFORE binary/SDK resolution, so the rejection doesn't depend on a
 * working install. Without these guards a `/v1/chat/completions`
 * request with `tools` routed to one of these providers returns plain
 * text with no tool calls and no error (the silent failure the route
 * layer promises not to have; the route also checks
 * `supportsExternalTools` — this is the defense-in-depth layer).
 */
const OPTS_WITH_TOOLS: SessionOpts = {
  systemMessage: 'be helpful',
  externalTools: [{ name: 'do_thing', parameters: { type: 'object', properties: {} } }],
};

describe('providers without external-tools support reject them at createSession', () => {
  it('CopilotProvider', async () => {
    const provider: LLMProvider = new CopilotProvider({});
    await expect(provider.createSession(OPTS_WITH_TOOLS)).rejects.toBeInstanceOf(
      ExternalToolsUnsupportedError,
    );
    expect(provider.supportsExternalTools).toBeUndefined();
  });

  it('AnthropicCliProvider', async () => {
    const provider: LLMProvider = new AnthropicCliProvider({ runtimeDir: '/tmp/unused' });
    await expect(provider.createSession(OPTS_WITH_TOOLS)).rejects.toBeInstanceOf(
      ExternalToolsUnsupportedError,
    );
    expect(provider.supportsExternalTools).toBeUndefined();
  });

  it('CodexCliProvider', async () => {
    const provider: LLMProvider = new CodexCliProvider({ runtimeDir: '/tmp/unused' });
    await expect(provider.createSession(OPTS_WITH_TOOLS)).rejects.toBeInstanceOf(
      ExternalToolsUnsupportedError,
    );
    expect(provider.supportsExternalTools).toBeUndefined();
  });
});
