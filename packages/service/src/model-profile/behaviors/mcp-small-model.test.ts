/**
 * Coverage for the two split MCP behaviors that were once
 * `GezelMcpSmallModelRelaxer`. Asserts the schema relaxation strips
 * the right fields and the auto-fill defaults satisfy the upstream
 * Zod min-length checks.
 */

import { describe, expect, it } from 'vitest';
import type { OpenAIFunctionTool } from '../../providers/mcp-bridge.js';
import type { McpToolWrapper, McpToolWrapperContext } from '../../providers/mcp-wrappers/types.js';
import { McpCompactToolSchemas } from './mcp-compact-tool-schemas.js';
import { McpDefaultMissingFields } from './mcp-default-missing-fields.js';
import { McpRelaxRequiredFields } from './mcp-relax-required-fields.js';

/**
 * The `mcpWrapper` field is `McpToolWrapper | factory` — for the
 * fields-fields behaviors it's always the static wrapper, so this
 * helper narrows the union for the tests.
 */
function staticWrapper(b: {
  mcpWrapper?: McpToolWrapper | ((c: never) => McpToolWrapper);
}): McpToolWrapper {
  if (!b.mcpWrapper) throw new Error('expected an mcpWrapper');
  if (typeof b.mcpWrapper === 'function')
    throw new Error('expected a static wrapper, got a factory');
  return b.mcpWrapper;
}

function wrapperFor(b: {
  mcpWrapper?: McpToolWrapper | ((c: never) => McpToolWrapper);
}): McpToolWrapper {
  if (!b.mcpWrapper) throw new Error('expected an mcpWrapper');
  return typeof b.mcpWrapper === 'function'
    ? (b.mcpWrapper as (c: never) => McpToolWrapper)(undefined as never)
    : b.mcpWrapper;
}

const STOCK_CTX = {
  spec: { kind: 'stdio' as const, command: 'node', args: [], env: {} },
  cwd: '/tmp',
  modelTier: 'tiny' as const,
  isMeester: false,
  hasTool: () => true,
  callTool: async () => ({ text: '', images: [] }),
} satisfies McpToolWrapperContext;

const STOCK_TOOLS: OpenAIFunctionTool[] = [
  {
    type: 'function',
    name: 'create_project',
    description: 'Create a new project',
    parameters: {
      type: 'object',
      required: ['name', 'about', 'missionObjectives'],
      properties: {
        name: { type: 'string' },
        about: { type: 'string' },
        missionObjectives: { type: 'string' },
      },
    },
  },
  {
    type: 'function',
    name: 'create_gezel',
    description: 'Create a new gezel',
    parameters: {
      type: 'object',
      properties: {
        role: { type: 'string' },
        about: { type: 'string' },
        templateId: { type: 'string' },
      },
    },
  },
  {
    type: 'function',
    name: 'create_task',
    description: 'Create a task',
    parameters: {
      type: 'object',
      required: ['title', 'description'],
      properties: { title: { type: 'string' }, description: { type: 'string' } },
    },
  },
  {
    type: 'function',
    name: 'start_project',
    description: 'Macro: create crew project + voorman + task + kickoff message',
    parameters: {
      type: 'object',
      required: ['name', 'about', 'missionObjectives', 'taskDescription'],
      properties: {
        name: { type: 'string' },
        about: { type: 'string' },
        missionObjectives: { type: 'string' },
        taskDescription: { type: 'string' },
      },
    },
  },
  {
    type: 'function',
    name: 'start_job',
    description: 'Macro: create solo job + ambachtsman + task + kickoff message',
    parameters: {
      type: 'object',
      required: ['name', 'about', 'missionObjectives', 'taskDescription', 'specialistRole'],
      properties: {
        name: { type: 'string' },
        about: { type: 'string' },
        missionObjectives: { type: 'string' },
        taskDescription: { type: 'string' },
        specialistRole: { type: 'string' },
      },
    },
  },
  {
    type: 'function',
    name: 'unrelated_tool',
    description: '...',
    parameters: { type: 'object', required: ['a', 'b'], properties: {} },
  },
];

