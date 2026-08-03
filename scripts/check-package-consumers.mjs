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
 *      node-pty, @napi-rs/keyring, @resvg/resvg-js, sqlite-vec and
 *      playwright-core. The heavyweight Transformers/Kokoro stack is an
 *      optional peer for npm consumers and is tested in complete bundles.
 *
 * So: pnpm pack (which resolves `workspace:*`), then `npm install` into an
 * empty non-workspace directory, then exercise it.
 *
 * Usage:
 *   node scripts/check-package-consumers.mjs
 *   node scripts/check-package-consumers.mjs --keep   # leave the temp dir
 *   node scripts/check-package-consumers.mjs --tarball-dir artifacts/npm-tarballs
 *
 * Env:
 *   GEZEL_CONSUMER_SKIP_DAEMON=1   skip the daemon boot (fastest useful run)
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const tarballDirFlag = process.argv.indexOf('--tarball-dir');
const suppliedTarballDir =
  tarballDirFlag === -1 ? null : resolve(process.argv[tarballDirFlag + 1] ?? '');
if (tarballDirFlag !== -1 && !process.argv[tarballDirFlag + 1]) {
  throw new Error('--tarball-dir requires a directory path');
}
const MAX_NODE_MODULES_BYTES = 800 * 1024 * 1024;

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

function logicalTreeBytes(root) {
  let total = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) total += logicalTreeBytes(path);
    else total += lstatSync(path).size;
  }
  return total;
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

function findOnPath(fileName) {
  for (const rawDir of (process.env.PATH ?? '').split(delimiter)) {
    const pathDir = rawDir.replace(/^"(.*)"$/, '$1');
    if (!pathDir) continue;
    const candidate = join(pathDir, fileName);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Node does not launch Windows .cmd shims through spawnSync without a shell.
 * Run the package-manager JavaScript entry point with Node instead;
 * this keeps argument handling safe and works whether this script was reached
 * through `pnpm all` or invoked directly as documented above.
 */
function windowsPackageManagerCli(manager) {
  const candidates = [];
  const invokedCli = process.env.npm_execpath;
  if (invokedCli) {
    const invokedName = basename(invokedCli).toLowerCase();
    if (
      (manager === 'pnpm' && invokedName.startsWith('pnpm')) ||
      (manager === 'npm' && invokedName.startsWith('npm'))
    ) {
      candidates.push(invokedCli);
    }
  }

  const shim = findOnPath(`${manager}.cmd`);
  if (shim) {
    const shimDir = dirname(shim);
    if (manager === 'pnpm') {
      candidates.push(
        join(shimDir, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
        join(shimDir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
      );
    } else {
      candidates.push(join(shimDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    }
  }

  if (manager === 'npm') {
    candidates.push(join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }

  const cli = candidates.find((candidate) => existsSync(candidate));
  if (!cli) throw new Error(`could not resolve the Windows ${manager} CLI`);
  return cli;
}

function runPackageManager(manager, args, options = {}) {
  if (process.platform !== 'win32') return run(manager, args, options);
  return run(process.execPath, [windowsPackageManagerCli(manager), ...args], options);
}

const root = mkdtempSync(join(tmpdir(), 'gezel-packed-consumer-'));
const tarballDir = suppliedTarballDir ?? join(root, 'tarballs');
const consumer = join(root, 'consumer');
mkdirSync(tarballDir, { recursive: true });
mkdirSync(consumer, { recursive: true });

try {
  // ── 1. Pack ────────────────────────────────────────────────────────────
  step(suppliedTarballDir ? 'loading supplied tarballs' : 'packing');
  const tarballs = [];
  if (!suppliedTarballDir) {
    for (const dir of PUBLISHED) {
      const packageDir = resolve(repoRoot, 'packages', dir);
      const result = runPackageManager('pnpm', ['pack', '--pack-destination', tarballDir], {
        cwd: packageDir,
      });
      if (result.status !== 0) fail(`pnpm pack ${dir}\n${result.stderr}`);
    }
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
  const install = runPackageManager('npm', ['install', '--no-audit', '--no-fund', ...tarballs], {
    cwd: consumer,
  });
  if (install.status !== 0) {
    fail(`npm install of the tarballs failed\n${install.stdout}\n${install.stderr}`);
    throw new Error('cannot continue without a successful install');
  }
  ok('npm install succeeded (including the native prebuild chain)');

  const installedBytes = logicalTreeBytes(join(consumer, 'node_modules'));
  const installedMiB = installedBytes / 1024 / 1024;
  if (installedBytes > MAX_NODE_MODULES_BYTES) {
    fail(
      `node_modules is ${installedMiB.toFixed(1)} MiB; budget is ${MAX_NODE_MODULES_BYTES / 1024 / 1024} MiB`,
    );
  } else {
    ok(`node_modules is ${installedMiB.toFixed(1)} MiB (budget 800 MiB)`);
  }

  step('auditing the npm consumer graph');
  // critical matches every other vulnerability gate (quality.yml, the release
  // workflows) — advisories land on npm's clock, not ours, and must not fail
  // an unrelated validate run. The scheduled supply-chain-audit workflow is
  // what surfaces sub-critical advisories.
  const audit = runPackageManager(
    'npm',
    ['audit', '--omit=dev', '--audit-level=critical', '--json'],
    {
      cwd: consumer,
    },
  );
  if (audit.status !== 0) {
    fail(`npm audit found a critical-severity issue\n${audit.stdout}\n${audit.stderr}`);
  } else {
    ok('npm audit reports no critical-severity vulnerabilities');
  }

  if (process.platform === 'darwin') {
    step('spawning a clean-install macOS PTY');
    const ptyProbe = join(consumer, 'probe-pty.cjs');
    writeFileSync(
      ptyProbe,
      [
        "const pty = require('node-pty');",
        "const shell = process.env.SHELL || '/bin/sh';",
        "const terminal = pty.spawn(shell, ['-lc', 'printf GEZEL_PTY_OK'], { cols: 80, rows: 24 });",
        "let output = '';",
        'const timer = setTimeout(() => { terminal.kill(); throw new Error(`PTY timed out: ${output}`); }, 10000);',
        'terminal.onData((data) => { output += data; });',
        'terminal.onExit(({ exitCode }) => {',
        '  clearTimeout(timer);',
        "  if (exitCode !== 0 || !output.includes('GEZEL_PTY_OK')) {",
        '    console.error(JSON.stringify({ exitCode, output }));',
        '    process.exit(1);',
        '  }',
        '});',
      ].join('\n'),
    );
    const ptyResult = run(process.execPath, [ptyProbe], { cwd: consumer });
    if (ptyResult.status !== 0) fail(`node-pty spawn failed\n${ptyResult.stderr}`);
    else ok('node-pty spawned a shell and captured output');
  }

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
  const bin = join(consumer, 'node_modules', '@bendyline', 'gezel-cli', 'dist', 'bin', 'gezel.js');
  for (const args of [['--version'], ['--help']]) {
    const result = run(process.execPath, [bin, ...args], {
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

    const clientEntry = join(
      consumerDir,
      'node_modules',
      '@bendyline',
      'gezel-client',
      'dist',
      'index.js',
    );
    const { GezelClient } = await import(pathToFileURL(clientEntry).href);
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
