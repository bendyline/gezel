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

  it('rejects directives for compatibility-only tools', () => {
    const report = lintPromptToolContract({
      prompt: 'Use `start_job({ name })` for a small build.',
      availableTools: ['start_project'],
    });

    expect(report.errors).toMatchObject([
      { rule: 'non-model-facing-tool-name', tool: 'start_job' },
    ]);
  });

  it('rejects hidden aliases even when compatibility dispatch still accepts them', () => {
    const report = lintPromptToolContract({
      prompt: [
        'Call `run_script({ name: "verify" })` after writing the file.',
        'Do not call `search_files`; prefer deterministic retrieval.',
      ].join('\n'),
      availableTools: ['run_installed_script', 'grep_files'],
    });

    expect(report.errors).toMatchObject([
      { rule: 'legacy-tool-name', tool: 'run_script' },
      { rule: 'legacy-tool-name', tool: 'search_files' },
    ]);
  });

  it('rejects explicit unknown tool spellings but ignores argument keys', () => {
    const report = lintPromptToolContract({
      prompt: [
        'Call `listAudioVoices` via the UI, then use `synthesize_speech`.',
        'This tool does not edit the graph; modify steps via add_task_step / advance_task_step / update_task_step.',
        'Call `read_file({ path, startLine, endLine })` for the returned range.',
      ].join('\n'),
      availableTools: ['synthesize_speech', 'add_task_step', 'advance_task_step', 'read_file'],
    });

    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'removed-tool-name', tool: 'listAudioVoices' }),
        expect.objectContaining({ rule: 'removed-tool-name', tool: 'update_task_step' }),
      ]),
    );
    expect(report.errors.some((finding) => finding.tool === 'startLine')).toBe(false);
    expect(report.errors.some((finding) => finding.tool === 'endLine')).toBe(false);
  });

  it('rejects bare imperative unknown and unavailable tool names', () => {
    const report = lintPromptToolContract({
      prompt: [
        'Call missing_project_tool now.',
        'Use another_missing_tool to continue.',
        'Call write-file now.',
        'Use draft_email tool now.',
      ].join('\n'),
      availableTools: [],
    });

    expect(report.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'unknown-tool-name', tool: 'missing_project_tool' }),
        expect.objectContaining({ rule: 'unknown-tool-name', tool: 'another_missing_tool' }),
        expect.objectContaining({ rule: 'unknown-tool-name', tool: 'write-file' }),
        expect.objectContaining({ rule: 'hard-directive-missing-tool', tool: 'draft_email' }),
      ]),
    );
  });

  it('distinguishes the Bash shell from an explicitly named Bash tool', () => {
    const ordinary = lintPromptToolContract({
      prompt: 'The Bash shell is widely installed. Do not use Bash for this workflow.',
      availableTools: [],
    });
    const explicit = lintPromptToolContract({
      prompt: 'Call Bash now, then invoke the Bash tool again.',
      availableTools: [],
    });

    expect(ordinary).toEqual({ errors: [], warnings: [] });
    expect(explicit.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: 'removed-tool-name', tool: 'Bash' }),
      ]),
    );
  });

  it('ignores negative and conditional references to canonical tools', () => {
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
