import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ToolCallEvent } from './types.js';

/** Translate CLI evidence once, before runtime gates, history and evals see it.
 * Only Gezel's namespace is authoritative; a foreign tool named write_file
 * must never become evidence of a write to this project's workspace. */
export function normalizeCliToolEvent(
  event: ToolCallEvent,
  provider: string,
  cwd: string | undefined,
): ToolCallEvent {
  if (provider !== 'anthropic-cli' && provider !== 'codex-cli') return event;
  const rawName = event.name;
  let name = rawName.replace(/^mcp__gezel__/, '');
  let args = event.args;
  if (provider === 'codex-cli' && typeof args?.server === 'string' && args.server !== 'gezel') {
    return { ...event, name: `mcp__${args.server}__${rawName}`, providerToolName: rawName };
  }
  const native =
    provider === 'anthropic-cli'
      ? (
          {
            Read: 'read_file',
            Write: 'write_file',
            Edit: 'replace_in_file',
            Bash: 'shell',
          } as Record<string, string>
        )[rawName]
      : undefined;
  if (native === 'shell') name = native;
  else if (native) {
    const path = workspaceRelativePath(args?.file_path, cwd);
    // Out-of-project native access stays visible, but cannot satisfy a local gate.
    if (path === undefined) return event;
    name = native;
    args = { ...args, path };
  }
  if (provider === 'codex-cli' && event.providerToolName === 'file_change') {
    const path = workspaceRelativePath(args?.path, cwd);
    if (path === undefined) return { ...event, name: 'file_change' };
    args = { ...args, path };
  }
  return {
    ...event,
    name,
    args,
    ...(name !== rawName ? { providerToolName: event.providerToolName ?? rawName } : {}),
  };
}

function workspaceRelativePath(value: unknown, cwd: string | undefined): string | undefined {
  if (typeof value !== 'string' || !cwd || !value.trim()) return undefined;
  const canonical = (path: string): string => {
    try {
      return realpathSync.native(path);
    } catch (error) {
      // Resolve missing files through their nearest existing parent as well.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(path);
      if (parent === path) throw error;
      return join(canonical(parent), basename(path));
    }
  };
  let path: string;
  try {
    path = relative(canonical(resolve(cwd)), canonical(resolve(cwd, value)));
  } catch {
    return undefined;
  }
  if (
    !path ||
    isAbsolute(path) ||
    path === '..' ||
    path.startsWith('../') ||
    path.startsWith('..\\')
  )
    return undefined;
  return path.replace(/\\/g, '/');
}
