#!/usr/bin/env node
/**
 * Smoke-test a Gezel image the way people will use it (docs/container.md):
 *
 *   node docker/smoke.mjs <image>        e.g. gezel:cpu or ghcr.io/bendyline/gezel@sha256:…
 *
 * Runs the service with the mock provider, then checks the container
 * listener, setup and sign-in, a session surviving a restart, the shell
 * commands, an app key against the OpenAI-style endpoints, the baked-in
 * engines, a boot with no network, and the refusal of a second container on
 * the same volume. Cleans up after itself, pass or fail.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const image = process.argv[2];
if (!image) {
  console.error('usage: node docker/smoke.mjs <image>');
  process.exit(2);
}

const id = randomBytes(4).toString('hex');
const name = `gezel-smoke-${id}`;
const volume = `gezel-smoke-${id}`;
const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;
const cleanup = [];

function docker(args, opts = {}) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    ...opts,
  });
}

function step(label) {
  console.log(`\n▸ ${label}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
  console.log(`  ok  ${message}`);
}

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { text };
  }
  return { status: res.status, body: json };
}

async function waitHealthy(container, seconds = 120) {
  for (let i = 0; i < seconds; i++) {
    const result = spawnSync('docker', ['exec', container, 'gezel-entrypoint', 'health']);
    if (result.status === 0) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${container} did not become healthy:\n${docker(['logs', container])}`);
}

function runService(extra = []) {
  docker([
    'run',
    '-d',
    '--name',
    name,
    '-p',
    `127.0.0.1:${port}:6228`,
    '-v',
    `${volume}:/gezel`,
    '-e',
    'GEZEL_MOCK_PROVIDER=1',
    ...extra,
    image,
  ]);
}

async function main() {
  cleanup.push(() => docker(['rm', '-f', name]));
  cleanup.push(() => docker(['volume', 'rm', '-f', volume]));

  step('the service starts and answers on the published port');
  runService();
  await waitHealthy(name);
  const health = await call('GET', '/api/health');
  assert(health.status === 200 && health.body.ok === true, 'health answers');
  assert(health.body.pid === undefined, 'health leaves out the pid');
  // fetch sets Host itself, so check a foreign one from inside the container.
  const foreign = spawnSync('docker', [
    'exec',
    name,
    'node',
    '-e',
    "require('node:http').get({host:'127.0.0.1',port:6228,path:'/api/health',headers:{Host:'attacker.example'}},r=>process.exit(r.statusCode===403?0:1))",
  ]);
  assert(foreign.status === 0, 'a hostname nobody configured is refused');
  assert((await call('GET', '/api/projects')).status === 401, 'the API needs a sign-in');

  step('the setup link creates the first account');
  // The service logs to stderr; docker logs replays both streams.
  const logs = spawnSync('docker', ['logs', name], { encoding: 'utf8' });
  const code = /\?setup=([0-9A-Z-]+)/.exec(`${logs.stdout}${logs.stderr}`)?.[1];
  assert(Boolean(code), 'the logs carry a setup link');
  const setup = await call('POST', '/v1/apps/signin/setup', {
    body: { code, name: 'Smoke', password: 'smoke-password' },
  });
  assert(setup.status === 200, 'setup creates the account');
  const token = setup.body.token;
  assert(
    (await call('GET', '/api/projects', { token })).status === 200,
    'the session reaches the API',
  );

  step('the session survives a restart');
  docker(['restart', name]);
  await waitHealthy(name);
  assert((await call('GET', '/api/projects', { token })).status === 200, 'still signed in');

  step('the shell manages accounts and app keys');
  docker(['exec', '-i', name, 'gezel', 'account', 'create', 'Ana', '--password-stdin'], {
    input: 'another-password\n',
  });
  const accounts = await call('GET', '/api/accounts', { token });
  assert(
    accounts.body.accounts?.some((a) => a.name === 'Ana'),
    'gezel account create added Ana',
  );
  const minted = JSON.parse(
    docker(['exec', name, 'gezel', 'integrations', 'token', 'create', 'smoke-app', '--json']),
  );
  assert(
    (await call('GET', '/v1/models', { token: minted.token })).status === 200,
    'the app key lists models',
  );
  const chat = await call('POST', '/v1/chat/completions', {
    token: minted.token,
    body: { model: 'gezel', messages: [{ role: 'user', content: 'hello' }] },
  });
  assert(chat.status === 200, 'the app key gets a chat completion');

  step('the CLI runs in the container');
  const reply = spawnSync('docker', ['exec', name, 'gezel', 'run', 'hello'], { encoding: 'utf8' });
  assert(reply.status === 0, 'gezel run answers');

  step('the engines are baked in');
  const engines = docker([
    'exec',
    name,
    'sh',
    '-c',
    'for f in "$GEZEL_NATIVE_BIN_DIR"/*/gezel-llama-server; do "$f" --version >/dev/null 2>&1 && echo ok; done',
  ]);
  assert(engines.includes('ok'), 'a bundled llama-server runs (the C library floor holds)');

  step('a second container on the same volume refuses to start');
  const second = spawnSync(
    'docker',
    ['run', '--rm', '-v', `${volume}:/gezel`, '-e', 'GEZEL_MOCK_PROVIDER=1', image],
    { encoding: 'utf8', timeout: 120_000 },
  );
  assert(second.status !== 0, 'the second container exits');
  assert(`${second.stdout}${second.stderr}`.includes('docker exec'), 'and says to use docker exec');

  step('with no network, the service still starts');
  docker(['rm', '-f', name]);
  docker([
    'run',
    '-d',
    '--name',
    name,
    '--network',
    'none',
    '-v',
    `${volume}:/gezel`,
    '-e',
    'GEZEL_MOCK_PROVIDER=1',
    image,
  ]);
  await waitHealthy(name);
  assert(true, 'healthy offline');

  console.log('\nsmoke passed');
}

main()
  .catch((err) => {
    console.error(`\nsmoke FAILED: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  })
  .finally(() => {
    // In order: the container goes before the volume it holds.
    for (const undo of cleanup) {
      try {
        undo();
      } catch {
        /* already gone */
      }
    }
  });
