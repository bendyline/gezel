import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { writeFileAtomic } from '../../fs/atomic.js';

/**
 * One MCP server entry the Claude CLI should spawn for the session. Mirrors
 * Claude's `.mcp.json` shape — a stdio command + args + env. The provider
 * always inserts the `gezel` entry pointing at gezel-mcp; per-gezel/shared/
 * system toolsets are appended verbatim from `SessionOpts.extraMcpServers`.
 */
export interface ClaudeMcpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Build the `.mcp.json` Claude CLI consumes via `--mcp-config <path>`.
 * Caller writes the result to disk via {@link writeRuntimeMcpConfig}.
 */
export function buildRuntimeMcpConfig(servers: Record<string, ClaudeMcpServerEntry>): {
  mcpServers: Record<string, ClaudeMcpServerEntry>;
} {
  return { mcpServers: servers };
}

/**
 * Write the runtime `.mcp.json` that the Claude CLI will load on the next
 * turn. Keeps the file under `~/.gezel/runtime/anthropic-cli/<projectId>/
 * <sessionId>.mcp.json` so it never lands inside the user's repo. Idempotent:
 * if the existing file already contains the same JSON we skip the write
 * entirely (same-bytes diff to keep mtime stable across no-op turns).
 *
 * Returns the absolute path to the file. Caller passes that path to
 * `claude --mcp-config <path>`.
 */
export async function writeRuntimeMcpConfig(opts: {
  path: string;
  servers: Record<string, ClaudeMcpServerEntry>;
}): Promise<string> {
  const config = buildRuntimeMcpConfig(opts.servers);
  const body = `${JSON.stringify(config, null, 2)}\n`;
  await mkdir(dirname(opts.path), { recursive: true });
  await writeFileAtomic(opts.path, body);
  return opts.path;
}

/**
 * Write an arbitrary UTF-8 text runtime file under the per-session runtime
 * dir. Used to stage the gezel system prompt for
 * `claude --append-system-prompt-file <path>` so the (often large) prompt
 * never rides on the command line — see the note in `worker.ts`'s
 * `writeSystemPromptOnce`. Creates parent dirs and writes atomically,
 * mirroring {@link writeRuntimeMcpConfig}. Returns the absolute path.
 */
export async function writeRuntimeTextFile(opts: {
  path: string;
  contents: string;
}): Promise<string> {
  await mkdir(dirname(opts.path), { recursive: true });
  await writeFileAtomic(opts.path, opts.contents);
  return opts.path;
}
