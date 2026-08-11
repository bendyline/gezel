import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

function isPnpmJavaScriptCli(path) {
  return /pnpm\.(?:c|m)?js$/i.test(path);
}

function pnpmJavaScriptCli(env) {
  for (const candidate of [env.GEZEL_PNPM_CLI, env.npm_execpath]) {
    if (candidate && isPnpmJavaScriptCli(candidate) && existsSync(candidate)) return candidate;
  }

  if (process.platform !== 'win32') return null;
  for (const pathDir of (env.PATH ?? '').split(delimiter)) {
    const unquoted = pathDir.replace(/^"(.*)"$/, '$1');
    if (!unquoted || !existsSync(join(unquoted, 'pnpm.cmd'))) continue;
    for (const candidate of [
      join(unquoted, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
      join(unquoted, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
    ]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Resolve pnpm without sending an argv array through cmd.exe. Besides avoiding
 * Node's DEP0190 warning, this keeps JSON-valued config arguments intact on
 * Windows. Package scripts expose pnpm's JS entry through npm_execpath; direct
 * `node scripts/...` calls fall back to the adjacent package behind pnpm.cmd.
 */
export function resolvePnpmCli(args, options = {}) {
  const env = options.env ?? process.env;
  const javascriptCli = pnpmJavaScriptCli(env);
  if (javascriptCli) {
    return {
      command: process.execPath,
      args: [javascriptCli, ...args],
      shell: false,
    };
  }

  const configured = env.GEZEL_PNPM_CLI;
  if (configured) {
    return { command: configured, args: [...args], shell: false };
  }
  if (process.platform === 'win32') {
    throw new Error(
      "Could not resolve pnpm's JavaScript CLI on Windows. Run this command through a pnpm script or install pnpm on PATH.",
    );
  }
  return { command: 'pnpm', args: [...args], shell: false };
}

export function spawnPnpm(args, options = {}) {
  const invocation = resolvePnpmCli(args, options);
  return spawn(invocation.command, invocation.args, {
    ...options,
    env: options.env ?? process.env,
    shell: invocation.shell,
  });
}

export function execPnpm(args, options = {}) {
  const invocation = resolvePnpmCli(args, options);
  return exec(invocation.command, invocation.args, {
    ...options,
    env: options.env ?? process.env,
    shell: invocation.shell,
  });
}
