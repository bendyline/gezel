import { describe, expect, it } from 'vitest';
import { CODEX_TOOL_GUIDE_MAX_LISTED, codexToolGuide, withCodexToolGuide } from './tool-guide.js';

describe('codexToolGuide', () => {
  const taskStep = [
    'mcp__gezel__read_artifact',
    'mcp__gezel__read_image_as_base64',
    'mcp__gezel__write_artifact',
    'mcp__gezel__advance_task_step',
  ];

  it('names a small roster as exec calls and asks for chained calls', () => {
    const guide = codexToolGuide(taskStep) ?? '';
    expect(guide).toContain('`tools.mcp__gezel__read_artifact`');
    expect(guide).toContain('`tools.mcp__gezel__advance_task_step`');
    expect(guide).toContain('no need to look them up in `ALL_TOOLS`');
    expect(guide).toContain('write the deliverable and then call `advance_task_step`');
    expect(guide).toContain('do not read it back');
  });

  it('gives only the naming rule for a large roster, and skips other servers', () => {
    const many = Array.from(
      { length: CODEX_TOOL_GUIDE_MAX_LISTED + 1 },
      (_, i) => `mcp__gezel__tool_${i}`,
    );
    const guide = codexToolGuide([...many, 'mcp__github__*']) ?? '';
    expect(guide).toContain('`await tools.mcp__gezel__<tool>({ ... })`');
    expect(guide).not.toContain('tool_0');
    expect(guide).not.toContain('github');
  });

  it('leaves instructions alone when no Gezel tool is wired', () => {
    expect(codexToolGuide([])).toBeNull();
    expect(codexToolGuide(['mcp__github__*'])).toBeNull();
    expect(withCodexToolGuide('Persona.', [])).toBe('Persona.');
    expect(withCodexToolGuide('Persona.\n', taskStep)).toMatch(
      /^Persona\.\n\n---\n\n### Calling Gezel tools\n/,
    );
  });
});
