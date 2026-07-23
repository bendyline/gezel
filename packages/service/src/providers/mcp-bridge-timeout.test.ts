import { describe, expect, it } from 'vitest';
import { DEFAULT_TOOL_TIMEOUT_MS, timeoutForTool } from './mcp-bridge.js';

describe('timeoutForTool', () => {
  it('gives every role-typed synchronous consultation the long ask ceiling', () => {
    expect(timeoutForTool('consult_developer')).toBe(35 * 60 * 1000);
    expect(timeoutForTool('consult_reviewer')).toBe(35 * 60 * 1000);
    expect(timeoutForTool('consult_image_generator')).toBe(35 * 60 * 1000);
  });

  it('keeps ordinary tools on the default timeout', () => {
    expect(timeoutForTool('readFile')).toBe(DEFAULT_TOOL_TIMEOUT_MS);
  });
});
