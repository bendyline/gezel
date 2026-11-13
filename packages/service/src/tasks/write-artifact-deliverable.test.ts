import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gezelPaths } from '@bendyline/gezel/paths';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { McpBridge } from '../providers/mcp-bridge.js';
import { type RunningService, startService } from '../service.js';

/**
 * `write_artifact` refuses a path a workspace file already holds, so a model
 * does not mistake a side-drawer copy for an update to the project. A Gemma 4
 * E4B owner wrote its report into the workspace by mistake and was then
 * refused the drawer its task reads, three times, until the turn aborted with
 * nothing delivered (review re-measurement, 2026-11-12). The real gezel-mcp
 * server runs here against a task whose step checks the report in the drawer.
 */

vi.setConfig({ testTimeout: 30_000 });

const require = createRequire(import.meta.url);

let svc: RunningService;
let home: string;
let bridge: McpBridge;
let projectId: string;

async function text(tool: string, args: Record<string, unknown>) {
  const res = await bridge.callTool(tool, args);
  return typeof res === 'string' ? res : JSON.stringify(res);
}

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  process.env.GEZEL_DISABLE_EMBEDDINGS = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-artifact-deliverable-'));
  svc = await startService({ home });
  const { store, tasks } = svc.context;
  projectId = (await store.createProject({ name: 'research' })).id;
  const task = await tasks.create(projectId, {
    title: 'Cited report',
    description: 'Write the cited report.',
    assignee: { kind: 'user' },
    createdBy: { kind: 'user' },
    steps: [
      {
        id: 'outcome',
        name: 'Write the report',
        prompt: 'Write tasks/eval/report.md in the artifacts drawer.',
        terminal: true,
        gate: {
          checks: [{ kind: 'minBytes', file: 'tasks/eval/report.md', artifact: true, bytes: 10 }],
        },
      },
    ],
    entryStepId: 'outcome',
  } as never);
  await store.writeProjectWorkspaceFile(
    projectId,
    'tasks/eval/report.md',
    'written here by mistake',
  );
  await store.writeProjectWorkspaceFile(projectId, 'notes/plan.md', 'a project file');

  const scheme = svc.cert ? 'https' : 'http';
  const env: Record<string, string> = {
    GEZEL_BASE_URL: `${scheme}://127.0.0.1:${svc.port}`,
    GEZEL_TOKEN: svc.context.token,
    GEZEL_AGENT_ID: 'ada',
    GEZEL_PROJECT_ID: projectId,
    GEZEL_HOME: svc.context.home,
    GEZEL_TASK_REF: task.ref,
  };
  if (svc.cert) env.GEZEL_CERT_PATH = gezelPaths(svc.context.home).runtime.cert;
  bridge = new McpBridge();
  await bridge.start({
    command: 'node',
    args: [require.resolve('@bendyline/gezel-mcp/dist/server.js')],
    env,
  });
}, 60_000);

afterAll(async () => {
  await bridge?.stop();
  await svc?.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  delete process.env.GEZEL_MOCK_PROVIDER;
  delete process.env.GEZEL_DISABLE_EMBEDDINGS;
});

describe('write_artifact beside a workspace file at the same path', () => {
  it('writes the deliverable the task reads from the drawer, and says the workspace copy stays', async () => {
    const out = await text('write_artifact', {
      path: 'tasks/eval/report.md',
      content: '# Report\n\nThe answer, with its sources.\n',
    });
    expect(out).toContain('Wrote tasks/eval/report.md');
    expect(out).toContain('The task reads tasks/eval/report.md from the artifacts drawer');
    expect(out).not.toContain('Refusing write_artifact');
    const { store } = svc.context;
    expect(await store.readProjectArtifact(projectId, 'tasks/eval/report.md')).toContain(
      'The answer, with its sources.',
    );
    expect(await store.readProjectWorkspaceFile(projectId, 'tasks/eval/report.md')).toBe(
      'written here by mistake',
    );
  });

  it('still refuses a side-drawer copy of a project file the task does not read', async () => {
    const out = await text('write_artifact', { path: 'notes/plan.md', content: 'a copy' });
    expect(out).toContain('Refusing write_artifact');
  });
});
