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
 *      @napi-rs/keyring, @resvg/resvg-js, sqlite-vec and playwright-core.
 *      node-pty and the heavyweight Transformers/Kokoro stack are optional
 *      peers for npm consumers and are tested separately in complete bundles.
 *
 * So: pnpm pack (which resolves `workspace:*`), then `npm install` into an
 * empty non-workspace directory, then exercise it.
 *
 * Usage:
 *   node scripts/check-package-consumers.mjs
 *   node scripts/check-package-consumers.mjs --keep   # leave the temp dir
 *   node scripts/check-package-consumers.mjs --tarball-dir artifacts/npm-tarballs
 *   node scripts/check-package-consumers.mjs --require-release-stamp --tarball-dir artifacts/npm-tarballs
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
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as tar from 'tar';
import { PUBLISHED_PACKAGE_DIRS, publishedPackageNames } from './published-packages.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
validateArgs(process.argv.slice(2));
const keep = process.argv.includes('--keep');
const requireReleaseStamp = process.argv.includes('--require-release-stamp');
const tarballDirFlag = process.argv.indexOf('--tarball-dir');
const suppliedTarballDir =
  tarballDirFlag === -1 ? null : resolve(process.argv[tarballDirFlag + 1] ?? '');
if (tarballDirFlag !== -1 && !process.argv[tarballDirFlag + 1]) {
  throw new Error('--tarball-dir requires a directory path');
}
const MAX_NODE_MODULES_BYTES = 800 * 1024 * 1024;

function validateArgs(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--keep' || arg === '--require-release-stamp') continue;
    if (arg === '--tarball-dir') {
      index += 1;
      if (!args[index] || args[index].startsWith('--')) {
        throw new Error('--tarball-dir requires a directory path');
      }
      continue;
    }
    throw new Error(`unexpected argument ${JSON.stringify(arg)}`);
  }
}

const PUBLISHED = PUBLISHED_PACKAGE_DIRS;
const PUBLISHED_NAMES = publishedPackageNames(repoRoot);
const RUNTIME_DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];

/**
 * Subpaths a consumer must be able to `import()` under plain node. Kept to
 * the surfaces that do not spin up heavy machinery on import.
 */
const IMPORTABLE = [
  '@bendyline/gezk',
  '@bendyline/gezk/node',
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
  '@bendyline/gezel-knowledge',
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

function auditTarballArchive(tarball) {
  const names = new Set();
  tar.list({
    file: tarball,
    sync: true,
    onReadEntry(entry) {
      const path = entry.path.replaceAll('\\', '/');
      if (!path.startsWith('package/') || path.startsWith('/') || path.split('/').includes('..')) {
        fail(`${basename(tarball)} contains an unsafe archive path: ${JSON.stringify(path)}`);
      }
      if (!['File', 'Directory'].includes(entry.type)) {
        fail(`${basename(tarball)} contains unexpected ${entry.type} entry ${path}`);
      }
      if (names.has(path)) fail(`${basename(tarball)} contains duplicate archive entry ${path}`);
      names.add(path);
      entry.resume();
    },
  });
}

const SENSITIVE_PATH =
  /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.yarnrc|id_(?:rsa|dsa|ecdsa|ed25519)|credentials?(?:\.[^/]*)?|[^/]+\.(?:pem|p12|pfx|jks|keystore|key))(?:$|\/)/i;
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,255}\b/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
];

