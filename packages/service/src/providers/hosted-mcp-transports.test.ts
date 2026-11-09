import { describe, expect, it } from 'vitest';
import { providerCanReachHostedMcp } from './hosted-mcp-transports.js';

describe('providerCanReachHostedMcp', () => {
  it('reaches Streamable HTTP from every provider', () => {
    for (const provider of ['copilot', 'anthropic-cli', 'codex-cli', 'openai', 'mlx', undefined]) {
      expect(providerCanReachHostedMcp(provider, 'streamable-http')).toBe(true);
    }
  });

  it('reaches SSE from every provider except Codex', () => {
    for (const provider of ['copilot', 'anthropic-cli', 'openai', 'anthropic', 'llama-cpp']) {
      expect(providerCanReachHostedMcp(provider, 'sse')).toBe(true);
    }
    expect(providerCanReachHostedMcp('codex-cli', 'sse')).toBe(false);
  });
});
