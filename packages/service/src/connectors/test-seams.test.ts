import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The catalog contract sweep answers scripts' HTTP, MCP calls and Spectral
 * components' requests through three seams: `ScriptRunnerOptions.http`,
 * `ConnectorManagerOptions.resolveMcpServer` and `spectralReplay`. Any one
 * set in production would let something other than the real network answer
 * a connector, or skip the private-address check. The daemon is wired in one
 * file; it must never mention them.
 */
describe('connector test seams', () => {
  it('product-service never sets the HTTP, MCP or Spectral replay test seams', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'product-service.ts'), 'utf8');
    expect(source).not.toMatch(/resolveMcpServer/);
    expect(source).not.toMatch(/spectralReplay/);
    expect(source).not.toMatch(/new ScriptRunner\(\{[^}]*\bhttp\s*:/s);
  });
});
