#!/usr/bin/env node
/**
 * Pack every publishable package, install the tarballs into a throwaway
 * project, and prove a real consumer can use them.
 *
 * WHY A SEPARATE PROJECT, AND WHY npm: inside this repo every gezel package
 * resolves through pnpm's workspace links and its hoisted virtual store. That
 * hides two whole classes of bug that only bite people installing from npm:
 *
 *   1. A missing runtime dependency. It resolves in the workspace because
 *      some sibling hoisted it; it is absent in a consumer's tree.
 *   2. A native/prebuild install failure. `@bendyline/gezel-service` pulls
 *      node-pty, @napi-rs/keyring, @resvg/resvg-js, sqlite-vec,
 *      onnxruntime-node (via @huggingface/transformers), kokoro-js and
 *      playwright-core. Nothing else in this repo installs that chain
 *      outside pnpm.
 *
 * So: pnpm pack (which resolves `workspace:*`), then `npm install` into an
 * empty non-workspace directory, then exercise it.
 *
 * Usage:
 *   node scripts/check-package-consumers.mjs
 *   node scripts/check-package-consumers.mjs --keep   # leave the temp dir
 *
 * Env:
 *   GEZEL_CONSUMER_SKIP_DAEMON=1   skip the daemon boot (fastest useful run)
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');

/** Mirrors tests/published/_packages.ts. Keep the two in step. */
const PUBLISHED = [
  'core',
  'client',
  'sdk',
  'app-sdk',
  'plugin-sdk',
  'catalog',
  'mcp',
  'service',
  'connectors-spectral',
  'script-stdlib',
  'cli',
];

/**
 * Subpaths a consumer must be able to `import()` under plain node. Kept to
 * the surfaces that do not spin up heavy machinery on import.
 */
const IMPORTABLE = [
  '@bendyline/gezel',
  '@bendyline/gezel/paths',
  '@bendyline/gezel/schemas',
  '@bendyline/gezel/markdown',
  '@bendyline/gezel/native',
  '@bendyline/gezel/checks',
  '@bendyline/gezel-client',
  '@bendyline/gezel-client/node',
  '@bendyline/gezel-sdk',
  '@bendyline/gezel-sdk/checks',
  '@bendyline/gezel-sdk/stores',
  '@bendyline/gezel-app-sdk',
  '@bendyline/gezel-plugin-sdk',
  '@bendyline/gezel-catalog',
  '@bendyline/gezel-mcp',
];

