import { describe, expect, it } from 'vitest';
import {
  type ToolInputContract,
  extractToolCallStringCorpus,
  lintPromptToolSchemaContract,
} from './prompt-tool-schema-contract.js';

const CONTRACTS: ToolInputContract[] = [
  {
    name: 'set_task_status',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        status: { type: 'string', enum: ['paused', 'active', 'complete', 'canceled'] },
      },
      required: ['ref', 'status'],
      additionalProperties: false,
    },
  },
  {
    name: 'write_file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_task',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        assignee: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['gezel', 'user'] },
            gezelId: { type: 'string' },
          },
          required: ['kind'],
          additionalProperties: false,
        },
      },
      required: ['project', 'assignee'],
      additionalProperties: false,
    },
  },
];

describe('lintPromptToolSchemaContract', () => {
  it('rejects a concrete enum value outside the registered JSON Schema', () => {
    const report = lintPromptToolSchemaContract({
      prompt: 'Close it with `set_task_status({ ref: "shop/1", status: "done" })`.',
      toolContracts: CONTRACTS,
    });

    expect(report.errors).toMatchObject([
      {
        rule: 'tool-example-schema-mismatch',
        tool: 'set_task_status',
      },
    ]);
    expect(report.errors[0]?.detail).toContain('"complete"');
  });

  it('rejects positional arguments for object-shaped MCP tools', () => {
    const report = lintPromptToolSchemaContract({
      prompt: 'Use `write_file("index.html", html)` to save it.',
      toolContracts: CONTRACTS,
    });

    expect(report.errors).toMatchObject([
      { rule: 'tool-example-argument-shape', tool: 'write_file' },
    ]);
  });

  it('validates native Python-style keyword calls as one MCP input object', () => {
    const report = lintPromptToolSchemaContract({
      prompt: "<|tool_call_start|>[write_file(path='notes.md', content='hello')]<|tool_call_end|>",
      toolContracts: CONTRACTS,
    });

    expect(report).toEqual({ errors: [], warnings: [] });
  });

  it('still catches bad keys in native Python-style keyword calls', () => {
    const report = lintPromptToolSchemaContract({
      prompt: "<|tool_call_start|>[write_file(filename='notes.md', body='hello')]<|tool_call_end|>",
      toolContracts: CONTRACTS,
    });

    expect(report.errors[0]?.detail).toContain('$.path is required');
    expect(report.errors[0]?.detail).toContain('$.filename is not an allowed property');
  });

  it('checks required and unknown object keys even when values are placeholders', () => {
    const report = lintPromptToolSchemaContract({
      prompt: 'Call `write_file({ filename, body })` now.',
      toolContracts: CONTRACTS,
    });

    expect(report.errors[0]?.detail).toContain('$.path is required');
    expect(report.errors[0]?.detail).toContain('$.content is required');
    expect(report.errors[0]?.detail).toContain('$.filename is not an allowed property');
  });

  it('accepts symbolic values while validating their surrounding shape', () => {
    const report = lintPromptToolSchemaContract({
      prompt: [
        'Call `write_file({ path, content })`.',
        'Then `set_task_status({ ref, status: "complete" })`.',
        'Create it with `create_task({ project, assignee: { kind: "gezel", gezelId } })`.',
      ].join('\n'),
      toolContracts: CONTRACTS,
    });

    expect(report).toEqual({ errors: [], warnings: [] });
  });

  it('accepts angle placeholders inside otherwise-valid examples', () => {
    const report = lintPromptToolSchemaContract({
      prompt: '`write_file({ path: "<deliverable>", content: <full_contents> })`',
      toolContracts: CONTRACTS,
    });

    expect(report.errors).toEqual([]);
  });

  it('does not reject an intentionally negative invalid-call example', () => {
    const report = lintPromptToolSchemaContract({
      prompt: 'Do not use `write_file("index.html")`; use the object schema instead.',
      toolContracts: CONTRACTS,
    });

    expect(report.errors).toEqual([]);
  });
});

describe('extractToolCallStringCorpus', () => {
  it('extracts model-facing string and template bodies but ignores comments', () => {
    const entries = extractToolCallStringCorpus({
      sourceText: [
        '// write_file("comment-only")',
        'const plain = "set_task_status({ ref: \\"p/1\\", status: \\"complete\\" })";',
        'const dynamic = `write_file({ path: "${path}", content })`;',
      ].join('\n'),
      toolNames: ['set_task_status', 'write_file'],
    });

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ line: 2 });
    expect(entries[1]?.text).toContain('__GEZEL_SCHEMA_PLACEHOLDER__');
  });
});
