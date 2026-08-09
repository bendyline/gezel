import { describe, expect, it } from 'vitest';
import { toolDisplayName } from './tool-display.js';

describe('toolDisplayName', () => {
  it('shows a concrete Gezel MCP tool name across CLI wire formats', () => {
    expect(toolDisplayName('advance_task_step')).toBe('Advance task step');
    expect(toolDisplayName('mcp__gezel__advance_task_step')).toBe('Advance task step');
    expect(toolDisplayName('gezel-advance_task_step')).toBe('Advance task step');
    expect(toolDisplayName('mcp__gezel__add_task_step')).toBe('Add task step');
  });

  it('keeps humanizing unknown concrete tools', () => {
    expect(toolDisplayName('future_gezel_tool')).toBe('future gezel tool');
    expect(toolDisplayName('gezel-future_gezel_tool')).toBe('future gezel tool');
  });
});