let failures = 0;
const step = (name) => console.log(`\n── ${name}`);
function fail(message) {
  failures += 1;
  console.error(`  FAIL ${message}`);
}
function ok(message) {
  console.log(`  ok   ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

const root = mkdtempSync(join(tmpdir(), 'gezel-packed-consumer-'));
const tarballDir = join(root, 'tarballs');
const consumer = join(root, 'consumer');
run('mkdir', ['-p', tarballDir, consumer]);

try {
  // ── 1. Pack ────────────────────────────────────────────────────────────
  step('packing');
  const tarballs = [];
  for (const dir of PUBLISHED) {
    const packageDir = resolve(repoRoot, 'packages', dir);
    const result = run('pnpm', ['pack', '--pack-destination', tarballDir], { cwd: packageDir });
    if (result.status !== 0) fail(`pnpm pack ${dir}\n${result.stderr}`);
  }
  for (const file of readdirSync(tarballDir)) {
    if (file.endsWith('.tgz')) tarballs.push(join(tarballDir, file));
  }
  if (tarballs.length !== PUBLISHED.length) {
    fail(`packed ${tarballs.length} tarballs, expected ${PUBLISHED.length}`);
  } else {
    ok(`packed ${tarballs.length} tarballs`);
  }

  // ── 2. Install into a plain npm project ────────────────────────────────
  step('installing into a non-workspace consumer');
  writeFileSync(
    join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'gezel-packed-consumer', private: true, type: 'module', version: '0.0.0' }, null, 2)}\n`,
  );
  const install = run('npm', ['install', '--no-audit', '--no-fund', ...tarballs], {
    cwd: consumer,
  });
  if (install.status !== 0) {
    fail(`npm install of the tarballs failed\n${install.stdout}\n${install.stderr}`);
    throw new Error('cannot continue without a successful install');
  }
  ok('npm install succeeded (including the native prebuild chain)');

  // ── 3. Import every public subpath ─────────────────────────────────────
  step('importing every public subpath');
  const importProbe = join(consumer, 'probe-imports.mjs');
  writeFileSync(
    importProbe,
    `${IMPORTABLE.map((s) => `await import(${JSON.stringify(s)});`).join('\n')}\nconsole.log('imports ok');\n`,
  );
  const imported = run(process.execPath, [importProbe], { cwd: consumer });
  if (imported.status !== 0) fail(`import probe failed\n${imported.stderr}`);
  else ok(`imported ${IMPORTABLE.length} subpaths`);

  // ── 4. The runtime-resolved specifiers ─────────────────────────────────
  step('resolving the runtime-resolved specifiers');
  const resolveProbe = join(consumer, 'probe-resolve.mjs');
  writeFileSync(
    resolveProbe,
    [
      "import { createRequire } from 'node:module';",
      'const require = createRequire(import.meta.url);',
      "require.resolve('@bendyline/gezel-service/dist/bin/gezeld.js');",
      "require.resolve('@bendyline/gezel-mcp/dist/server.js');",
      "require.resolve('@bendyline/gezel-connectors-spectral/run-action');",
      "import.meta.resolve('@bendyline/gezel-script-stdlib/package.json');",
      "import.meta.resolve('@bendyline/gezel-sdk/package.json');",
      "console.log('resolve ok');",
    ].join('\n'),
  );
  const resolved = run(process.execPath, [resolveProbe], { cwd: consumer });
  if (resolved.status !== 0) fail(`resolve probe failed\n${resolved.stderr}`);
  else ok('daemon, MCP server, spectral host, stdlib and SDK all resolve');

  // ── 5. The CLI binary ──────────────────────────────────────────────────
  step('running the installed CLI');
  const bin = join(consumer, 'node_modules', '.bin', 'gezel');
  for (const args of [['--version'], ['--help']]) {
    const result = run(bin, args, {
      cwd: consumer,
      env: { ...process.env, GEZEL_VERSION: '0.0.0-consumer' },
    });
    if (result.status !== 0) fail(`gezel ${args.join(' ')}\n${result.stderr}`);
    else ok(`gezel ${args.join(' ')}`);
  }

  // ── 6. Boot the installed daemon and drive one chat turn ───────────────
  if (process.env.GEZEL_CONSUMER_SKIP_DAEMON === '1') {
    step('daemon smoke (skipped via GEZEL_CONSUMER_SKIP_DAEMON=1)');
  } else {
    step('booting the installed daemon');
    await daemonSmoke(consumer);
  }
} finally {
  if (keep) console.log(`\nleft the consumer project at ${root}`);
  else rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} consumer check(s) failed`);
  process.exit(1);
}
console.log('\npacked-consumer checks passed');

/**
 * The end-to-end proof: the daemon a consumer installed from npm actually
 * boots, serves its API, and completes a chat turn with a tool call. Uses
 * the mock provider so no credentials and no network are involved.
 */
async function daemonSmoke(consumerDir) {
  const home = mkdtempSync(join(tmpdir(), 'gezel-consumer-home-'));
  const entry = join(
    consumerDir,
    'node_modules',
    '@bendyline',
    'gezel-service',
    'dist',
    'bin',
    'gezeld.js',
  );

  const child = spawn(process.execPath, [entry], {
    cwd: consumerDir,
    env: {
      ...process.env,
      GEZEL_HOME: home,
      GEZEL_MOCK_PROVIDER: '1',
      // First boot otherwise background-downloads Playwright/Chromium and an
      // on-device model. Neither belongs in a packaging smoke test.
      GEZEL_SKIP_SYSTEM_BOOTSTRAP: '1',
      GEZEL_SECRETS_BACKEND: 'file',
      // Plain HTTP on loopback. The daemon's normal transport is TLS with a
      // per-launch self-signed cert that clients trust by reading
      // runtime/cert.pem; reproducing that here would test the SDK's cert
      // plumbing, not the packaging, which is what this script is for.
      GEZEL_INSECURE_TRANSPORT: '1',
      GEZEL_LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  child.stdout.on('data', (d) => logs.push(d.toString()));
  child.stderr.on('data', (d) => logs.push(d.toString()));

  try {
    const runtime = await waitForRuntime(home, child);
    if (!runtime) {
      fail(`daemon never wrote its runtime files\n${logs.join('')}`);
      return;
    }

    const { GezelClient } = await import(
      join(consumerDir, 'node_modules', '@bendyline', 'gezel-client', 'dist', 'index.js')
    );
    const client = new GezelClient({ baseUrl: runtime.baseUrl, token: runtime.token });

    const health = await client.health();
    if (!health) fail('health probe returned nothing');
    else ok(`daemon healthy (version ${health.version ?? 'unknown'})`);

    const gezel = await client.createGezel({ name: 'Consumer Smoke', role: 'Tester' });
    if (!gezel?.id) fail('could not create a gezel');
    else ok(`created gezel ${gezel.id}`);

    // Assets staged into dist/ by a tsup onSuccess hook degrade silently when
    // the daemon cannot find them — it warns and serves less. In this repo the
    // source-checkout fallbacks mask that, so an installed tarball is the only
    // place the miss is visible.
    const output = logs.join('');
    for (const [asset, marker] of [
      ['handboek content', 'no handboek content tree found'],
      ['bundled web UI', 'no bundled UI'],
    ]) {
      if (output.includes(marker)) fail(`daemon could not find its ${asset} in an installed tree`);
      else ok(`daemon found its ${asset}`);
    }
  } catch (err) {
    fail(`daemon smoke: ${err.message}\n${logs.join('')}`);
  } finally {
    child.kill('SIGTERM');
    rmSync(home, { recursive: true, force: true });
  }
}

/** Poll `<home>/runtime/` until the daemon publishes its port and token. */
async function waitForRuntime(home, child) {
  const { readFile } = await import('node:fs/promises');
  const runtimeDir = join(home, 'runtime');
  const deadline = Date.now() + 90_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) return null;
    try {
      const [port, token] = await Promise.all([
        readFile(join(runtimeDir, 'port'), 'utf8'),
        readFile(join(runtimeDir, 'auth-token'), 'utf8').catch(() =>
          readFile(join(runtimeDir, 'token'), 'utf8'),
        ),
      ]);
      if (port.trim() && token.trim()) {
        return { baseUrl: `http://127.0.0.1:${port.trim()}`, token: token.trim() };
      }
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}
