/**
 * Load a published Prismatic component (`@prismatic-io/components-*`) from
 * the folder the service installed it in.
 *
 * A component has no dependencies of its own: it imports the Spectral SDK as
 * a peer and Node built-ins. A resolve hook maps every SDK import from inside
 * the component onto this runner's pinned copy, so the HTTP stack that carries
 * the credential is the one under the workspace lockfile, and refuses any
 * other package and the built-ins that open sockets or processes. The entry's
 * hash is checked against the pin before a byte of it runs.
 *
 * This is defense in depth inside a process that already runs under the
 * sandbox's permission model; a component determined to misbehave can reach
 * around a JavaScript hook. It catches the honest mistakes, and makes the
 * dishonest ones visible in review.
 */

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isBuiltin, registerHooks } from 'node:module';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RunnerError } from './failure.js';
import type { ComponentRef } from './protocol.js';

const SDK = '@prismatic-io/spectral';

/** Built-ins a connector component may not import: sockets, processes, code loading. */
export const DENIED_BUILTINS = new Set([
  'child_process',
  'cluster',
  'dgram',
  'diagnostics_channel',
  'dns',
  'http',
  'http2',
  'https',
  'inspector',
  'module',
  'net',
  'repl',
  'sqlite',
  'tls',
  'trace_events',
  'v8',
  'vm',
  'wasi',
  'worker_threads',
]);

function builtinName(specifier: string): string {
  const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  return bare.split('/')[0] ?? bare;
}

export function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The real path, asked of the OS in one call. The JavaScript `realpathSync`
 * walks every parent folder, and the sandbox grants none of those (on macOS
 * the temp folder alone sits behind the `/var` link), so it is refused.
 */
function realPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function pathOf(url: string | undefined): string | undefined {
  if (!url?.startsWith('file:')) return undefined;
  return realPath(fileURLToPath(url));
}

let installed: { deregister(): void } | undefined;
let guardedBuiltins = false;

/**
 * `process.getBuiltinModule` reaches a built-in without going through module
 * resolution, so the hook alone would not see it.
 */
function guardGetBuiltinModule(): void {
  if (guardedBuiltins) return;
  guardedBuiltins = true;
  const proc = process as unknown as { getBuiltinModule?: (id: string) => unknown };
  const original = proc.getBuiltinModule?.bind(process);
  if (!original) return;
  proc.getBuiltinModule = (id: string) => {
    if (DENIED_BUILTINS.has(builtinName(id))) {
      throw new RunnerError(
        'component',
        `the component asked for node:${builtinName(id)}, which a connector may not use`,
      );
    }
    return original(id);
  };
}

/** Load the component's callable entry under the resolve hook. */
export function loadComponent(ref: ComponentRef, runnerRequire: NodeJS.Require): unknown {
  const root = realPath(ref.dir);
  const entry = realPath(join(root, ref.entry));
  if (!inside(root, entry) || entry === root) {
    throw new RunnerError('component', 'the component entry is outside its package');
  }
  const sha = createHash('sha256').update(readFileSync(entry)).digest('hex');
  if (sha !== ref.entrySha256) {
    throw new RunnerError('component', 'the component entry does not match its pinned hash');
  }

  installed?.deregister();
  installed = registerHooks({
    resolve(specifier, context, nextResolve) {
      const parent = pathOf(context.parentURL);
      if (!parent || !inside(root, parent)) return nextResolve(specifier, context);
      if (isBuiltin(specifier)) {
        if (DENIED_BUILTINS.has(builtinName(specifier))) {
          throw new RunnerError(
            'component',
            `the component asked for node:${builtinName(specifier)}, which a connector may not use`,
          );
        }
        return nextResolve(specifier, context);
      }
      if (specifier === SDK || specifier.startsWith(`${SDK}/`)) {
        return { url: pathToFileURL(runnerRequire.resolve(specifier)).href, shortCircuit: true };
      }
      if (specifier.startsWith('.') || isAbsolute(specifier) || specifier.startsWith('file:')) {
        const out = nextResolve(specifier, context);
        const target = pathOf(out.url);
        if (!target || !inside(root, target)) {
          throw new RunnerError(
            'component',
            `the component reached outside its package: ${specifier}`,
          );
        }
        return out;
      }
      throw new RunnerError(
        'component',
        `the component asked for ${specifier}, which is not part of its package`,
      );
    },
  });
  guardGetBuiltinModule();
  // Loaded from the runner, so the entry itself resolves normally; its own
  // imports then come from inside the package and meet the hook.
  return runnerRequire(entry);
}

/** For tests: drop the hook so the next load starts clean. */
export function unloadComponentHooks(): void {
  installed?.deregister();
  installed = undefined;
}
