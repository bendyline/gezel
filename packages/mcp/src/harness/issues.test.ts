import { join } from 'node:path';
import type { HarnessConnectResponse } from '@bendyline/gezel';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { registerHarnessIssueTools, registerHarnessPrompts } from './issues.js';
import type { HarnessBinding, HarnessSession } from './session.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;
type PromptHandler = (
  args: Record<string, unknown>,
) => Promise<{ messages: { content: { text: string } }[] }>;

const folder = join('/', 'work', 'repo');

const emptyBatch = { files: [], count: 0, remaining: 0, firstBatch: true, indexed: true };

function binding(info: Partial<HarnessConnectResponse> | undefined): HarnessBinding {
  return {
    key: `folder:${folder}`,
    request: { client: 'claude-code' },
    folder,
    ...(info
      ? {
          info: {
            token: 'HARNESS',
            appId: 'harness:claude-code:repo',
            project: {
              id: 'repo',
              name: 'repo',
              workingDir: folder,
              readOnly: true,
              created: false,
            },
            memory: 'save',
            images: 'local',
            ...info,
          } as HarnessConnectResponse,
        }
      : {}),
  };
}

function setup(bound: HarnessBinding, issueTriage: Record<string, unknown> = {}) {
  const tools = new Map<string, ToolHandler>();
  const prompts = new Map<string, PromptHandler>();
  const server = {
    registerTool: vi.fn((name: string, _config: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    }),
    registerPrompt: vi.fn((name: string, _config: unknown, handler: PromptHandler) => {
      prompts.set(name, handler);
    }),
  };
  const api = { issueTriage };
  const session = {
    bind: vi.fn(async () => bound),
    run: vi.fn(async (_b: HarnessBinding, fn: (client: unknown) => Promise<unknown>) => fn(api)),
  };
  registerHarnessIssueTools(server as unknown as McpServer, session as unknown as HarnessSession);
  registerHarnessPrompts(server as unknown as McpServer, session as unknown as HarnessSession);
  async function call(name: string, args: Record<string, unknown> = {}) {
    const handler = tools.get(name);
    if (!handler) throw new Error(`${name} was not registered`);
    return handler(args);
  }
  async function prompt(name: string, args: Record<string, unknown> = {}) {
    const handler = prompts.get(name);
    if (!handler) throw new Error(`${name} was not registered`);
    return (await handler(args)).messages[0]?.content.text ?? '';
  }
  return { call, prompt, session };
}

function textOf(result: CallToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

describe('list_issues', () => {
  it('sends a folder prefix relative to the bound folder, from either spelling', async () => {
    const handoffQueue = vi.fn(async () => emptyBatch);
    const { call } = setup(binding({ issues: 'read' }), { handoffQueue });

    await call('list_issues', { pathPrefix: 'src/save' });
    await call('list_issues', { pathPrefix: join(folder, 'src'), severity: 'major' });
    await call('list_issues', { pathPrefix: folder, includeInfo: true });

    expect(handoffQueue.mock.calls).toEqual([
      ['repo', { pathPrefix: 'src/save' }],
      ['repo', { severity: 'major', pathPrefix: 'src' }],
      ['repo', { includeInfo: true }],
    ]);
  });

  it('refuses a folder prefix outside the bound folder without asking Gezel', async () => {
    const handoffQueue = vi.fn(async () => emptyBatch);
    const { call } = setup(binding({ issues: 'read' }), { handoffQueue });
    const res = await call('list_issues', { pathPrefix: join('/', 'elsewhere') });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain('pathPrefix must be inside the folder Gezel knows as "repo"');
    expect(handoffQueue).not.toHaveBeenCalled();
  });

  it('says there is nothing to check when the app is bound to no project', async () => {
    const { call } = setup(binding({ issues: 'triage', project: undefined }));
    const res = await call('list_issues');
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("isn't working in a folder Gezel knows");
  });
});

describe('report_issue_verdicts', () => {
  it('keeps a reason only on not_a_bug and passes a duplicate through', async () => {
    const applyVerdicts = vi.fn(async () => ({
      results: [
        { ref: 'BW-2', outcome: 'applied', message: 'BW-2 is now closed.' },
        { ref: 'BW-3', outcome: 'applied', message: "BW-3: Gezel can't confirm BW-1 exists." },
      ],
      applied: 2,
      refused: 0,
    }));
    const { call } = setup(binding({ issues: 'triage' }), { applyVerdicts });
    const out = textOf(
      await call('report_issue_verdicts', {
        verdicts: [
          { ref: 'BW-1', verdict: 'confirmed', reason: 'intended', note: 'Reproduced it.' },
          { ref: 'BW-2', verdict: 'not_a_bug', reason: 'handled_elsewhere', note: 'save.ts:40' },
          { ref: 'BW-3', verdict: 'duplicate', duplicateOf: 'BW-1', note: 'Same loop bound.' },
        ],
      }),
    );
    expect(applyVerdicts).toHaveBeenCalledWith('repo', {
      verdicts: [
        { ref: 'BW-1', kind: 'confirmed', note: 'Reproduced it.' },
        { ref: 'BW-2', kind: 'not_a_bug', reason: 'handled_elsewhere', note: 'save.ts:40' },
        { ref: 'BW-3', kind: 'duplicate', note: 'Same loop bound.', duplicateOf: 'BW-1' },
      ],
    });
    expect(out).toBe("Gezel recorded 2 verdicts.\n- BW-3: Gezel can't confirm BW-1 exists.");
  });

  it('counts one verdict in the singular', async () => {
    const applyVerdicts = vi.fn(async () => ({
      results: [{ ref: 'BW-4', outcome: 'applied', message: 'BW-4 is now fixed.' }],
      applied: 1,
      refused: 0,
    }));
    const { call } = setup(binding({ issues: 'triage' }), { applyVerdicts });
    const res = await call('report_issue_verdicts', {
      verdicts: [{ ref: 'BW-4', verdict: 'fixed', note: 'Fixed the bound.' }],
    });
    expect(textOf(res)).toBe('Gezel recorded 1 verdict.');
  });
});

describe('the issue prompts', () => {
  it('serves the reason instead of a batch when the person has not allowed it', async () => {
    const handoffQueue = vi.fn(async () => emptyBatch);
    const { prompt } = setup(binding({ issues: 'read' }), { handoffQueue });
    expect(await prompt('fix_issues')).toContain('Reporting verdicts is turned off');
    expect(handoffQueue).not.toHaveBeenCalled();
    expect(await prompt('triage_issues')).toContain('Gezel has no open issues for this folder');
  });

  it('serves the error when Gezel cannot be reached', async () => {
    const { prompt, session } = setup(binding({ issues: 'triage' }));
    session.bind.mockRejectedValueOnce(new Error('Gezel is not running.'));
    expect(await prompt('triage_issues')).toBe('Gezel is not running.');
  });
});
