import type { RunScriptResponse } from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  formatScriptRunResult,
  jsonSchemaToZodShape,
  parseScriptToolSpecs,
  registerScriptTools,
} from './script-tools.js';

describe('parseScriptToolSpecs', () => {
  it('parses valid specs and preserves bind', () => {
    const specs = parseScriptToolSpecs(
      JSON.stringify([
        {
          name: 'record_session',
          description: 'Log a session.',
          script: 'progress-store',
          bind: { action: 'record' },
        },
      ]),
    );
    expect(specs).toHaveLength(1);
    expect(specs[0]?.bind).toEqual({ action: 'record' });
  });

  it('ignores garbage payloads and invalid entries without throwing', () => {
    expect(parseScriptToolSpecs(undefined)).toEqual([]);
    expect(parseScriptToolSpecs('{nope')).toEqual([]);
    expect(parseScriptToolSpecs('{"not":"an array"}')).toEqual([]);
    const specs = parseScriptToolSpecs(
      JSON.stringify([
        { name: 'BadName', description: 'caps rejected by schema', script: 's' },
        { name: 'good_tool', description: 'ok', script: 's' },
        { name: 'good_tool', description: 'duplicate skipped', script: 's' },
      ]),
    );
    expect(specs.map((s) => s.name)).toEqual(['good_tool']);
  });
});

describe('jsonSchemaToZodShape', () => {
  it('maps declared property types with required/optional handling', () => {
    const shape = jsonSchemaToZodShape({
      type: 'object',
      properties: {
        company: { type: 'string', description: 'Company name' },
        attempts: { type: 'integer' },
        urgent: { type: 'boolean' },
        stage: { enum: ['applied', 'offer'] },
        tags: { type: 'array' },
        extra: { type: 'object' },
        anything: {},
      },
      required: ['company', 'stage'],
    });

    expect(z.object(shape).parse({ company: 'Acme', stage: 'offer' })).toEqual({
      company: 'Acme',
      stage: 'offer',
    });
    expect(() => z.object(shape).parse({ company: 'Acme', stage: 'ghosted' })).toThrow();
    expect(() => z.object(shape).parse({ stage: 'offer' })).toThrow();
    expect(
      z.object(shape).parse({ company: 'Acme', stage: 'applied', attempts: 2, urgent: true }),
    ).toMatchObject({ attempts: 2, urgent: true });
    expect((shape.company as z.ZodTypeAny).description).toBe('Company name');
  });

  it('degrades to an empty shape when inputs are missing or malformed', () => {
    expect(jsonSchemaToZodShape(undefined)).toEqual({});
    expect(jsonSchemaToZodShape({ type: 'object' })).toEqual({});
    expect(jsonSchemaToZodShape({ properties: 'nope' } as never)).toEqual({});
  });
});

describe('formatScriptRunResult', () => {
  it('renders the run header, output block, and call trace', () => {
    const res: RunScriptResponse = {
      runId: 'r-1',
      status: 'ok',
      output: { total: 3 },
      callsSummary: [{ kind: 'fs.write', durationMs: 4 }],
    };
    const formatted = formatScriptRunResult(res);
    expect(formatted.isError).toBeUndefined();
    expect(formatted.content[0]?.text).toContain('run r-1 — status: ok');
    expect(formatted.content[0]?.text).toContain('"total": 3');
    expect(formatted.content[0]?.text).toContain('fs.write (4ms)');
  });

  it('marks error runs as isError', () => {
    const formatted = formatScriptRunResult({
      runId: 'r-2',
      status: 'error',
      error: 'capability denied',
      callsSummary: [],
    });
    expect(formatted.isError).toBe(true);
    expect(formatted.content[0]?.text).toContain('error: capability denied');
  });
});

describe('registerScriptTools', () => {
  function fakeServer(): { tool: ReturnType<typeof vi.fn> } {
    return { tool: vi.fn() };
  }

  it('registers specs, skipping reserved names', () => {
    const server = fakeServer();
    const registered = registerScriptTools(
      server as unknown as McpServer,
      parseScriptToolSpecs(
        JSON.stringify([
          { name: 'run_installed_script', description: 'collides', script: 's' },
          { name: 'record_application', description: 'ok', script: 'application-store' },
        ]),
      ),
      {
        api: {} as GezelClient,
        projectId: 'p1',
        reservedNames: new Set(['run_installed_script']),
      },
    );
    expect(registered).toEqual(['record_application']);
    expect(server.tool).toHaveBeenCalledTimes(1);
    expect(server.tool.mock.calls[0]?.[0]).toBe('record_application');
  });

  it('dispatches through runProjectScript with bind merged over model args', async () => {
    const server = fakeServer();
    const runProjectScript = vi.fn(
      async (): Promise<RunScriptResponse> => ({ runId: 'r-9', status: 'ok', callsSummary: [] }),
    );
    registerScriptTools(
      server as unknown as McpServer,
      parseScriptToolSpecs(
        JSON.stringify([
          {
            name: 'record_session',
            description: 'Log a session.',
            script: 'progress-store',
            bind: { action: 'record' },
          },
        ]),
      ),
      {
        api: { runProjectScript } as unknown as GezelClient,
        projectId: 'p1',
        reservedNames: new Set(),
      },
    );

    const handler = server.tool.mock.calls[0]?.[3] as (
      args: Record<string, unknown>,
    ) => Promise<{ isError?: boolean }>;
    const result = await handler({ note: 'practiced', action: 'spoofed' });

    expect(runProjectScript).toHaveBeenCalledWith('p1', {
      name: 'progress-store',
      // bind wins over a model-supplied value for the same key.
      input: { note: 'practiced', action: 'record' },
    });
    expect(result.isError).toBeUndefined();
  });

  it('returns isError text when the API call throws', async () => {
    const server = fakeServer();
    registerScriptTools(
      server as unknown as McpServer,
      parseScriptToolSpecs(
        JSON.stringify([{ name: 'boom_tool', description: 'x', script: 'boom' }]),
      ),
      {
        api: {
          runProjectScript: vi.fn(async () => {
            throw new Error('daemon unreachable');
          }),
        } as unknown as GezelClient,
        projectId: 'p1',
        reservedNames: new Set(),
      },
    );
    const handler = server.tool.mock.calls[0]?.[3] as (
      args: Record<string, unknown>,
    ) => Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
    const result = await handler({});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('boom_tool failed: daemon unreachable');
  });
});
