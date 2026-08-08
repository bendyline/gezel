import { describe, expect, it } from 'vitest';
import { prettifyToolName, stripMcpPrefix, toolActivityLabel } from './tool-names.js';

describe('stripMcpPrefix', () => {
  it('strips the gezel-mcp wire prefix', () => {
    expect(stripMcpPrefix('mcp__gezel__save_memory')).toBe('save_memory');
    expect(stripMcpPrefix('mcp__gezel__list_projects')).toBe('list_projects');
  });

  it('handles server names with embedded single underscores', () => {
    expect(stripMcpPrefix('mcp__playwright_mcp__browser_navigate')).toBe('browser_navigate');
  });

  it('passes through Claude built-ins unchanged', () => {
    expect(stripMcpPrefix('Bash')).toBe('Bash');
    expect(stripMcpPrefix('Read')).toBe('Read');
    expect(stripMcpPrefix('TodoWrite')).toBe('TodoWrite');
  });

  it('passes through bare gezel-mcp tool names unchanged', () => {
    // When tools are referenced without the wire prefix (e.g. inside our
    // own bridge or from logs), there's nothing to strip.
    expect(stripMcpPrefix('save_memory')).toBe('save_memory');
    expect(stripMcpPrefix('ask_user_question')).toBe('ask_user_question');
  });

  it('returns malformed prefix-only inputs unchanged', () => {
    expect(stripMcpPrefix('mcp__only_one')).toBe('mcp__only_one');
    expect(stripMcpPrefix('mcp__')).toBe('mcp__');
  });
});

describe('prettifyToolName', () => {
  it('strips prefix AND humanizes underscores', () => {
    expect(prettifyToolName('mcp__gezel__read_task_notes')).toBe('read task notes');
    expect(prettifyToolName('mcp__playwright_mcp__browser_navigate')).toBe('browser navigate');
  });

  it('humanizes bare names', () => {
    expect(prettifyToolName('save_memory')).toBe('save memory');
    expect(prettifyToolName('list_artifacts')).toBe('list artifacts');
  });

  it('leaves Claude built-ins as-is (no underscores to humanize)', () => {
    expect(prettifyToolName('Bash')).toBe('Bash');
    expect(prettifyToolName('TodoWrite')).toBe('TodoWrite');
  });
});

describe('toolActivityLabel', () => {
  it('keeps the concrete Gezel tool name visible', () => {
    expect(toolActivityLabel('mcp__gezel__advance_task_step')).toBe('advance task step');
  });

  it('turns provider implementation buckets into human activity', () => {
    expect(toolActivityLabel('shell')).toBe('running a command');
    expect(toolActivityLabel('file_change')).toBe('updating files');
    expect(toolActivityLabel('web_search')).toBe('searching the web');
    expect(toolActivityLabel('mcp_tool_call')).toBe('working');
  });
});