describe('McpRelaxRequiredFields wrapper', () => {
  const wrapper = staticWrapper(McpRelaxRequiredFields);

  it('does NOT relax create_project (no longer model-facing — start_project is the entry point)', () => {
    const out = wrapper.decorateTools!(STOCK_TOOLS, STOCK_CTX);
    const cp = out.find((t) => t.name === 'create_project')!;
    expect((cp.parameters as Record<string, unknown>).required).toEqual([
      'name',
      'about',
      'missionObjectives',
    ]);
  });

  it('leaves create_gezel optional role/template semantics unchanged', () => {
    const out = wrapper.decorateTools!(STOCK_TOOLS, STOCK_CTX);
    const cg = out.find((t) => t.name === 'create_gezel')!;
    expect((cg.parameters as Record<string, unknown>).required).toBeUndefined();
  });

  it('strips description from create_task required', () => {
    const out = wrapper.decorateTools!(STOCK_TOOLS, STOCK_CTX);
    const ct = out.find((t) => t.name === 'create_task')!;
    expect((ct.parameters as Record<string, unknown>).required).toEqual(['title']);
  });

  it('strips about + missionObjectives + taskDescription from start_project required', () => {
    // The macro takes the same long-prose fields as create_project
    // plus a taskDescription. Tiny models that opt into this
    // behavior get a `start_project` schema where only `name`
    // remains required; the placeholders flow in via
    // `mcp.default-missing-fields`.
    const out = wrapper.decorateTools!(STOCK_TOOLS, STOCK_CTX);
    const sp = out.find((t) => t.name === 'start_project')!;
    expect((sp.parameters as Record<string, unknown>).required).toEqual(['name']);
  });

  it('strips long-prose fields from start_job but keeps `specialistRole` required', () => {
    // The solo macro requires the model to choose a specialist —
    // there's no sensible default for that. The other long-prose
    // fields auto-fill the same way `start_project` does.
    const out = wrapper.decorateTools!(STOCK_TOOLS, STOCK_CTX);
    const sj = out.find((t) => t.name === 'start_job')!;
    expect((sj.parameters as Record<string, unknown>).required).toEqual(['name', 'specialistRole']);
  });

  it('does not touch unrelated tools', () => {
    const out = wrapper.decorateTools!(STOCK_TOOLS, STOCK_CTX);
    const u = out.find((t) => t.name === 'unrelated_tool')!;
    expect((u.parameters as Record<string, unknown>).required).toEqual(['a', 'b']);
  });
});

