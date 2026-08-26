import { describe, expect, it } from 'vitest';
import {
  capabilitySafeCorrectivePrompt,
  filterPromptToolDirectives,
  lintPromptToolContract,
  promptMandatedTools,
} from './prompt-tool-contract.js';

describe('promptMandatedTools', () => {
  it('collects positively-instructed canonical tools', () => {
    const mandated = promptMandatedTools(
      'Use the PR number from the Scope note. Call `github_pr_diff` for the complete unified diff and `github_pr_files` for the per-file patches. Use `read_file` only when you need surrounding context.',
    );
    expect([...mandated].sort()).toEqual(['github_pr_diff', 'github_pr_files', 'read_file']);
  });

  it('excludes negative, conditional, and contrast mentions', () => {
    expect(
      promptMandatedTools('Do not modify source and do not call `github_pr_comment`.'),
    ).toEqual(new Set());
    expect(
      promptMandatedTools('If `run_nodejs_script` is available, use it for the conversion.'),
    ).toEqual(new Set());
    expect([
      ...promptMandatedTools('Use `read_file`, not `read_artifact`, for workspace paths.'),
    ]).toEqual(['read_file']);
  });

  it('ignores prose that merely names a non-tool identifier', () => {
    expect(promptMandatedTools('Update the `max_tokens` value in the config.')).toEqual(new Set());
  });

  // Wild-caught on powerpoint-deck `publish` (task default/8). The clause
  // is a plain imperative; the only negative word sits 145 characters
  // downstream describing what the user is spared. Vetoing on it dropped
  // the sole builtin the step mandated, and the deliverable step then had
  // no way to land its own output path.
  it('keeps a directive whose clause ends in a benefit phrase', () => {
    expect([
      ...promptMandatedTools(
        'Call `copy_artifact_to_workspace` with source `"tasks/8/deck.pptx"` and dest `"powerpoint/task-8/deck.pptx"` so the user receives the exact requested workspace file without a text/binary round-trip.',
      ),
    ]).toEqual(['copy_artifact_to_workspace']);
  });

  it('still drops a negation that governs the mention', () => {
    // Before the mention.
    expect(promptMandatedTools('Never call `write_file` during review.')).toEqual(new Set());
    expect([...promptMandatedTools('Use `read_file`; do not use `read_artifact`.')]).toEqual([
      'read_file',
    ]);
    // Immediately after it, as a predicate about the tool itself.
    expect(promptMandatedTools('Use `run_nodejs_script` — it is not available here.')).toEqual(
      new Set(),
    );
    expect(promptMandatedTools('Call `apply_patch`, which is unavailable on this roster.')).toEqual(
      new Set(),
    );
  });
});

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

  it('partialRoster suppresses unknown-name noise but keeps registry findings', () => {
    // Cold path: third-party bridge tools have no names yet, so a truthful
    // `browser_navigate` mention must not be reported as unknown.
    const prompt = 'Call `browser_navigate({ url })` to open the page, then call `write_file`.';
    expect(
      lintPromptToolContract({ prompt, availableTools: ['read_file'] }).errors.map((e) => e.rule),
    ).toContain('unknown-tool-name');

    const partial = lintPromptToolContract({
      prompt,
      availableTools: ['read_file'],
      partialRoster: true,
    });
    expect(partial.errors.some((e) => e.rule === 'unknown-tool-name')).toBe(false);
    // A registry tool that is genuinely off the roster still reports.
    expect([...partial.errors, ...partial.warnings].some((f) => f.tool === 'write_file')).toBe(
      true,
    );
  });

  it('toolDescription treats call-shaped names as tool references', () => {
    // In a tool description the surrounding context already establishes that
    // a call-shaped name is a tool, so an unknown one is a fabrication risk
    // even without a call/invoke cue.
    const prose = 'Complements fetch_entries(path), which returns raw rows.';
    const asProse = lintPromptToolContract({ prompt: prose, availableTools: [] });
    const asDescription = lintPromptToolContract({
      prompt: prose,
      availableTools: [],
      toolDescription: true,
    });

    expect(asProse).toEqual({ errors: [], warnings: [] });
    expect(asDescription.errors).toEqual([
      expect.objectContaining({ rule: 'unknown-tool-name', tool: 'fetch_entries' }),
    ]);
  });

  it('toolDescription keeps known and negatively-referenced tools unflagged', () => {
    const report = lintPromptToolContract({
      prompt: 'Use read_file(path) for workspace files; do not use fetch_rows(query) here.',
      availableTools: ['read_file'],
      toolDescription: true,
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

  it('never preserves a corrective mandate for a tool absent from the live roster', () => {
    const prompt = capabilitySafeCorrectivePrompt({
      prompt: 'Call `start_project` now and only report success after it returns.',
      availableTools: ['invoke_craftbook'],
    });

    expect(prompt).not.toContain('start_project');
    expect(lintPromptToolContract({ prompt, availableTools: ['invoke_craftbook'] })).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it('keeps a corrective directive when its tool is live', () => {
    const prompt = 'Call `invoke_craftbook` now and only report success after it returns.';
    expect(capabilitySafeCorrectivePrompt({ prompt, availableTools: ['invoke_craftbook'] })).toBe(
      prompt,
    );
  });
});
