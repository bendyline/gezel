import { describe, expect, it } from 'vitest';
import { filterPromptToolDirectives, lintPromptToolContract } from './prompt-tool-contract.js';

describe('lintPromptToolContract', () => {
  it('rejects a hard directive for a missing tool', () => {
    const report = lintPromptToolContract({
      prompt: 'Your first assistant action should be `write_file({ path, content })`.',
      availableTools: ['read_file'],
    });

    expect(report.errors).toMatchObject([
      { rule: 'hard-directive-missing-tool', tool: 'write_file' },
    ]);
  });

  it('keeps broader unavailable-tool recommendations as warnings', () => {
    const report = lintPromptToolContract({
      prompt: 'Use `read_task_notes` to recover the latest context.',
      availableTools: [],
    });

    expect(report.errors).toEqual([]);
    expect(report.warnings).toMatchObject([{ rule: 'directive-missing-tool' }]);
  });

  it('ignores negative and conditional references', () => {
    const report = lintPromptToolContract({
      prompt: [
        'Do not call `write_file`; it is not on your tool list.',
        'When `read_file` is available, use it for workspace files.',
      ].join('\n'),
      availableTools: [],
    });

    expect(report).toEqual({ errors: [], warnings: [] });
  });

  it('rejects a false file-capability denial', () => {
    const report = lintPromptToolContract({
      prompt: 'You have no file writing tools this turn.',
      availableTools: ['write_file'],
    });

    expect(report.errors).toMatchObject([{ rule: 'false-capability-denial' }]);
  });

  it('filters contradictory behavior lines while preserving truthful and negative guidance', () => {
    const prompt = [
      'Use `write_file` to create the deliverable.',
      'Call `read_file` before editing.',
      'Do not call `delete_path` for this task.',
    ].join('\n');

    expect(filterPromptToolDirectives({ prompt, availableTools: ['read_file'] })).toBe(
      'Call `read_file` before editing.\nDo not call `delete_path` for this task.',
    );
  });
});
