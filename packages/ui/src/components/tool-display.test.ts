import { describe, expect, it } from 'vitest';
import {
  TOOL_DISPLAY_NAMES,
  TOOL_ERROR_SUMMARY_MAX,
  toolDisplayName,
  toolErrorSummary,
} from './tool-display.js';

describe('toolDisplayName', () => {
  it('shows a concrete Gezel MCP tool name across CLI wire formats', () => {
    expect(toolDisplayName('advance_task_step')).toBe('Advance task step');
    expect(toolDisplayName('mcp__gezel__advance_task_step')).toBe('Advance task step');
    expect(toolDisplayName('gezel-advance_task_step')).toBe('Advance task step');
    expect(toolDisplayName('mcp__gezel__add_task_step')).toBe('Add task step');
  });

  it('names the act rather than the function for jargon-shaped slugs', () => {
    expect(toolDisplayName('grep_files')).toBe('Search across files');
    expect(toolDisplayName('find_files')).toBe('Find files by name');
    expect(toolDisplayName('derive_file')).toBe('Compute a data file');
    expect(toolDisplayName('fetch_url')).toBe('Open a web page');
  });

  it('labels a CLI provider built-in the same as its Gezel equivalent', () => {
    expect(toolDisplayName('Grep')).toBe(toolDisplayName('grep_files'));
    expect(toolDisplayName('Read')).toBe(toolDisplayName('read_file'));
    expect(toolDisplayName('WebSearch')).toBe(toolDisplayName('web_search'));
  });

  it('generates both halves of every role delegation pair', () => {
    expect(toolDisplayName('delegate_developer')).toBe('Hand work to the developer');
    expect(toolDisplayName('consult_developer')).toBe('Ask the developer');
    expect(toolDisplayName('consult_meester')).toBe('Ask the Meester');
  });

  // The bug this file exists to prevent: an unmapped tool used to render as
  // a bare lowercase slug ("grep files") beside mapped ones ("Read file").
  it('capitalizes unknown concrete tools instead of showing a bare slug', () => {
    expect(toolDisplayName('future_gezel_tool')).toBe('Future gezel tool');
    expect(toolDisplayName('gezel-future_gezel_tool')).toBe('Future gezel tool');
    expect(toolDisplayName('mcp__docblocks__convert_document')).toBe('Convert document');
  });

  it('leaves proper nouns inside a label alone', () => {
    expect(toolDisplayName('run_nodejs_script')).toBe('Run Node.js script');
    expect(toolDisplayName('run_npx')).toBe('Run an npx command');
    expect(toolDisplayName('wikipedia_search')).toBe('Search Wikipedia');
  });

  it('starts every mapped label with a capital', () => {
    const lowercase = Object.entries(TOOL_DISPLAY_NAMES).filter(
      ([, label]) => label[0] !== label[0]!.toUpperCase(),
    );
    expect(lowercase).toEqual([]);
  });
});

describe('toolErrorSummary', () => {
  // The wild-caught case: a completion gate rejected a craftbook step and
  // the only trace in the thread was a red ✗ next to "Advance task step".
  const GATE_REJECTION = [
    '[gate_rejected] Step "scan" on squisq/5 was NOT completed — its gate rejected the work (attempt 1/6):',
    '',
    '- pr-review-coverage.json: reviewed 25 path(s), but the connector corpus contains 68.',
    ' Address these specifically, then call `advance_task_step` again.',
    'Retryable: true',
  ].join('\n');

  it('drops the machine code prefix and the retryable flag', () => {
    const summary = toolErrorSummary(GATE_REJECTION);
    expect(summary).not.toContain('[gate_rejected]');
    expect(summary).not.toContain('Retryable:');
    expect(summary).toContain('its gate rejected the work (attempt 1/6)');
    expect(summary).toContain('reviewed 25 path(s), but the connector corpus contains 68');
  });

  it("keeps the gate's line breaks so listed criteria stay readable", () => {
    expect(toolErrorSummary(GATE_REJECTION)).toContain('\n- pr-review-coverage.json');
  });

  it('bounds a long reason and marks the cut', () => {
    const summary = toolErrorSummary(`Rejected because ${'word '.repeat(200)}`);
    expect(summary.length).toBeLessThanOrEqual(TOOL_ERROR_SUMMARY_MAX + 1);
    expect(summary.endsWith('…')).toBe(true);
    // Cut on a word boundary, not mid-token.
    expect(summary).not.toMatch(/wor…$/);
  });

  it('cuts mid-token rather than losing most of the budget to one long word', () => {
    const summary = toolErrorSummary(`x ${'y'.repeat(400)}`);
    expect(summary.length).toBe(TOOL_ERROR_SUMMARY_MAX + 1);
  });

  it('leaves a short error untouched', () => {
    expect(toolErrorSummary('No such file: report.md')).toBe('No such file: report.md');
  });
});
