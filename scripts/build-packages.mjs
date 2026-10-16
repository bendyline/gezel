#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, openSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withBuildOutputLease, withDependencyReadLease } from './dependency-lease.mjs';
import { spawnPnpm } from './pnpm-cli.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function stage(name, packages, script = 'build') {
  return {
    name,
    args: [
      ...(packages.length > 1 ? ['-r'] : []),
      ...packages.flatMap((name) => ['--filter', `@bendyline/${name}`]),
      'run',
      script,
    ],
  };
}

// Dependencies finish before their consumers start. The UI and Office assets
// must exist before service/app packaging copies them into its own dist tree.
export const PACKAGE_BUILD_STAGES = [
  stage('gezk', ['gezk']),
  stage('core', ['gezel']),
  stage('shared packages', [
    'gezel-client',
    'gezel-plugin-sdk',
    'gezel-sdk',
    'gezel-app-sdk',
    'gezel-capacitor',
    'gezel-catalog',
    'gezel-knowledge',
    'gezel-connectors-spectral',
  ]),
  stage('inference', ['gezel-inference']),
  stage('script runtime', ['gezel-script-runtime']),
  stage('MCP', ['gezel-mcp']),
  stage('UI', ['gezel-ui'], 'build:all'),
  stage('LibreOffice extension', ['gezel-libreoffice-extension']),
  stage('service', ['gezel-service']),
  stage('CLI, Electron, and VS Code', ['gezel-cli', 'gezel-app', 'gezel-vscode']),
];

async function runStage(buildStage, options) {
  const { env, log, stdout, stderr, setChildPid, spawnPnpmFn } = options;
  const command = `pnpm ${buildStage.args.join(' ')}`;
  const heading = `[build] ${buildStage.name}: ${command}\n`;
  log(heading);
  stdout.write(heading);
  let child;
  try {
    child = spawnPnpmFn(buildStage.args, {
      cwd: options.repoRoot,
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
  } catch (error) {
    const message = `[build] Could not start ${buildStage.name}: ${error.message}\n`;
    log(message);
    stderr.write(message);
    return 1;
  }
  let launchError;
  let outputError;
  let errorTail = '';
  const completion = new Promise((resolveDone) => {
    child.once('error', (error) => {
      launchError = error;
    });
    child.once('close', (code, signal) => resolveDone({ code, signal }));
  });
  const forward = (destination, chunk) => {
    try {
      log(chunk);
      destination.write(chunk);
    } catch (error) {
      outputError ??= error;
      child.kill('SIGTERM');
    }
  };
  child.stdout.on('data', (chunk) => forward(stdout, chunk));
  child.stderr.on('data', (chunk) => {
    errorTail = (errorTail + chunk.toString()).slice(-16_384);
    forward(stderr, chunk);
  });
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', terminate);
  try {
    try {
      await setChildPid(child.pid);
    } catch (error) {
      launchError ??= error;
      child.kill('SIGTERM');
    }
    const { code, signal } = await completion;
    const failure = launchError ?? outputError;
    const status = failure || signal ? 1 : (code ?? 1);
    const message =
      status === 0
        ? `[build] ${buildStage.name} completed\n`
        : `[build] FAILED: ${buildStage.name} (${failure?.message ?? signal ?? `exit code ${status}`}): ${command}\n`;
    log(message);
    (status === 0 ? stdout : stderr).write(message);
    // A tsup hook can fail before its parallel DTS worker prints a long list
    // of successful outputs. Repeat stderr after that list so it stays visible.
    if (status !== 0 && errorTail.trim()) stderr.write(`[build] Error output:\n${errorTail}\n`);
    return status;
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
  }
}

export async function runPackageBuilds(options = {}) {
  const root = options.repoRoot ?? repoRoot;
  const inheritedEnv = { ...(options.env ?? process.env) };
  // Keep routine logs out of builds while allowing an explicit debugging override.
  inheritedEnv.GEZEL_LOG_LEVEL ||= 'warn';
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  return withDependencyReadLease(
    root,
    ({ leaseEnv: dependencyEnv, setChildPid: setDependencyChildPid }) =>
      withBuildOutputLease(
        root,
        async ({ leaseEnv: buildEnv, setChildPid }) => {
          const logDir = options.logDir ?? join(root, '.cache', 'build-logs');
          await mkdir(logDir, { recursive: true });
          const logPath = join(
            logDir,
            `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}.log`,
          );
          const logFd = openSync(logPath, 'wx');
          const log = (chunk) => appendFileSync(logFd, chunk);
          stdout.write(`[build] Full log: ${logPath}\n`);
          try {
            for (const buildStage of options.stages ?? PACKAGE_BUILD_STAGES) {
              const code = await runStage(buildStage, {
                repoRoot: root,
                env: { ...inheritedEnv, ...dependencyEnv, ...buildEnv },
                log,
                stdout,
                stderr,
                setChildPid: (pid) => Promise.all([setChildPid(pid), setDependencyChildPid(pid)]),
                spawnPnpmFn: options.spawnPnpmFn ?? spawnPnpm,
              });
              if (code !== 0) {
                stderr.write(`[build] Full log: ${logPath}\n`);
                return code;
              }
            }
            return 0;
          } finally {
            closeSync(logFd);
          }
        },
        { env: inheritedEnv, command: 'pnpm build:packages' },
      ),
    { env: inheritedEnv, command: 'pnpm build:packages' },
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runPackageBuilds().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`[build] ${error.stack ?? error}`);
      process.exitCode = 1;
    },
  );
}
