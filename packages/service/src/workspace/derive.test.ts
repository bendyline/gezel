import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../fs/store.js';
import { canApplyLinuxSystemdSandbox } from '../sandbox/runner.js';
import { deriveWorkspaceFile } from './derive.js';

let home: string;
let store: Store;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'gezel-derive-test-'));
  store = new Store({ home });
  await store.ensureLayout();
  await store.createProject({ name: 'Default' });
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function seedWorkspaceFile(path: string, content: string): Promise<void> {
  const file = join(home, 'projects', 'default', 'workspace', path);
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, content, 'utf8');
}

describe('deriveWorkspaceFile', () => {
  it.runIf(process.platform !== 'darwin')(
    'fails closed before running the inline transform without an OS network boundary',
    async () => {
      if (process.platform === 'linux' && (await canApplyLinuxSystemdSandbox())) return;
      const res = await deriveWorkspaceFile(store, {
        projectId: 'default',
        script: `throw new Error('must not execute');`,
        outputPath: 'out/customers.json',
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(126);
      expect(res.stderr).toContain('denyNet requires an enforceable OS network boundary');
      expect(res.output).toBeUndefined();
    },
    30_000,
  );

  it.runIf(process.platform === 'linux')(
    'runs the inline transform through the Linux systemd boundary when available',
    async () => {
      if (!(await canApplyLinuxSystemdSandbox())) return;
      await seedWorkspaceFile('data/raw.csv', 'email,name\na@x.com,Ada\nb@x.com,Bo\n');
      const res = await deriveWorkspaceFile(store, {
        projectId: 'default',
        script: `
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const rows = readFileSync('data/raw.csv', 'utf8').trim().split('\\n').slice(1);
const records = rows.map((line) => {
  const [email, name] = line.split(',');
  return { email, name: name.toUpperCase() };
});
mkdirSync('out', { recursive: true });
writeFileSync('out/customers.json', JSON.stringify(records, null, 2));
console.log('wrote', records.length, 'records');
`,
        outputPath: 'out/customers.json',
      });
      expect(res.ok).toBe(true);
      expect(res.code).toBe(0);
      expect(res.output?.path).toBe('out/customers.json');
      expect(res.output?.headPreview).toContain('ADA');
      expect(res.stdout).toContain('wrote 2 records');
    },
    30_000,
  );

  it.runIf(process.platform === 'darwin')(
    'runs the inline script in the sandbox and verifies the produced output',
    async () => {
      await seedWorkspaceFile('data/raw.csv', 'email,name\na@x.com,Ada\nb@x.com,Bo\n');
      const res = await deriveWorkspaceFile(store, {
        projectId: 'default',
        script: `
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const rows = readFileSync('data/raw.csv', 'utf8').trim().split('\\n').slice(1);
const records = rows.map((line) => {
  const [email, name] = line.split(',');
  return { email, name: name.toUpperCase() };
});
mkdirSync('out', { recursive: true });
writeFileSync('out/customers.json', JSON.stringify(records, null, 2));
console.log('wrote', records.length, 'records');
`,
        outputPath: 'out/customers.json',
      });
      expect(res.ok).toBe(true);
      expect(res.code).toBe(0);
      expect(res.output?.path).toBe('out/customers.json');
      expect(res.output?.bytes).toBeGreaterThan(20);
      expect(res.output?.headPreview).toContain('ADA');
      expect(res.stdout).toContain('wrote 2 records');
      // The inline script never lands in the workspace.
      const listing = await store.listProjectWorkspaceRecursive('default');
      expect(listing.some((e) => e.path.includes('derive.mjs'))).toBe(false);
    },
    30_000,
  );

  it.runIf(process.platform === 'darwin')(
    'surfaces a nonzero exit with stderr and no output block',
    async () => {
      const res = await deriveWorkspaceFile(store, {
        projectId: 'default',
        script: `console.error('boom: missing input'); process.exit(3);`,
        outputPath: 'out/customers.json',
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(3);
      expect(res.stderr).toContain('boom: missing input');
      expect(res.output).toBeUndefined();
    },
    30_000,
  );

  it.runIf(process.platform === 'darwin')(
    'fails verification when the script exits clean without producing the output',
    async () => {
      const res = await deriveWorkspaceFile(store, {
        projectId: 'default',
        script: `console.log('did nothing');`,
        outputPath: 'out/customers.json',
      });
      expect(res.ok).toBe(false);
      expect(res.code).toBe(0);
      expect(res.verifyError).toContain('was not created');
    },
    30_000,
  );

  it.runIf(process.platform === 'darwin')(
    'fails verification when a data output does not parse as a table',
    async () => {
      const res = await deriveWorkspaceFile(store, {
        projectId: 'default',
        script: `
import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('out', { recursive: true });
writeFileSync('out/customers.json', 'this is not json at all');
`,
        outputPath: 'out/customers.json',
      });
      expect(res.ok).toBe(false);
      expect(res.verifyError).toContain('does not parse as a data table');
    },
    30_000,
  );

  it('rejects output paths that escape the workspace', async () => {
    const res = await deriveWorkspaceFile(store, {
      projectId: 'default',
      script: `console.log('never runs');`,
      outputPath: '../../escape.json',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('escapes the workspace');
    expect(res.stdout).toBe('');
  });
});
