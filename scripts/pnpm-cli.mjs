import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

function isPnpmJavaScriptCli(path) {
  return /pnpm\.(?:c|m)?js$/i.test(path);
}

/**
 * Windows environment names are case-insensitive, but only through
 * `process.env`'s proxy. Spreading it into a plain object — which every
 * caller that injects a variable does — yields the real key, and on Windows
 * that is `Path`, not `PATH`. Reading `env.PATH` off such an object returns
 * undefined, which silently emptied the scan below and reported a perfectly
 * good pnpm install as missing.
 */
export function readPathVar(env) {
  if (typeof env.PATH === 'string') return env.PATH;
  for (const [key, value] of Object.entries(env)) {
    if (key.toLowerCase() === 'path' && typeof value === 'string') return value;
  }
  return '';
}

function pnpmJavaScriptCli(env) {
  for (const candidate of [env.GEZEL_PNPM_CLI, env.npm_execpath]) {
    if (candidate && isPnpmJavaScriptCli(candidate) && existsSync(candidate)) return candidate;
  }

  if (process.platform !== 'win32') return null;
  for (const pathDir of readPathVar(env).split(delimiter)) {
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

/** Synchronous counterpart for semantic-release hooks and release rehearsals. */
export function spawnPnpmSync(args, options = {}) {
  const invocation = resolvePnpmCli(args, options);
  return spawnSync(invocation.command, invocation.args, {
    ...options,
    env: options.env ?? process.env,
    shell: invocation.shell,
  });
}

/**
 * The npm counterpart of {@link resolvePnpmCli}. Unlike pnpm, npm is only
 * ever asked for registry metadata here, so an unresolvable JS CLI falls
 * back to the PATH shim rather than throwing — the fallback needs a shell on
 * Windows (`npm` is `npm.cmd`), which is where DEP0190 comes from.
 */
export function resolveNpmCli(args, options = {}) {
  const env = options.env ?? process.env;
  const execpath = env.npm_execpath;
  if (execpath && /npm-cli\.js$/i.test(execpath) && existsSync(execpath)) {
    return { command: process.execPath, args: [execpath, ...args], shell: false };
  }
  if (process.platform === 'win32') {
    for (const pathDir of readPathVar(env).split(delimiter)) {
      const unquoted = pathDir.replace(/^"(.*)"$/, '$1');
      if (!unquoted) continue;
      const candidate = join(unquoted, 'node_modules', 'npm', 'bin', 'npm-cli.js');
      if (existsSync(candidate)) {
        return { command: process.execPath, args: [candidate, ...args], shell: false };
      }
    }
    return { command: 'npm', args: [...args], shell: true };
  }
  return { command: 'npm', args: [...args], shell: false };
}

export function execPnpm(args, options = {}) {
  const invocation = resolvePnpmCli(args, options);
  return exec(invocation.command, invocation.args, {
    ...options,
    env: options.env ?? process.env,
    shell: invocation.shell,
  });
}
