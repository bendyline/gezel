#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { withBuildOutputLease, withDependencyReadLease } from './dependency-lease.mjs';
import { spawnPnpm } from './pnpm-cli.mjs';
import { runPreparedFrozenInstall, withPnpmInstallLock } from './pnpm-install.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptsDir, '..');

/**
 * publish-npm.yml runs `validate:unlocked` across parallel runners, because the
 * serial chain outgrew one job's time limit. Each phase here takes steps out of
 * the chain and runs them on a runner of its own, after `pnpm build`. `main`
 * runs every step no phase takes, so a check added to `validate:unlocked`
 * reaches the release without an edit to this table or to the workflow.
 */
export const MAIN_VALIDATION_PHASE = 'main';
export const RELEASE_VALIDATION_PHASES = {
  stability: {
    takes: ['pnpm test:stability'],
    // One pass per runner: the release matrix runs this phase twice, the two
    // passes `test:stability` runs back to back.
    runs: ['pnpm test:stability:pass'],
  },
  e2e: {
    takes: [
      'pnpm test:e2e:run',
      'pnpm test:e2e:desktop:smoke',
      'pnpm pw:install',
      'pnpm test:e2e:web:run',
      'pnpm test:e2e:web:smoke',
    ],
  },
};
export const VALIDATION_PHASE_NAMES = [
  MAIN_VALIDATION_PHASE,
  ...Object.keys(RELEASE_VALIDATION_PHASES),
];

export function validationPhaseSteps(chain, phase) {
  const steps = chain.split(' && ');
  for (const [name, { takes }] of Object.entries(RELEASE_VALIDATION_PHASES)) {
    const missing = takes.filter((step) => !steps.includes(step));
    if (missing.length > 0) {
      throw new Error(
        `validate:unlocked no longer runs ${missing.join(', ')}; update the ${name} phase in scripts/validate-workspace.mjs`,
      );
    }
  }
  if (phase === MAIN_VALIDATION_PHASE) {
    const taken = new Set(Object.values(RELEASE_VALIDATION_PHASES).flatMap(({ takes }) => takes));
    return steps.filter((step) => !taken.has(step));
  }
  const definition = RELEASE_VALIDATION_PHASES[phase];
  if (!definition) throw new Error(`unknown validation phase "${phase}"`);
  return ['pnpm build', ...(definition.runs ?? definition.takes)];
}

export function validationStepScript(step) {
  const match = /^pnpm ([\w:.-]+)$/.exec(step);
  if (!match) {
    throw new Error(
      `validate:unlocked step "${step}" is not a bare \`pnpm <script>\`, so a release phase cannot run it`,
    );
  }
  return match[1];
}

function waitForChild(child) {
  return new Promise((resolveChild, rejectChild) => {
    child.once('error', rejectChild);
    child.once('close', (code, signal) => resolveChild({ code, signal }));
  });
}

async function runValidationChild(options) {
  if (!options.phase) return runPnpmScriptChild(options, 'validate:unlocked');
  const pkg = JSON.parse(await readFile(resolve(options.repoRoot, 'package.json'), 'utf8'));
  const steps = validationPhaseSteps(pkg.scripts?.['validate:unlocked'] ?? '', options.phase);
  // Resolve every step before running any, so a malformed one fails in seconds.
  const scripts = steps.map(validationStepScript);
  console.log(`[validate] ${options.phase} phase: ${steps.join(' && ')}`);
  for (const script of scripts) {
    const code = await runPnpmScriptChild(options, script);
    if (code !== 0) return code;
  }
  return 0;
}

async function runCoverageChild(options) {
  return runPnpmScriptChild(options, 'test:coverage:unleased');
}

async function runPnpmScriptChild(options, script) {
  const child = (options.spawnPnpmFn ?? spawnPnpm)(['run', script], {
    cwd: options.repoRoot,
    env: options.env,
    stdio: 'inherit',
  });
  const completion = waitForChild(child);
  await options.setChildPid?.(child.pid);
  const forwardSigint = () => {
    if (!child.killed) child.kill('SIGINT');
  };
  const forwardSigterm = () => {
    if (!child.killed) child.kill('SIGTERM');
  };
  process.once('SIGINT', forwardSigint);
  process.once('SIGTERM', forwardSigterm);
  try {
    const { code, signal } = await completion;
    if (signal) {
      console.error(`[validate] ${script} exited on ${signal}`);
      return 1;
    }
    return code ?? 1;
  } finally {
    process.off('SIGINT', forwardSigint);
    process.off('SIGTERM', forwardSigterm);
  }
}

/** Keep dependency mutations out of the checkout for the entire quality gate. */
export async function runWorkspaceValidation(options = {}) {
  const repoRoot = options.repoRoot ?? defaultRepoRoot;
  const install = options.install ?? false;
  const coverage = options.coverage ?? false;
  const inheritedEnv = { ...(options.env ?? process.env) };
  // Tests and coverage inherit this too; explicit logging overrides still win.
  inheritedEnv.GEZEL_LOG_LEVEL ||= 'warn';
  const runInstallFn = options.runInstallFn ?? runPreparedFrozenInstall;
  const runValidationFn = options.runValidationFn ?? runValidationChild;
  const runCoverageFn = options.runCoverageFn ?? runCoverageChild;

  const withLease = install ? withPnpmInstallLock : withDependencyReadLease;
  return withLease(
    repoRoot,
    ({ setChildPid: setDependencyChildPid, leaseEnv: dependencyEnv }) =>
      withBuildOutputLease(
        repoRoot,
        async ({ setChildPid: setBuildChildPid, leaseEnv: buildEnv }) => {
          const env = { ...inheritedEnv, ...dependencyEnv, ...buildEnv };
          const setChildPid = (pid) =>
            Promise.all([setDependencyChildPid(pid), setBuildChildPid(pid)]);
          if (install) {
            const installCode = await runInstallFn({
              repoRoot,
              args: [],
              allowPurge: false,
              env,
              setChildPid,
            });
            if (installCode !== 0) return installCode;
          }
          const childOptions = {
            repoRoot,
            env,
            setChildPid,
            ...(options.phase ? { phase: options.phase } : {}),
            ...(options.spawnPnpmFn ? { spawnPnpmFn: options.spawnPnpmFn } : {}),
          };
          const validationCode = await runValidationFn(childOptions);
          if (validationCode !== 0 || !coverage) return validationCode;
          return runCoverageFn(childOptions);
        },
        { command: 'pnpm validate', env: inheritedEnv },
      ),
    {
      command: coverage ? 'pnpm all' : install ? 'pnpm deps:validate' : 'pnpm validate',
      env: inheritedEnv,
    },
  );
}

export function parseWorkspaceValidationArgs(argv) {
  const parsed = { install: argv.includes('--install'), coverage: argv.includes('--coverage') };
  const phaseArg = argv.find((arg) => arg.startsWith('--phase='));
  if (phaseArg === undefined) return parsed;
  const phase = phaseArg.slice('--phase='.length);
  if (!VALIDATION_PHASE_NAMES.includes(phase)) {
    throw new Error(
      `unknown --phase "${phase}"; expected one of ${VALIDATION_PHASE_NAMES.join(', ')}`,
    );
  }
  return { ...parsed, phase };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  Promise.resolve()
    .then(() => runWorkspaceValidation(parseWorkspaceValidationArgs(process.argv.slice(2))))
    .then(
      (code) => {
        process.exitCode = code;
      },
      (error) => {
        console.error(`[validate] ${error?.message ?? error}`);
        process.exitCode = 1;
      },
    );
}
