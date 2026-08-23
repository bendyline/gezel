import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gezelPaths } from '@bendyline/gezel/paths';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { McpBridge } from '../providers/mcp-bridge.js';
import { type RunningService, startService } from '../service.js';

/**
 * The load-bearing end-to-end test for diffpack drafting: spawn the REAL
 * gezel-mcp server with `GEZEL_DIFFPACK_ID` set, call the ordinary workspace
 * write tools by their ordinary names, and prove the bytes land in the pack
 * rather than the workspace.
 *
 * Everything else about the feature is recoverable if it breaks. This is not:
 * if the redirect silently fails, a night shift edits the user's source
 * behind their back on a folder they never granted writes to.
 */

vi.setConfig({ testTimeout: 30_000 });

const require = createRequire(import.meta.url);

let svc: RunningService;
let home: string;
let scratch: string;
let drafting: McpBridge;
let plain: McpBridge;
let externalDir: string;
let projectId: string;

const PACK_ID = '1';

async function text(bridge: McpBridge, tool: string, args: Record<string, unknown>) {
  const res = await bridge.callTool(tool, args);
  return typeof res === 'string' ? res : JSON.stringify(res);
}

async function workspaceFile(rel: string): Promise<string | null> {
  return readFile(join(externalDir, rel), 'utf8').catch(() => null);
}

beforeAll(async () => {
  process.env.GEZEL_MOCK_PROVIDER = '1';
  process.env.GEZEL_DISABLE_EMBEDDINGS = '1';
  home = await mkdtemp(join(tmpdir(), 'gezel-diffpack-mcp-'));
  scratch = await mkdtemp(join(tmpdir(), 'gezel-diffpack-mcp-ws-'));
  svc = await startService({ home });

  // An EXTERNAL working folder with no managed-write grant — the case the
  // whole feature exists for. A gezel cannot write here at all.
  externalDir = join(scratch, 'checkout');
  await mkdir(externalDir, { recursive: true });
  await writeFile(join(externalDir, 'parser.ts'), 'const strict = false;\nexport {};\n', 'utf8');
  await writeFile(join(externalDir, 'dead.ts'), 'unused\n', 'utf8');
  projectId = (await svc.context.store.createProject({ name: 'ext', workingDir: externalDir })).id;

  await svc.context.diffpacks.ensure(projectId, PACK_ID, {
    title: 'Fix strictness',
    origin: { kind: 'boekwachter-issue', issueRefs: ['BW-1'] },
    taskRef: `${projectId}/${PACK_ID}`,
  });

  const scheme = svc.cert ? 'https' : 'http';
  const baseEnv: Record<string, string> = {
    GEZEL_BASE_URL: `${scheme}://127.0.0.1:${svc.port}`,
    GEZEL_TOKEN: svc.context.token,
    GEZEL_AGENT_ID: 'ada',
    GEZEL_PROJECT_ID: projectId,
    GEZEL_HOME: svc.context.home,
  };
  if (svc.cert) baseEnv.GEZEL_CERT_PATH = gezelPaths(svc.context.home).runtime.cert;
  const mcpPath = require.resolve('@bendyline/gezel-mcp/dist/server.js');

  drafting = new McpBridge();
  await drafting.start({
    command: 'node',
    args: [mcpPath],
    env: { ...baseEnv, GEZEL_DIFFPACK_ID: PACK_ID },
  });

  plain = new McpBridge();
  await plain.start({ command: 'node', args: [mcpPath], env: baseEnv });
}, 60_000);

afterAll(async () => {
  await drafting?.stop();
  await plain?.stop();
  await svc?.stop();
  await rm(home, { recursive: true, force: true }).catch(() => {});
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
  delete process.env.GEZEL_MOCK_PROVIDER;
  delete process.env.GEZEL_DISABLE_EMBEDDINGS;
});

describe('a drafting session edits the pack, never the workspace', () => {
  it('routes replace_in_file into the draft tree', async () => {
    const out = await text(drafting, 'replace_in_file', {
      path: 'parser.ts',
      find: 'strict = false',
      replace: 'strict = true',
    });
    expect(out).not.toMatch(/error/i);

    expect(await workspaceFile('parser.ts')).toBe('const strict = false;\nexport {};\n');
    expect(await svc.context.diffpacks.drafts.read(projectId, PACK_ID, 'parser.ts')).toBe(
      'const strict = true;\nexport {};\n',
    );
  });

  it('shows the model its own edit back through read_file', async () => {
    const out = await text(drafting, 'read_file', { path: 'parser.ts' });
    expect(out).toContain('strict = true');
  });

  it('routes write_file for a net-new file into the draft tree', async () => {
    await text(drafting, 'write_file', {
      path: 'helper.ts',
      content: 'export const help = () => 1;\n',
    });
    expect(await workspaceFile('helper.ts')).toBeNull();
    expect(await svc.context.diffpacks.drafts.read(projectId, PACK_ID, 'helper.ts')).toContain(
      'export const help',
    );
  });

  it('routes delete_path to a tombstone rather than removing the file', async () => {
    await text(drafting, 'delete_path', { path: 'dead.ts' });
    expect(await workspaceFile('dead.ts')).toBe('unused\n');
    expect(await svc.context.diffpacks.drafts.listDeletions(projectId, PACK_ID)).toEqual([
      'dead.ts',
    ]);
  });

  it('refuses apply_patch instead of letting it reach the workspace', async () => {
    const out = await text(drafting, 'apply_patch', {
      path: 'parser.ts',
      diff: '--- a/parser.ts\n+++ b/parser.ts\n@@ -1 +1 @@\n-const strict = false;\n+const strict = 99;\n',
    });
    expect(out).toMatch(/unavailable while drafting/i);
    expect(out).toMatch(/replace_in_file/);
    expect(await workspaceFile('parser.ts')).toBe('const strict = false;\nexport {};\n');
  });

  it('seals into a pack that applies back cleanly', async () => {
    const sealed = await svc.context.diffpacks.seal(projectId, PACK_ID);
    expect(sealed.status).toBe('ready');
    expect(sealed.files.map((f) => `${f.path}:${f.change}`).sort()).toEqual([
      'dead.ts:delete',
      'helper.ts:add',
      'parser.ts:modify',
    ]);

    const result = await svc.context.diffpacks.apply(projectId, PACK_ID);
    expect(result.ok).toBe(true);
    expect(await workspaceFile('parser.ts')).toBe('const strict = true;\nexport {};\n');
    expect(await workspaceFile('helper.ts')).toBe('export const help = () => 1;\n');
    expect(await workspaceFile('dead.ts')).toBeNull();
  });
});

describe('a session with no pack is unaffected', () => {
  it('still hits the workspace write gate and is refused', async () => {
    const out = await text(plain, 'write_file', { path: 'sneaky.ts', content: 'nope\n' });
    expect(out).toMatch(/consent|not writable|permission|denied|enable/i);
    expect(await workspaceFile('sneaky.ts')).toBeNull();
  });
});
