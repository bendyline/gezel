import { describe, expect, it } from 'vitest';
import { TOOL_DISPLAY_NAMES, toolDisplayName } from './tool-display.js';

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