function auditInstalledPackage(root, packageName) {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relative = path.slice(root.length + 1).replaceAll('\\', '/');
      if (entry.isSymbolicLink()) {
        fail(`${packageName} contains a symlink: ${relative}`);
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (SENSITIVE_PATH.test(relative)) {
        fail(`${packageName} contains a credential-like path: ${relative}`);
      }
      const content = readFileSync(path);
      // Skip binary payloads. Packed text is small enough to scan in full.
      if (content.includes(0)) continue;
      const text = content.toString('utf8');
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(text)) {
          fail(`${packageName} contains high-confidence secret material in ${relative}`);
        }
      }
    }
  }
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
  for (const tarball of tarballs) auditTarballArchive(tarball);
  ok('tarball archives contain only unique, package-scoped regular files and directories');

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
  const installOutput = `${install.stdout}\n${install.stderr}`;
  const installedNodePty = join(consumer, 'node_modules', 'node-pty', 'package.json');
  if (existsSync(installedNodePty)) {
    fail('npm unexpectedly auto-installed the optional node-pty peer');
  } else if (/node-pty/i.test(installOutput)) {
    fail(`default npm install mentioned node-pty\n${installOutput}`);
  } else {
    ok('npm install succeeded without installing or warning about node-pty');
  }

  step('validating the installed Gezel release graph');
  const installedManifests = new Map(
    PUBLISHED_NAMES.map((name) => {
      const path = join(consumer, 'node_modules', ...name.split('/'), 'package.json');
      if (!existsSync(path)) {
        fail(`installed release set is missing ${name}`);
        return [name, null];
      }
      return [name, JSON.parse(readFileSync(path, 'utf8'))];
    }),
  );
  for (const [name, manifest] of installedManifests) {
    if (!manifest) continue;
    for (const field of RUNTIME_DEPENDENCY_FIELDS) {
      for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
        const sibling = installedManifests.get(dependency);
        if (!sibling) continue;
        if (range !== sibling.version) {
          fail(
            `${name} → ${dependency} in ${field} is ${range}; release set has ${sibling.version}`,
          );
        }
      }
    }
  }
  const coreVersion = installedManifests.get('@bendyline/gezel')?.version;
  if (!coreVersion) fail('could not determine installed @bendyline/gezel version');
  else ok(`all internal runtime pins match the ${coreVersion} release set`);

  // Every published package must come from a candidate tarball, never from
  // the registry. Version pins cannot tell the two apart — a candidate and
  // its already-published namesake carry the same version — so read npm's
  // own record of where each tree came from. This is the failure mode that
  // hid behind the rehearsal's missing `gezk`: with one tarball absent, npm
  // silently satisfied that dependency from registry.npmjs.org and every
  // later check validated the published package instead of the build.
  const lockPath = join(consumer, 'package-lock.json');
  if (!existsSync(lockPath)) {
    fail('npm wrote no package-lock.json, so tarball provenance cannot be verified');
  } else {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    const fromRegistry = PUBLISHED_NAMES.filter((name) => {
      const entry = lock.packages?.[`node_modules/${name}`];
      return !entry || !String(entry.resolved ?? '').startsWith('file:');
    });
    if (fromRegistry.length > 0) {
      fail(
        `installed from the registry instead of a candidate tarball: ${fromRegistry.join(', ')}`,
      );
    } else {
      ok(`all ${PUBLISHED_NAMES.length} packages resolved from candidate tarballs`);
    }
  }

  for (const name of PUBLISHED_NAMES) {
    auditInstalledPackage(join(consumer, 'node_modules', ...name.split('/')), name);
  }
  ok('installed package payloads contain no symlinks, credential-like paths, or known token forms');

  const spectralRoot = join(consumer, 'node_modules', '@bendyline', 'gezel-connectors-spectral');
  for (const relative of [
    'NOTICE.md',
    'THIRD_PARTY_LICENSES/Apache-2.0.txt',
    'vendor/provenance.json',
  ]) {
    if (!existsSync(join(spectralRoot, relative)))
      fail(`installed Spectral host is missing ${relative}`);
  }
  for (const relative of ['dist/index.js', 'dist/run-action.js']) {
    const source = readFileSync(join(spectralRoot, relative), 'utf8');
    if (!source.includes('Includes modified portions of prismatic-io/components')) {
      fail(`installed Spectral host ${relative} is missing its Apache modification banner`);
    }
  }
  ok('installed Spectral host carries its Apache license, notice, provenance, and banners');

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
  // workflows, and the daily report). Lower-severity advisories remain visible
  // without failing an unrelated validate run.
  const audit = runPackageManager(
    'npm',
    ['audit', '--omit=dev', '--audit-level=critical', '--json'],
    {
      cwd: consumer,
    },
  );
  let auditCounts = null;
  try {
    const parsed = JSON.parse(audit.stdout);
    auditCounts = parsed?.metadata?.vulnerabilities ?? null;
  } catch {
    fail(`npm audit did not return valid JSON\n${audit.stdout}\n${audit.stderr}`);
  }
  if (audit.status !== 0) {
    fail(`npm audit found a critical-severity issue\n${audit.stdout}\n${audit.stderr}`);
  } else {
    ok('npm audit reports no critical-severity vulnerabilities');
  }
  if (auditCounts) {
    const summary = ['info', 'low', 'moderate', 'high', 'critical']
      .map((severity) => `${severity}=${Number(auditCounts[severity] ?? 0)}`)
      .join(', ');
    console.log(`  note npm audit production counts: ${summary}`);
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

  step('typechecking installed declarations with skipLibCheck=false');
  const typeProbe = join(consumer, 'probe-types.mts');
  writeFileSync(
    typeProbe,
    `${IMPORTABLE.map((specifier) => `import ${JSON.stringify(specifier)};`).join('\n')}\n`,
  );
  writeFileSync(
    join(consumer, 'tsconfig.consumer.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          skipLibCheck: false,
          noEmit: true,
          types: ['node'],
        },
        files: ['./probe-types.mts'],
      },
      null,
      2,
    )}\n`,
  );
  const typecheck = run(
    process.execPath,
    [join(consumer, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.consumer.json'],
    { cwd: consumer },
  );
  if (typecheck.status !== 0) {
    fail(`installed declaration typecheck failed\n${typecheck.stdout}\n${typecheck.stderr}`);
  } else {
    ok('installed declarations typecheck without skipping library errors');
  }

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

  step('running installed MCP and Spectral subprocess protocols');
  const mcpProbe = join(consumer, 'probe-mcp.mjs');
  writeFileSync(
    mcpProbe,
    [
      "import { Client } from '@modelcontextprotocol/sdk/client/index.js';",
      "import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';",
      `const server = ${JSON.stringify(join(consumer, 'node_modules', '@bendyline', 'gezel-mcp', 'dist', 'server.js'))};`,
      'const transport = new StdioClientTransport({',
      '  command: process.execPath,',
      '  args: [server],',
      '  env: {',
      "    GEZEL_BASE_URL: 'http://127.0.0.1:9',",
      "    GEZEL_TOKEN: 'consumer-smoke',",
      "    GEZEL_AGENT_ID: 'consumer-smoke',",
      "    GEZEL_PROJECT_ID: 'default',",
      `    GEZEL_HOME: ${JSON.stringify(join(root, 'mcp-home'))},`,
      '  },',
      '});',
      "const client = new Client({ name: 'package-smoke', version: '0.0.0' });",
      'await client.connect(transport);',
      'const result = await client.listTools();',
      "if (!Array.isArray(result.tools) || result.tools.length < 100) throw new Error('MCP tool surface is incomplete');",
      'console.log(result.tools.length);',
      'await client.close();',
    ].join('\n'),
  );
  const mcp = run(process.execPath, [mcpProbe], { cwd: consumer });
  if (mcp.status !== 0) fail(`MCP stdio smoke failed\n${mcp.stdout}\n${mcp.stderr}`);
  else ok(`MCP initialized over stdio and listed ${mcp.stdout.trim()} tools`);

  const spectralEntry = join(spectralRoot, 'dist', 'run-action.js');
  const spectral = run(process.execPath, [spectralEntry], {
    cwd: consumer,
    input: JSON.stringify({
      component: 'echo',
      action: 'list',
      inputs: { records: [{ id: 'consumer-smoke' }] },
    }),
  });
  let spectralData;
  try {
    spectralData = JSON.parse(spectral.stdout).data;
  } catch {
    // The failure below includes stdout/stderr.
  }
  if (spectral.status !== 0 || spectralData?.[0]?.id !== 'consumer-smoke') {
    fail(`Spectral subprocess smoke failed\n${spectral.stdout}\n${spectral.stderr}`);
  } else {
    ok('Spectral subprocess executed echo/list through its packed entry point');
  }

  // ── 5. The CLI binary ──────────────────────────────────────────────────
  step('running the installed CLI');
  const bin = join(consumer, 'node_modules', '@bendyline', 'gezel-cli', 'dist', 'bin', 'gezel.js');
  const cliVersionResult = run(process.execPath, [bin, '--version'], {
    cwd: consumer,
    env: { ...process.env, GEZEL_VERSION: '0.0.0-consumer' },
  });
  const cliVersion = cliVersionResult.stdout.trim();
  if (cliVersionResult.status !== 0) {
    fail(`gezel --version\n${cliVersionResult.stderr}`);
  } else if (requireReleaseStamp && cliVersion !== coreVersion) {
    fail(`gezel --version printed ${JSON.stringify(cliVersion)}; expected ${coreVersion}`);
  } else {
    ok(`gezel --version (${cliVersion})`);
  }
  for (const args of [['--help'], ['native', '--help']]) {
    const result = run(process.execPath, [bin, ...args], {
      cwd: consumer,
      env: { ...process.env, GEZEL_VERSION: '0.0.0-consumer' },
    });
    if (result.status !== 0) fail(`gezel ${args.join(' ')}\n${result.stderr}`);
    else ok(`gezel ${args.join(' ')}`);
  }

  // A fresh-home one-shot owns an in-process daemon. Its structured startup
  // and shutdown logs must stay off stdout so shell pipelines receive exactly
  // the reply and trailing newline.
  const cliRunHome = mkdtempSync(join(tmpdir(), 'gezel-packed-cli-run-'));
  const cliRunPrompt = 'Reply exactly with: packed-cli-stdout-only';
  try {
    const result = run(
      process.execPath,
      [bin, '--home', cliRunHome, '--standalone', 'run', cliRunPrompt],
      {
        cwd: consumer,
        env: {
          ...process.env,
          GEZEL_HOME: cliRunHome,
          GEZEL_MOCK_PROVIDER: '1',
          GEZEL_DISABLE_MACHINE_ENGINE: '1',
          GEZEL_SKIP_SYSTEM_BOOTSTRAP: '1',
          GEZEL_SECRETS_BACKEND: 'file',
          GEZEL_LOG_LEVEL: 'info',
        },
        timeout: 60_000,
      },
    );
    const expected = `Mock reply: ${cliRunPrompt}\n`;
    if (result.status !== 0) {
      fail(`gezel run failed\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    } else if (result.stdout !== expected) {
      fail(
        `gezel run polluted stdout\nexpected: ${JSON.stringify(expected)}\nactual:   ${JSON.stringify(result.stdout)}\nstderr: ${result.stderr}`,
      );
    } else {
      ok('gezel run keeps stdout reply-only');
    }
  } finally {
    rmSync(cliRunHome, { recursive: true, force: true });
  }

  // The warm path, and the one an npm-only user actually hits. Any command
  // that starts a daemon — `gezel start`, or a read-only `gezel agent list` —
  // leaves one running, and `run` must then adopt it with the same-user
  // runtime credential. It used to open a Connected Apps consent handshake
  // and block for five minutes on a code that can only be typed into the
  // desktop app, which this install does not have. The cold case above cannot
  // see that: `run` only owns an in-process service when nothing is running.
  const cliWarmHome = mkdtempSync(join(tmpdir(), 'gezel-packed-cli-warm-'));
  const cliWarmPrompt = 'Reply exactly with: packed-cli-adopted-daemon';
  const cliWarmEnv = {
    ...process.env,
    GEZEL_HOME: cliWarmHome,
    GEZEL_MOCK_PROVIDER: '1',
    GEZEL_DISABLE_MACHINE_ENGINE: '1',
    GEZEL_SKIP_SYSTEM_BOOTSTRAP: '1',
    GEZEL_SECRETS_BACKEND: 'file',
    GEZEL_LOG_LEVEL: 'warn',
  };
  try {
    const armed = run(
      process.execPath,
      [bin, '--home', cliWarmHome, '--standalone', 'agent', 'list'],
      { cwd: consumer, env: cliWarmEnv, timeout: 60_000 },
    );
    if (armed.status !== 0) {
      fail(`gezel agent list failed\nstdout: ${armed.stdout}\nstderr: ${armed.stderr}`);
    } else {
      const result = run(
        process.execPath,
        [bin, '--home', cliWarmHome, '--standalone', 'run', cliWarmPrompt],
        // Well under the CLI's 300s approval timeout, so a regression fails
        // here instead of quietly waiting five minutes for a human.
        { cwd: consumer, env: cliWarmEnv, timeout: 90_000 },
      );
      const expectedWarm = `Mock reply: ${cliWarmPrompt}\n`;
      if (result.status !== 0 || /Open the Gezel app|Waiting for approval/.test(result.stderr)) {
        fail(
          `gezel run against a running daemon asked for desktop approval\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
        );
      } else if (result.stdout !== expectedWarm) {
        fail(
          `gezel run against a running daemon polluted stdout\nexpected: ${JSON.stringify(expectedWarm)}\nactual:   ${JSON.stringify(result.stdout)}\nstderr: ${result.stderr}`,
        );
      } else {
        ok('gezel run adopts an already-running daemon without desktop approval');
      }
    }
  } finally {
    run(process.execPath, [bin, '--home', cliWarmHome, '--standalone', 'stop', '--daemon'], {
      cwd: consumer,
      env: cliWarmEnv,
      timeout: 60_000,
    });
    rmSync(cliWarmHome, { recursive: true, force: true });
  }

  // ── 6. Default install: boot without the optional PTY peer ─────────────
  if (process.env.GEZEL_CONSUMER_SKIP_DAEMON === '1') {
    step('daemon smoke without node-pty (skipped via GEZEL_CONSUMER_SKIP_DAEMON=1)');
    const probe = run(
      process.execPath,
      ['--input-type=module', '-e', "await import('@bendyline/gezel-service')"],
      { cwd: consumer },
    );
    if (probe.status !== 0) fail(`service import without node-pty failed\n${probe.stderr}`);
    else ok('service imports without node-pty');
  } else {
    step('booting the default install without node-pty');
    await daemonSmoke(consumer, {
      pty: 'unavailable',
      expectedVersion: requireReleaseStamp ? coreVersion : undefined,
    });
  }

  // ── 7. Explicit terminal opt-in ────────────────────────────────────────
  // Optional peers are never auto-installed by npm. Prove the instruction in
  // the terminal error is sufficient: install node-pty beside Gezel and then
  // exercise the real terminal path through the same packed daemon.
  step('installing the optional terminal peer explicitly');
  const ptyInstall = runPackageManager(
    'npm',
    ['install', '--no-save', '--no-audit', '--no-fund', 'node-pty@^1.1.0'],
    { cwd: consumer },
  );
  if (ptyInstall.status !== 0) {
    fail(`explicit npm install node-pty failed\n${ptyInstall.stdout}\n${ptyInstall.stderr}`);
    throw new Error('cannot continue without the explicit terminal peer');
  }
  if (!existsSync(installedNodePty)) {
    fail('npm install node-pty succeeded but the package is absent');
  } else {
    ok('npm install node-pty supplied the optional terminal peer');
  }

  if (process.env.GEZEL_CONSUMER_SKIP_DAEMON !== '1') {
    step('restarting the installed daemon with node-pty');
    await daemonSmoke(consumer, {
      pty: 'available',
      expectedVersion: requireReleaseStamp ? coreVersion : undefined,
    });
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
 * boots, serves its API, and creates a gezel. The default npm install proves
 * the daemon stays healthy and returns an actionable terminal-unavailable
 * result without node-pty. The explicit opt-in pass runs a real PTY command on
 * macOS. Uses the mock provider so no credentials and no network are involved.
 */
async function daemonSmoke(consumerDir, opts = {}) {
  const pty = opts.pty ?? 'available';
  const expectedVersion = opts.expectedVersion;
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
      // A developer workstation may already have the packaged machine-engine
      // broker installed. This smoke test is proving only what the packed npm
      // service can provide, so do not let broker capabilities (such as the
      // bundled Kokoro runtime) leak into its catalog responses.
      GEZEL_DISABLE_MACHINE_ENGINE: '1',
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
    if (!health) {
      fail('health probe returned nothing');
    } else if (health.machineEngineConnected) {
      fail('clean npm consumer unexpectedly connected to a machine-engine broker');
    } else if (expectedVersion && health.version !== expectedVersion) {
      fail(`daemon health reports ${health.version ?? 'unknown'}; expected ${expectedVersion}`);
    } else {
      ok(
        pty === 'unavailable'
          ? `daemon healthy without node-pty (version ${health.version ?? 'unknown'})`
          : `daemon healthy (version ${health.version ?? 'unknown'})`,
      );
    }

    const gezel = await client.createGezel({ name: 'Consumer Smoke', role: 'Tester' });
    if (!gezel?.id) fail('could not create a gezel');
    else ok(`created gezel ${gezel.id}`);

    if (pty === 'unavailable') {
      const audioCatalog = await client.listAudioCatalog();
      if (audioCatalog.tts.length === 0) {
        ok('default npm service does not advertise the unavailable Kokoro runtime');
      } else {
        fail(
          `default npm service advertised unavailable TTS models\n${JSON.stringify(audioCatalog.tts)}`,
        );
      }
    }

    // npm can install node-pty's macOS spawn-helper without its execute bit.
    // Exercise the Gezel terminal path rather than raw node-pty: the service's
    // lazy pre-spawn repair is the supported behavior for published consumers.
    if (pty === 'unavailable') {
      step('running the first terminal command without node-pty');
      const { threadId } = await client.runTerminalCommand('default', {
        workingDir: '',
        input: 'printf GEZEL_PTY_SHOULD_NOT_RUN',
      });
      const terminalOutput = await waitForTerminalOutput(client, 'default', threadId);
      if (
        terminalOutput?.exitCode === -1 &&
        terminalOutput.errorMessage === 'shell-failed' &&
        /npm install node-pty/i.test(terminalOutput.content)
      ) {
        ok('terminal gives npm install instructions without crashing the daemon');
      } else {
        fail(`missing-node-pty terminal result was not stable\n${JSON.stringify(terminalOutput)}`);
      }
    } else if (process.platform === 'darwin') {
      step('spawning a clean-install macOS PTY through the daemon');
      const { threadId } = await client.runTerminalCommand('default', {
        workingDir: '',
        input: 'printf GEZEL_PTY_OK',
      });
      const terminalOutput = await waitForTerminalOutput(client, 'default', threadId);
      if (terminalOutput?.exitCode === 0 && terminalOutput.content.includes('GEZEL_PTY_OK')) {
        ok('daemon terminal spawned node-pty and captured output');
      } else {
        fail(`daemon terminal PTY failed\n${JSON.stringify(terminalOutput)}`);
      }
    }

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

/** Poll the durable terminal thread until its asynchronous output row lands. */
async function waitForTerminalOutput(client, projectId, threadId) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const thread = await client.getTerminalThread(projectId, threadId);
    const output = thread.messages.findLast((message) => message.kind === 'output');
    if (output) return output;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
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
