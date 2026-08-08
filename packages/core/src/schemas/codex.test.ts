import { describe, expect, it } from 'vitest';
import {
  CodexPermissionModeCompatSchema,
  CodexPermissionModeSchema,
  normalizeCodexPermissionMode,
} from './codex.js';

describe('Codex permission modes', () => {
  it('accepts the four current project postures', () => {
    for (const mode of ['plan', 'edit', 'reviewed', 'full'] as const) {
      expect(CodexPermissionModeSchema.parse(mode)).toBe(mode);
    }
  });

  it('keeps persisted legacy values readable and normalizes them', () => {
    expect(CodexPermissionModeCompatSchema.parse('acceptEdits')).toBe('acceptEdits');
    expect(normalizeCodexPermissionMode('default')).toBe('edit');
    expect(normalizeCodexPermissionMode('acceptEdits')).toBe('edit');
    expect(normalizeCodexPermissionMode('bypassPermissions')).toBe('full');
  });

  it('uses Edit as the safe, useful unset default', () => {
    expect(normalizeCodexPermissionMode(undefined)).toBe('edit');
  });
});
