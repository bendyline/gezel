import { mkdir, readFile, stat, symlink, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@bendyline/gezel';
import { writeFileAtomic } from '../../fs/atomic.js';
import type { CodexReasoningEffort } from './reasoning.js';

const log = createLogger('codex-cli');

export type CodexMcpApprovalMode = 'auto' | 'prompt' | 'approve';

export type CodexMcpEnvVarForward =
  | string
  | {
      name: string;
      source?: 'local' | 'remote';
    };

export interface CodexMcpServerCommon {
  enabled?: boolean;
  required?: boolean;
  startupTimeoutSec?: number;
  toolTimeoutSec?: number;
  enabledTools?: string[];
  disabledTools?: string[];
  defaultToolsApprovalMode?: CodexMcpApprovalMode;
  toolApprovalModes?: Record<string, CodexMcpApprovalMode>;
}

/**
 * One stdio MCP server entry the Codex CLI should spawn for the
 * session. This mirrors gezel's standard local MCP shape.
 */
export interface CodexStdioMcpServerEntry extends CodexMcpServerCommon {
  kind?: 'stdio';
  command: string;
  args: string[];
  env: Record<string, string>;
  envVars?: CodexMcpEnvVarForward[];
  cwd?: string;
  experimentalEnvironment?: 'remote';
}

/** One Streamable HTTP MCP server entry for Codex config.toml. */
export interface CodexHttpMcpServerEntry extends CodexMcpServerCommon {
  kind: 'http';
  url: string;
  bearerTokenEnvVar?: string;
  httpHeaders?: Record<string, string>;
  envHttpHeaders?: Record<string, string>;
}

export type CodexMcpServerEntry = CodexStdioMcpServerEntry | CodexHttpMcpServerEntry;

export interface CodexRuntimeConfig {
  /** System prompt — written as `instructions = "..."` at the top of `config.toml`. */
  instructions: string;
  /** Model id passed via `-m`; also written as `model = "..."` for tools that read config first. */
  model: string;
  /** Optional model-dependent `model_reasoning_effort` knob. */
  reasoningEffort?: CodexReasoningEffort;
  /**
   * Codex's `model_auto_compact_token_limit` — the input-token
   * threshold at which codex's built-in rollout compactor kicks in.
   * Codex's per-model defaults leave this `null` (compaction disabled)
   * for the gpt-5 family, even though those models support 1 M-token
   * windows. Without it, a multi-turn rollout that walks a repo
   * monotonically grows the context (each `codex exec resume` replays
   * the whole JSONL): the codex-cli matrix's squisq-review
   * trial sent 7.17 M input tokens across 7 turns (~1 M / turn). Set
   * conservatively (~12% of a 1 M window) so compaction fires well
   * before the model starts dropping content. Skipped from the
   * config.toml when unset.
   */
  autoCompactTokenLimit?: number;
  /**
   * Codex's `tool_output_token_limit` — caps any single tool result's
   * contribution to the rollout. Critical for repo-walking scenarios
   * where one `read_file` on a large file would otherwise inject tens
   * of K of tokens that never come back out of context. Skipped from
   * the config.toml when unset.
   */
  toolOutputTokenLimit?: number;
  /** Per-session MCP servers (gezel-mcp + extras). Keyed by stable id. */
  mcpServers: Record<string, CodexMcpServerEntry>;
  /** Optional fixed callback port for Codex MCP OAuth login flows. */
  mcpOauthCallbackPort?: number;
  /** Optional fixed callback URL for Codex MCP OAuth login flows. */
  mcpOauthCallbackUrl?: string;
}

/**
 * Build the body of the per-session `config.toml`. Codex CLI has no
 * `--system` / `--mcp-config <path>` flag — `~/.codex/config.toml` (or
 * `$CODEX_HOME/config.toml`) is the contract for both. We write a
 * minimal one per session and point Codex at it via the `CODEX_HOME`
 * env var.
 *
 * `project_doc_max_bytes = 0` disables AGENTS.md auto-discovery so the
 * gezel's persona (in `instructions`) is the only system-prompt source.
 *
 * Exposed as a pure function so tests can verify the wire shape without
 * touching disk.
 */
export function buildCodexConfigToml(config: CodexRuntimeConfig): string {
  const lines: string[] = [];
  lines.push(`instructions = ${tomlString(config.instructions)}`);
  lines.push(`model = ${tomlString(config.model)}`);
  if (config.reasoningEffort) {
    lines.push(`model_reasoning_effort = ${tomlString(config.reasoningEffort)}`);
  }
  if (typeof config.autoCompactTokenLimit === 'number') {
    lines.push(`model_auto_compact_token_limit = ${config.autoCompactTokenLimit}`);
  }
  if (typeof config.toolOutputTokenLimit === 'number') {
    lines.push(`tool_output_token_limit = ${config.toolOutputTokenLimit}`);
  }
  // We bake everything we need into `instructions`; AGENTS.md walking
  // would just bloat the prompt with unrelated repo files when a gezel
  // runs against an arbitrary cwd.
  lines.push('project_doc_max_bytes = 0');
  if (typeof config.mcpOauthCallbackPort === 'number') {
    lines.push(`mcp_oauth_callback_port = ${config.mcpOauthCallbackPort}`);
  }
  if (config.mcpOauthCallbackUrl) {
    lines.push(`mcp_oauth_callback_url = ${tomlString(config.mcpOauthCallbackUrl)}`);
  }

  for (const [id, server] of Object.entries(config.mcpServers)) {
    lines.push('');
    lines.push(`[mcp_servers.${tomlBareKey(id)}]`);
    if (server.kind === 'http') {
      lines.push(`url = ${tomlString(server.url)}`);
      if (server.bearerTokenEnvVar) {
        lines.push(`bearer_token_env_var = ${tomlString(server.bearerTokenEnvVar)}`);
      }
      if (server.httpHeaders && Object.keys(server.httpHeaders).length > 0) {
        lines.push(`http_headers = ${tomlInlineTable(server.httpHeaders)}`);
      }
      if (server.envHttpHeaders && Object.keys(server.envHttpHeaders).length > 0) {
        lines.push(`env_http_headers = ${tomlInlineTable(server.envHttpHeaders)}`);
      }
    } else {
      lines.push(`command = ${tomlString(server.command)}`);
      lines.push(`args = ${tomlStringArray(server.args)}`);
      if (Object.keys(server.env).length > 0) {
        lines.push(`env = ${tomlInlineTable(server.env)}`);
      }
      if (server.envVars && server.envVars.length > 0) {
        lines.push(`env_vars = ${tomlEnvVarsArray(server.envVars)}`);
      }
      if (server.cwd) {
        lines.push(`cwd = ${tomlString(server.cwd)}`);
      }
      if (server.experimentalEnvironment) {
        lines.push(`experimental_environment = ${tomlString(server.experimentalEnvironment)}`);
      }
    }
    emitMcpServerCommon(lines, server);
    if (server.toolApprovalModes) {
      for (const [tool, approvalMode] of Object.entries(server.toolApprovalModes)) {
        lines.push('');
        lines.push(`[mcp_servers.${tomlBareKey(id)}.tools.${tomlBareKey(tool)}]`);
        lines.push(`approval_mode = ${tomlString(approvalMode)}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

function emitMcpServerCommon(lines: string[], server: CodexMcpServerCommon): void {
  if (typeof server.startupTimeoutSec === 'number') {
    lines.push(`startup_timeout_sec = ${server.startupTimeoutSec}`);
  }
  if (typeof server.toolTimeoutSec === 'number') {
    lines.push(`tool_timeout_sec = ${server.toolTimeoutSec}`);
  }
  if (typeof server.enabled === 'boolean') {
    lines.push(`enabled = ${server.enabled ? 'true' : 'false'}`);
  }
  if (typeof server.required === 'boolean') {
    lines.push(`required = ${server.required ? 'true' : 'false'}`);
  }
  if (server.enabledTools) {
    lines.push(`enabled_tools = ${tomlStringArray(server.enabledTools)}`);
  }
  if (server.disabledTools) {
    lines.push(`disabled_tools = ${tomlStringArray(server.disabledTools)}`);
  }
  if (server.defaultToolsApprovalMode) {
    lines.push(`default_tools_approval_mode = ${tomlString(server.defaultToolsApprovalMode)}`);
  }
}

/**
 * Write the per-session `CODEX_HOME` directory the Codex CLI consumes.
 * Layout:
 *
 *   <home>/
 *     config.toml          per-session: instructions, model, mcp_servers, ...
 *     auth.json            symlink to ~/.codex/auth.json (only if it exists)
 *
 * Returns the absolute path to the directory; caller passes it via the
 * `CODEX_HOME` env var on subprocess spawn. Idempotent: if the existing
 * `config.toml` already contains the same body we skip the write
 * (same-bytes diff to keep mtime stable across no-op turns).
 */
export async function writeRuntimeCodexHome(opts: {
  /** Absolute path to the per-session CODEX_HOME directory. */
  path: string;
  /** Config to render into `config.toml`. */
  config: CodexRuntimeConfig;
  /** Override for `~/.codex/auth.json` source — defaults to user's homedir. */
  userAuthJsonPath?: string;
}): Promise<string> {
  const body = buildCodexConfigToml(opts.config);
  await mkdir(opts.path, { recursive: true });
  const configPath = join(opts.path, 'config.toml');
  if (!(await sameBody(configPath, body))) {
    await writeFileAtomic(configPath, body);
  }
  const userAuthPath = opts.userAuthJsonPath ?? join(homedir(), '.codex', 'auth.json');
  await ensureAuthSymlink(opts.path, userAuthPath);
  return opts.path;
}

async function sameBody(path: string, body: string): Promise<boolean> {
  try {
    const existing = await readFile(path, 'utf8');
    return existing === body;
  } catch {
    return false;
  }
}

/**
 * Symlink `<codexHome>/auth.json` to the user's `~/.codex/auth.json`
 * when the source exists. If the source is missing — i.e. the user
 * never ran `codex login` and is relying on `OPENAI_API_KEY` /
 * `CODEX_API_KEY` env — we leave the per-session home without an
 * `auth.json` and Codex picks up the env-based credentials. If a
 * stale symlink already exists, refresh it.
 */
async function ensureAuthSymlink(codexHome: string, source: string): Promise<void> {
  const target = join(codexHome, 'auth.json');
  try {
    await stat(source);
  } catch {
    // No source auth.json — env-based auth is the path. Clean up any
    // stale symlink so Codex doesn't follow a broken one.
    try {
      await unlink(target);
    } catch {
      /* nothing to clean */
    }
    return;
  }
  // Replace existing target so a re-login picks up immediately.
  try {
    await unlink(target);
  } catch {
    /* didn't exist */
  }
  try {
    await symlink(source, target);
  } catch (err) {
    // On Windows, symlinks may require elevation. Fall back to a copy
    // of the bytes — auth.json is a small JSON file. We don't watch
    // for upstream changes; user re-login + next session re-copies.
    try {
      const bytes = await readFile(source);
      await writeFileAtomic(target, bytes);
    } catch {
      // Both failed — leave the home without an auth.json. Codex will
      // surface a login error on first turn, which is the right place
      // for the user to see it.
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`[codex-cli] failed to link auth.json: ${message}`);
    }
  }
}

function tomlString(value: string): string {
  // TOML basic strings — escape backslash, double-quote, and control
  // characters. JSON.stringify gives us all of that for free, including
  // the surrounding quotes.
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(', ')}]`;
}

function tomlInlineTable(map: Record<string, string>): string {
  const entries = Object.entries(map).map(([k, v]) => `${tomlBareKey(k)} = ${tomlString(v)}`);
  return `{ ${entries.join(', ')} }`;
}

function tomlEnvVarsArray(values: readonly CodexMcpEnvVarForward[]): string {
  return `[${values.map(tomlEnvVar).join(', ')}]`;
}

function tomlEnvVar(value: CodexMcpEnvVarForward): string {
  if (typeof value === 'string') return tomlString(value);
  const entries = [`name = ${tomlString(value.name)}`];
  if (value.source) entries.push(`source = ${tomlString(value.source)}`);
  return `{ ${entries.join(', ')} }`;
}

/**
 * TOML bare keys allow `A-Za-z0-9_-`. Anything else needs quoting. We
 * always quote when in doubt — bare-key emission for gezel-mcp's
 * `id`-keyed server table is fine since toolset ids are safe slugs,
 * but a defensive quoted form is cheaper than a crash.
 */
function tomlBareKey(key: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(key)) return key;
  return tomlString(key);
}