describe('McpDefaultMissingFields wrapper', () => {
  const wrapper = staticWrapper(McpDefaultMissingFields);

  it('does NOT auto-fill create_project (no longer model-facing — start_project covers the case)', async () => {
    // The model can't see create_project anymore; if a direct
    // (non-model) caller invokes it the strict shape applies. The
    // wrapper only auto-fills tools the model emits.
    const verdict = await wrapper.preProcess!('create_project', { name: 'My Project' }, STOCK_CTX);
    expect(verdict.kind).toBe('allow');
    if (verdict.kind === 'allow') {
      expect(verdict.args).toBeUndefined();
    }
  });

  it('lets role-based create_gezel use its curated template when about is omitted', async () => {
    const verdict = await wrapper.preProcess!('create_gezel', { role: 'designer' }, STOCK_CTX);
    expect(verdict.kind).toBe('allow');
    if (verdict.kind === 'allow') {
      expect(verdict.args).toBeUndefined();
    }
  });

  it('preserves exact-template create_gezel calls without injecting a custom about', async () => {
    const verdict = await wrapper.preProcess!(
      'create_gezel',
      { templateId: 'designer' },
      STOCK_CTX,
    );
    expect(verdict.kind).toBe('allow');
    if (verdict.kind === 'allow') {
      expect(verdict.args).toBeUndefined();
    }
  });

  it('fills create_task description when missing', async () => {
    const verdict = await wrapper.preProcess!('create_task', { title: 't' }, STOCK_CTX);
    expect(verdict.kind).toBe('allow');
    if (verdict.kind === 'allow' && verdict.args) {
      expect(typeof verdict.args.description).toBe('string');
      expect((verdict.args.description as string).length).toBeGreaterThanOrEqual(40);
    }
  });

  it('fills write_file path for single-file HTML content when omitted', async () => {
    const verdict = await wrapper.preProcess!(
      'write_file',
      { content: '<!doctype html><html><body><script>console.log(1)</script></body></html>' },
      STOCK_CTX,
    );
    expect(verdict.kind).toBe('allow');
    if (verdict.kind === 'allow' && verdict.args) {
      expect(verdict.args.path).toBe('index.html');
      expect(verdict.args.content).toContain('<script>');
    }
  });

  it('fills write_file path for single-file HTML content when recovered path is punctuation', async () => {
    const verdict = await wrapper.preProcess!(
      'write_file',
      {
        path: ',',
        content: '<!doctype html><html><body><script>console.log(1)</script></body></html>',
      },
      STOCK_CTX,
    );
    expect(verdict.kind).toBe('allow');
    if (verdict.kind === 'allow' && verdict.args) {
      expect(verdict.args.path).toBe('index.html');
    }
  });

  it('fills write_file path for single-file HTML content when recovered path is a product name', async () => {
    const verdict = await wrapper.preProcess!(
      'write_file',
      {
        path: 'Premium Dog Kibble',
        content:
          '<!doctype html><html><body><h1>Pets</h1><script>console.log(1)</script></body></html>',
      },
      STOCK_CTX,
    );
    expect(verdict.kind).toBe('allow');
    if (verdict.kind === 'allow' && verdict.args) {
      expect(verdict.args.path).toBe('index.html');
      expect(verdict.args.content).toContain('<h1>Pets</h1>');
    }
  });

  it('keeps explicit HTML paths for single-file HTML content', async () => {
    const verdict = await wrapper.preProcess!(
      'write_file',
      {
        path: 'pages/landing.html',
        content:
          '<!doctype html><html><body><h1>Landing</h1><script>console.log(1)</script></body></html>',
      },
      STOCK_CTX,
    );
    expect(verdict.kind).toBe('allow');
    if (verdict.kind === 'allow') {
      expect(verdict.args).toBeUndefined();
    }
  });

  it('does not fill write_file path for non-HTML content', async () => {
    const verdict = await wrapper.preProcess!(
      'write_file',
      { content: 'export const x = 1;' },
      STOCK_CTX,
    );
    expect(verdict.kind).toBe('allow');
    if (verdict.kind === 'allow') {
      expect(verdict.args).toBeUndefined();
    }
  });

  it('repairs message_gezel target typo from Gezer to gezel', async () => {
    const verdict = await wrapper.preProcess!(
      'message_gezel',
      { Gezer: 'bilal', project: 'squisq-code-review', message: 'Please write review.md.' },
      STOCK_CTX,
    );
    expect(verdict.kind).toBe('allow');
    if (verdict.kind === 'allow' && verdict.args) {
      expect(verdict.args).toEqual({
        gezel: 'bilal',
        project: 'squisq-code-review',
        message: 'Please write review.md.',
      });
    }
  });

  it('repairs message_gezel legacy and capitalized argument names', async () => {
    const verdict = await wrapper.preProcess!(
      'message_gezel',
      {
        targetGezelId: 'bilal',
        Message: 'Please write review.md.',
        projectId: 'squisq-code-review',
      },
      STOCK_CTX,
    );
    expect(verdict.kind).toBe('allow');
    if (verdict.kind === 'allow' && verdict.args) {
      expect(verdict.args).toEqual({
        gezel: 'bilal',
        message: 'Please write review.md.',
        project: 'squisq-code-review',
      });
    }
  });

  it('fills expectedDeliverable.kind for role handoffs that clearly name a file path', async () => {
    const verdict = await wrapper.preProcess!(
      'delegate_voorman',
      {
        project: 'space-invaders-clone',
        task: 'Fix src/game.ts.',
        expectedDeliverable: { filePath: 'src/game.ts' },
      },
      STOCK_CTX,
    );
    expect(verdict.kind).toBe('allow');
    if (verdict.kind === 'allow' && verdict.args) {
      expect(verdict.args.expectedDeliverable).toEqual({
        kind: 'file',
        filePath: 'src/game.ts',
      });
    }
  });

  it.each([
    {
      label: 'file/filePath pseudo-check',
      expectedDeliverable: {
        kind: 'file',
        checks: [{ kind: 'file', filePath: 'plan.md' }],
      },
    },
    {
      label: 'generic-file/file pseudo-check',
      expectedDeliverable: {
        checks: [{ kind: 'generic-file', file: 'plan.md' }],
      },
    },
    {
      label: 'markdown-doc/file pseudo-check',
      expectedDeliverable: {
        checks: [{ kind: 'markdown-doc', file: 'plan.md' }],
      },
    },
  ])('recovers the captured nested $label handoff shape', async ({ expectedDeliverable }) => {
    const verdict = await wrapper.preProcess!(
      'message_gezel',
      {
        gezel: 'deepak',
        project: 'harbourview-office-relocation',
        message: 'Write plan.md.',
        expectedDeliverable,
      },
      STOCK_CTX,
    );

    expect(verdict.kind).toBe('allow');
    if (verdict.kind === 'allow' && verdict.args) {
      expect(verdict.args.expectedDeliverable).toEqual({
        kind: 'file',
        filePath: 'plan.md',
      });
    }
  });

  it('recovers the same nested file shape when the outer object is JSON-stringified', async () => {
    const verdict = await wrapper.preProcess!(
      'ask_gezel',
      {
        gezel: 'deepak',
        project: 'harbourview-office-relocation',
        question: 'Write plan.md.',
        expectedDeliverable: '{"checks":[{"kind":"markdown-doc","file":"plan.md"}]}',
      },
      STOCK_CTX,
    );

    expect(verdict.kind).toBe('allow');
    if (verdict.kind === 'allow' && verdict.args) {
      expect(verdict.args.expectedDeliverable).toEqual({
        kind: 'file',
        filePath: 'plan.md',
      });
    }
  });

  it('preserves a valid completion-gate check instead of flattening it', async () => {
    const expectedDeliverable = {
      kind: 'file' as const,
      filePath: 'plan.md',
      checks: [{ kind: 'minBytes' as const, file: 'plan.md', bytes: 100 }],
    };
    const verdict = await wrapper.preProcess!(
      'message_gezel',
      {
        gezel: 'deepak',
        message: 'Write plan.md.',
        expectedDeliverable,
      },
      STOCK_CTX,
    );

    expect(verdict.kind).toBe('allow');
    if (verdict.kind === 'allow' && verdict.args) {
      expect(verdict.args.expectedDeliverable).toEqual(expectedDeliverable);
    }
  });

  it.each([
    {
      label: 'multiple pseudo-checks',
      value: {
        checks: [
          { kind: 'file', filePath: 'plan.md' },
          { kind: 'file', filePath: 'notes.md' },
        ],
      },
    },
    {
      label: 'conflicting path aliases',
      value: {
        checks: [{ kind: 'file', filePath: 'plan.md', file: 'notes.md' }],
      },
    },
    {
      label: 'unknown pseudo-check kind',
      value: {
        checks: [{ kind: 'report-file', file: 'plan.md' }],
      },
    },
    {
      label: 'extra nested fields',
      value: {
        checks: [{ kind: 'file', file: 'plan.md', destination: '/tmp/plan.md' }],
      },
    },
  ])('rejects ambiguous nested deliverable shape: $label', async ({ value }) => {
    const verdict = await wrapper.preProcess!(
      'message_gezel',
      {
        gezel: 'deepak',
        message: 'Write plan.md.',
        expectedDeliverable: value,
      },
      STOCK_CTX,
    );

    expect(verdict.kind).toBe('reject');
    if (verdict.kind === 'reject') {
      expect(verdict.error).toContain('expectedDeliverable');
      expect(verdict.error).toContain('Do not put the file declaration inside `checks`');
    }
  });

  it('repairs observed expectedLeverage typo into expectedDeliverable', async () => {
    const verdict = await wrapper.preProcess!(
      'delegate_voorman',
      {
        project: 'space-invaders-clone',
        task: 'Fix src/game.ts.',
        expectedLeverage: { filePath: 'src/game.ts' },
      },
      STOCK_CTX,
    );
    expect(verdict.kind).toBe('allow');
    if (verdict.kind === 'allow' && verdict.args) {
      expect(verdict.args.expectedLeverage).toBeUndefined();
      expect(verdict.args.expectedDeliverable).toEqual({
        kind: 'file',
        filePath: 'src/game.ts',
      });
    }
  });

  it('repairs snake_case expected_deliverable into expectedDeliverable', async () => {
    const verdict = await wrapper.preProcess!(
      'delegate_meester',
      {
        project: 'space-invaders-clone',
        task: 'Fix src/game.ts.',
        expected_deliverable: { filePath: 'src/game.ts' },
      },
      STOCK_CTX,
    );
    expect(verdict.kind).toBe('allow');
    if (verdict.kind === 'allow' && verdict.args) {
      expect(verdict.args.expected_deliverable).toBeUndefined();
      expect(verdict.args.expectedDeliverable).toEqual({
        kind: 'file',
        filePath: 'src/game.ts',
      });
    }
  });

  it('rejects malformed expected deliverable aliases instead of silently dropping them', async () => {
    const verdict = await wrapper.preProcess!(
      'delegate_voorman',
      {
        project: 'space-invaders-clone',
        task: 'Fix src/game.ts.',
        expectedLeverage: 'not-json',
      },
      STOCK_CTX,
    );
    expect(verdict.kind).toBe('reject');
    if (verdict.kind === 'reject') {
      expect(verdict.error).toContain('expectedDeliverable');
    }
  });

  it('fills start_project about + missionObjectives + taskDescription when missing', async () => {
    // The macro is the small-model-friendly "build me X" path — name
    // alone is enough to call it; the auto-filler supplies the
    // long-prose fields so the upstream Zod min-lengths still pass.
    const verdict = await wrapper.preProcess!(
      'start_project',
      { name: 'Space Invaders' },
      STOCK_CTX,
    );
    expect(verdict.kind).toBe('allow');
    if (verdict.kind === 'allow' && verdict.args) {
      expect((verdict.args.about as string).length).toBeGreaterThanOrEqual(60);
      expect((verdict.args.missionObjectives as string).length).toBeGreaterThanOrEqual(40);
      expect((verdict.args.taskDescription as string).length).toBeGreaterThanOrEqual(40);
    }
  });

  it('replaces too-short start_project prose fields with valid defaults', async () => {
    const verdict = await wrapper.preProcess!(
      'start_project',
      {
        name: 'Tic-Tac-Toe Game',
        about: 'Browser game.',
        missionObjectives: 'Ship it.',
        taskDescription: 'Build a browser tic-tac-toe game.',
      },
      STOCK_CTX,
    );
    expect(verdict.kind).toBe('allow');
    if (verdict.kind === 'allow' && verdict.args) {
      expect((verdict.args.about as string).length).toBeGreaterThanOrEqual(60);
      expect((verdict.args.missionObjectives as string).length).toBeGreaterThanOrEqual(40);
      expect((verdict.args.taskDescription as string).length).toBeGreaterThanOrEqual(40);
    }
  });

  it('does not modify args when all required fields are already present and long enough', async () => {
    const verdict = await wrapper.preProcess!(
      'start_project',
      {
        name: 'Project',
        about: 'a'.repeat(80),
        missionObjectives: 'b'.repeat(50),
        taskDescription: 'c'.repeat(60),
      },
      STOCK_CTX,
    );
    expect(verdict.kind).toBe('allow');
    if (verdict.kind === 'allow') {
      // No mutation when already valid — args is undefined.
      expect(verdict.args).toBeUndefined();
    }
  });
});

