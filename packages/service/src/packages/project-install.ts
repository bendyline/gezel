import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { KeyedLock, createLogger, redactCredentials } from '@bendyline/gezel';
import { type PnpmResult, type RunPnpmOptions, runPnpm } from './pnpm.js';

const log = createLogger('packages');
const installs = new KeyedLock();
const REPAIRABLE_ERRORS = new Set([
  'ERR_PNPM_UNEXPECTED_STORE',
  'ERR_PNPM_UNEXPECTED_VIRTUAL_STORE',
  'ERR_PNPM_MODULES_BREAKING_CHANGE',
  'ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF',
  'ERR_PNPM_HOIST_PATTERN_DIFF',
  'ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF',
  'ERR_PNPM_NODE_LINKER_DIFF',
]);

interface ProjectInstallOptions extends Omit<RunPnpmOptions, 'lifecycle'> {
  registry?: string;
}

interface ProjectInstallResult extends PnpmResult {
  error?: string;
}

function output(result: PnpmResult): string {
  return redactCredentials(stripVTControlCharacters(`${result.stdout}\n${result.stderr}`)).trim();
}

function errorCode(result: PnpmResult): string | undefined {
  return output(result).match(/^\s*\[?(ERR_PNPM_[A-Z_0-9]+)\b/m)?.[1];
}

function failure(result: PnpmResult, action: string): string {
  const lines = output(result).split(/\r?\n/);
  const firstError = lines.findIndex((line) => /^\s*\[?ERR_PNPM_/.test(line));
  const details = (firstError < 0 ? lines.slice(-12) : lines.slice(firstError)).join('\n');
  return `${action} failed (exit code ${result.code ?? 'unknown'})${details ? `: ${details.slice(0, 3000)}` : ''}`;
}

/**
 * Only call after the install and destination have been authorized. A bundled
 * pnpm upgrade can leave a project's old dependency layout unreadable by `add`.
 * pnpm's own `install` migrates it; disabling its terminal confirmation is
 * scoped to that recovery, with all ordinary install guards still enforced.
 */
export async function addProjectPackage(
  spec: string,
  options: ProjectInstallOptions,
): Promise<ProjectInstallResult> {
  const { registry, ...runOptions } = options;
  const canonicalDir = await realpath(options.cwd).catch(() => resolve(options.cwd));
  const key = process.platform === 'win32' ? canonicalDir.toLowerCase() : canonicalDir;
  return installs.run(key, async () => {
    const opts = { ...runOptions, lifecycle: 'ignore' as const };
    const config = registry ? [`--config.registry=${registry}`] : [];
    const addArgs = ['add', ...config, '--', spec];
    if (opts.signal?.aborted) {
      return {
        ok: false,
        code: null,
        stdout: '',
        stderr: '',
        log: '',
        error: 'Package install canceled',
      };
    }

    let result = await runPnpm(addArgs, opts);
    const logs = [result.log];
    const code = errorCode(result);
    let action = 'Package install';
    if (!result.ok && code && REPAIRABLE_ERRORS.has(code) && !opts.signal?.aborted) {
      const notice =
        'Updating this project’s installed dependencies for the current package manager.\n';
      log.info(`Repairing dependency layout in ${canonicalDir} (${code})`);
      opts.onLine?.(notice);
      logs.push(notice);
      // Do not use --force: it also relaxes engine checks and refetches packages.
      // Normal install keeps compatible locked versions and repairs the layout.
      // A project install must not expand into every sibling in a pnpm workspace.
      result = await runPnpm(
        [
          'install',
          ...config,
          '--no-frozen-lockfile',
          '--config.confirmModulesPurge=false',
          '--config.recursive-install=false',
        ],
        opts,
      );
      logs.push(result.log);
      action = 'Dependency repair';
      if (result.ok && !opts.signal?.aborted) {
        result = await runPnpm(addArgs, opts);
        logs.push(result.log);
        action = 'Package install after dependency repair';
      } else if (result.ok) {
        result = { ...result, ok: false, code: null, stderr: 'Package install canceled' };
      }
    }

    const error = result.ok ? undefined : failure(result, action);
    if (error) log.warn(`${canonicalDir}: ${error}`);
    return { ...result, log: logs.join('\n'), ...(error ? { error } : {}) };
  });
}
