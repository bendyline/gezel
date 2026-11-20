import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const script = join(dirname(fileURLToPath(import.meta.url)), 'sync-server-json.mjs');

const MANIFEST = {
  name: '@bendyline/example-mcp',
  version: '2.0.0',
  mcpName: 'com.example/example',
};

function serverJson(overrides = {}) {
  return {
    name: 'com.example/example',
    description: 'An example.',
    version: '1.0.0',
    packages: [
      {
        registryType: 'npm',
        identifier: '@bendyline/example-mcp',
        version: '1.0.0',
        transport: { type: 'stdio' },
      },
    ],
    ...overrides,
  };
}

async function packageDir(server, manifest = MANIFEST) {
  const dir = await mkdtemp(join(tmpdir(), 'gezel-sync-server-json-'));
  await writeFile(join(dir, 'package.json'), JSON.stringify(manifest));
  if (server) await writeFile(join(dir, 'server.json'), JSON.stringify(server));
  return dir;
}

function run(dir, version, env = {}) {
  return execFileP(process.execPath, [script, version], {
    cwd: dir,
    env: { ...process.env, GEZEL_RELEASE_DRY_RUN: '', ...env },
  });
}

test('stamps the released version on the server and on its own npm package', async () => {
  const dir = await packageDir(serverJson());
  try {
    await run(dir, '2.0.0');
    const stamped = JSON.parse(await readFile(join(dir, 'server.json'), 'utf8'));
    assert.equal(stamped.version, '2.0.0');
    assert.equal(stamped.packages[0].version, '2.0.0');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('skips a package that has no server.json', async () => {
  const dir = await packageDir(null);
  try {
    const { stdout } = await run(dir, '2.0.0');
    assert.equal(stdout, '');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refuses a server.json whose name the registry would reject', async () => {
  const dir = await packageDir(serverJson({ name: 'com.example/other' }));
  try {
    await assert.rejects(run(dir, '2.0.0'), /mcpName is "com\.example\/example"; they must match/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refuses a server.json that does not list this package', async () => {
  const server = serverJson();
  server.packages[0].identifier = '@someone/else';
  const dir = await packageDir(server);
  try {
    await assert.rejects(run(dir, '2.0.0'), /lists no npm package named @bendyline\/example-mcp/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('dry run leaves server.json untouched', async () => {
  const dir = await packageDir(serverJson());
  try {
    const before = await readFile(join(dir, 'server.json'), 'utf8');
    const { stdout } = await run(dir, '2.0.0', { GEZEL_RELEASE_DRY_RUN: '1' });
    assert.match(stdout, /\[dry run\] would set .*server\.json to version 2\.0\.0/);
    assert.equal(await readFile(join(dir, 'server.json'), 'utf8'), before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('refuses a missing or malformed version', async () => {
  const dir = await packageDir(serverJson());
  try {
    await assert.rejects(run(dir, 'next'), /expected a version argument/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