describe('McpCompactToolSchemas wrapper', () => {
  const wrapper = wrapperFor(McpCompactToolSchemas);

  function decorateWorkspaceReadTools() {
    wrapper.decorateTools!(
      [
        {
          type: 'function',
          name: 'read_file',
          description: 'Read one workspace file by line range.',
          parameters: {
            type: 'object',
            required: ['path'],
            properties: {
              path: { type: 'string' },
              startLine: { type: 'integer' },
              endLine: { type: 'integer' },
              raw: { type: 'boolean' },
            },
          },
        },
        {
          type: 'function',
          name: 'read_files',
          description: 'Read several workspace files by line range.',
          parameters: {
            type: 'object',
            properties: {
              files: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['path'],
                  properties: {
                    path: { type: 'string' },
                    startLine: { type: 'integer' },
                    endLine: { type: 'integer' },
                  },
                },
              },
              paths: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      ],
      { ...STOCK_CTX, modelTier: 'medium' },
    );
  }

  it('removes prose-only schema fields for local tiers while preserving structure', () => {
    const out = wrapper.decorateTools!(
      [
        {
          type: 'function',
          name: 'write_file',
          description:
            'Create or overwrite a file in the project. This long second sentence should be clipped away for local model prompt budget.',
          parameters: {
            type: 'object',
            description: 'root schema prose',
            required: ['path', 'content'],
            properties: {
              path: {
                type: 'string',
                description: 'workspace-root-relative path',
                examples: ['index.html'],
              },
              content: { type: 'string', title: 'File body' },
            },
          },
        },
      ],
      { ...STOCK_CTX, modelTier: 'medium' },
    );
    const tool = out[0]!;
    expect(tool.description).toBe('Create or overwrite a file in the project.');
    expect(tool.parameters).toEqual({
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
    });
  });

  it('compacts large local tiers when the behavior is explicitly present', () => {
    const out = wrapper.decorateTools!(
      [
        {
          type: 'function',
          name: 'read_file',
          description: 'Read a file. Extra prose.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: 'file path' } },
          },
        },
      ],
      { ...STOCK_CTX, modelTier: 'large' },
    );
    expect(out[0]!.description).toBe('Read a file. Extra prose.');
    expect(out[0]!.parameters).toEqual({
      type: 'object',
      properties: { path: { type: 'string' } },
    });
  });

  it('does not compact cloud tiers even when the behavior is present', () => {
    const out = wrapper.decorateTools!(
      [
        {
          type: 'function',
          name: 'read_file',
          description: 'Read a file. Extra prose.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: 'file path' } },
          },
        },
      ],
      { ...STOCK_CTX, modelTier: 'cloud' },
    );
    expect(out[0]!.description).toBe('Read a file. Extra prose.');
    expect(out[0]!.parameters).toEqual({
      type: 'object',
      properties: { path: { type: 'string', description: 'file path' } },
    });
  });

  it('normalizes argument key casing from the decorated schema', async () => {
    wrapper.decorateTools!(
      [
        {
          type: 'function',
          name: 'start_job',
          description: 'Start a job.',
          parameters: {
            type: 'object',
            required: ['name', 'taskDescription'],
            properties: {
              name: { type: 'string', description: 'Name' },
              taskDescription: { type: 'string', description: 'Task' },
              specialistRole: { type: 'string', description: 'Role' },
            },
          },
        },
      ],
      { ...STOCK_CTX, modelTier: 'medium' },
    );
    const verdict = await wrapper.preProcess!(
      'start_job',
      {
        Name: 'Tic-Tac-Toe Game',
        TaskDescription: 'Build the browser game.',
        specialistRole: 'builder',
      },
      STOCK_CTX,
    );
    expect(verdict.kind).toBe('allow');
    if (verdict.kind === 'allow') {
      expect(verdict.args).toEqual({
        name: 'Tic-Tac-Toe Game',
        taskDescription: 'Build the browser game.',
        specialistRole: 'builder',
      });
    }
  });

  it('leaves canonical read_file range fields unchanged', async () => {
    decorateWorkspaceReadTools();
    await expect(
      wrapper.preProcess!(
        'read_file',
        { path: 'src/app.ts', startLine: 10, endLine: 20 },
        STOCK_CTX,
      ),
    ).resolves.toEqual({ kind: 'allow' });
  });

  it.each([
    ['lineStart/lineEnd', { lineStart: 10, lineEnd: 20 }],
    ['start_line/end_line', { start_line: 10, end_line: 20 }],
  ])('normalizes %s read_file range aliases', async (_label, aliases) => {
    decorateWorkspaceReadTools();
    await expect(
      wrapper.preProcess!('read_file', { path: 'src/app.ts', ...aliases }, STOCK_CTX),
    ).resolves.toEqual({
      kind: 'allow',
      args: { path: 'src/app.ts', startLine: 10, endLine: 20 },
    });
  });

  it('normalizes artifact-style lines.start/count into an inclusive workspace range', async () => {
    decorateWorkspaceReadTools();
    await expect(
      wrapper.preProcess!(
        'read_file',
        { path: 'src/app.ts', lines: { start: 10, count: 11 } },
        STOCK_CTX,
      ),
    ).resolves.toEqual({
      kind: 'allow',
      args: { path: 'src/app.ts', startLine: 10, endLine: 20 },
    });
  });

  it('rejects conflicting read_file range aliases instead of choosing one', async () => {
    decorateWorkspaceReadTools();
    await expect(
      wrapper.preProcess!(
        'read_file',
        { path: 'src/app.ts', startLine: 10, lineStart: 11, endLine: 20 },
        STOCK_CTX,
      ),
    ).resolves.toEqual({
      kind: 'reject',
      error:
        'Conflicting line-range fields. Use only `startLine` and `endLine` (1-based, inclusive).',
    });
  });

  it.each([
    ['lineStart', { lineStart: '10' }],
    ['start_line', { start_line: null }],
    ['lines.start', { lines: { start: '10', count: 2 } }],
    ['lines.count', { lines: { start: 10, count: '2' } }],
    ['lines object', { lines: { page: 2 } }],
  ])(
    'rejects non-numeric or unrecognized %s without falling back to a full read',
    async (_label, bad) => {
      decorateWorkspaceReadTools();
      const verdict = await wrapper.preProcess!(
        'read_file',
        { path: 'src/app.ts', ...bad },
        STOCK_CTX,
      );
      expect(verdict.kind).toBe('reject');
      if (verdict.kind === 'reject') expect(verdict.error).toContain('line-range field');
    },
  );

  it('normalizes line-range aliases inside every read_files item', async () => {
    decorateWorkspaceReadTools();
    await expect(
      wrapper.preProcess!(
        'read_files',
        {
          files: [
            { path: 'src/a.ts', lineStart: 5, lineEnd: 8 },
            { path: 'src/b.ts', lines: { start: 20, count: 3 } },
          ],
        },
        STOCK_CTX,
      ),
    ).resolves.toEqual({
      kind: 'allow',
      args: {
        files: [
          { path: 'src/a.ts', startLine: 5, endLine: 8 },
          { path: 'src/b.ts', startLine: 20, endLine: 22 },
        ],
      },
    });
  });

  it('rejects a malformed nested read_files range rather than dropping it', async () => {
    decorateWorkspaceReadTools();
    const verdict = await wrapper.preProcess!(
      'read_files',
      { files: [{ path: 'src/a.ts', lineStart: '5' }] },
      STOCK_CTX,
    );
    expect(verdict.kind).toBe('reject');
    if (verdict.kind === 'reject') expect(verdict.error).toContain('`lineStart`');
  });

  it('keeps schema-normalization state isolated per wrapper instance', async () => {
    const meesterWrapper = wrapperFor(McpCompactToolSchemas);
    const specialistWrapper = wrapperFor(McpCompactToolSchemas);
    meesterWrapper.decorateTools!(
      [
        {
          type: 'function',
          name: 'message_gezel',
          description: 'Message a gezel.',
          parameters: {
            type: 'object',
            required: ['gezel', 'message'],
            properties: {
              gezel: { type: 'string' },
              message: { type: 'string' },
              project: { type: 'string' },
            },
          },
        },
      ],
      { ...STOCK_CTX, modelTier: 'medium' },
    );
    specialistWrapper.decorateTools!(
      [
        {
          type: 'function',
          name: 'read_file',
          description: 'Read a file.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
          },
        },
      ],
      { ...STOCK_CTX, modelTier: 'medium' },
    );
    const verdict = await meesterWrapper.preProcess!(
      'message_gezel',
      { Gezel: 'bilal', Message: 'Please write review.md.' },
      STOCK_CTX,
    );
    expect(verdict.kind).toBe('allow');
    if (verdict.kind === 'allow') {
      expect(verdict.args).toEqual({
        gezel: 'bilal',
        message: 'Please write review.md.',
      });
    }
  });
});
