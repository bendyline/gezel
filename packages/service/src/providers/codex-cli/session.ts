import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ALWAYS_REGISTERED_TOOLS, CONDITIONALLY_REGISTERED_TOOLS } from '@bendyline/gezel-mcp';
import { scriptToolNamesFromEnv } from '../../project-type/script-tools.js';
import { type ProviderQueue, runInQueue } from '../queue.js';
import { StreamingSessionBase } from '../streaming-session.js';
import type {
  LLMSession,
  ProviderSessionState,
  SendAndWaitOpts,
  SessionOpts,
  ToolCallEvent,
  TurnUsage,
} from '../types.js';
import { CODEX_CLI_EXCLUDED_MCP_TOOLS } from './excluded-mcp-tools.js';
import { type CodexInvokerHooks, type CodexPermissionMode, runCodexTurn } from './invoker.js';
import type { CodexReasoningEffort } from './reasoning.js';
import {
  type CodexMcpServerEntry,
  type CodexRuntimeConfig,
  writeRuntimeCodexHome,
} from './runtime-files.js';

export interface CodexSessionDeps {
  binaryPath: string;
  model: string;
  permissionMode: CodexPermissionMode;
  reasoningEffort?: CodexReasoningEffort;
  systemMessage: string;
  context: NonNullable<SessionOpts['codexCliContext']>;
  runtimeDir: string;
  manageRuntimeFiles: boolean;
  queue: ProviderQueue;
  extraConfigOverrides?: Record<string, string>;
  mcpServer?: SessionOpts['mcpServer'];
  extraMcpServers?: SessionOpts['extraMcpServers'];
  toolAllowlist?: SessionOpts['toolAllowlist'];
  onToolCall?: SessionOpts['onToolCall'];
  knownSecretValues?: Set<string>;
  initialResumeId?: string;
}

const TURN_TIMEOUT_DEFAULT_MS = 600_000;
const CODEX_HTTP_HEADER_ENV_PREFIX = 'GEZEL_CODEX_MCP_HEADER_';

/**
 * One Codex CLI session = one logical chat thread. Unlike the Anthropic
 * CLI provider, there's no warm worker pool: each `sendAndWait` spawns
 * a fresh `codex exec` (or `codex exec resume <thread_id>`) subprocess
 * and waits for it to exit. Codex doesn't expose stream-json input, so
 * a long-lived subprocess can't accept multiple turns anyway.
 *
 * The captured `thread_id` is cached locally so `providerState()` can
 * return it cheaply (and so a transient invocation failure doesn't lose
 * the id — the next turn re-runs `codex exec resume <captured-id>`).
 */
export class CodexCliSession extends StreamingSessionBase implements LLMSession {
  private codexThreadIdCache: string | null;
  private aborted = false;

  constructor(private readonly deps: CodexSessionDeps) {
    super();
    this.codexThreadIdCache = deps.initialResumeId ?? null;
  }

  async sendAndWait(prompt: string, opts?: SendAndWaitOpts): Promise<string> {
    return runInQueue(this.deps.queue, opts?.queue, () => this.sendAndWaitInner(prompt, opts));
  }

  providerState(): ProviderSessionState {
    return this.codexThreadIdCache ? { codexCliThreadId: this.codexThreadIdCache } : {};
  }

  async disconnect(): Promise<void> {
    this.aborted = true;
    this.clearHandlers();
  }

  /**
   * Predicted tool surface the model will see this session — used by
   * the debug-bundle renderer (`chat-bubbles.tsx` "Registered tools"
   * line) so codex-cli sessions don't falsely report "none, MCP bridge
   * not yet started." Codex CLI manages its own MCP loop in-process,
   * so gezel-daemon-side introspection of the live tool list is
   * impossible. What we can honestly report: what we asked codex to
   * wire — the ordinary gezel-mcp inventory plus conditionally registered
   * tools whose MCP env gates are active, all minus
   * {@link CODEX_CLI_EXCLUDED_MCP_TOOLS} (silenced via `GEZEL_MCP_EXCLUDE`),
   * plus an opaque `mcp__<id>__*` marker per extra MCP server in
   * `extraMcpServers` whose tool list we can't enumerate without spawning it.
   *
   * Names use codex's MCP namespacing convention (`mcp__<server>__<tool>`),
   * which is also what gpt-5/5.5 emit when they draft a tool call —
   * matches the user-visible string in the chat surface and tool-call
   * events.
   *
   * When `mcpServer` is unset (one-shot completions, no MCP wiring),
   * this returns `[]` — the same signal other providers give and the
   * debug renderer surfaces as "Registered tools: none."
   */
  getRegisteredToolNames(): string[] {
    if (!this.deps.mcpServer) return [];
    const excluded = new Set<string>(CODEX_CLI_EXCLUDED_MCP_TOOLS);
    const allow = this.deps.toolAllowlist;
    const out: string[] = [];
    for (const name of ALWAYS_REGISTERED_TOOLS) {
      if (excluded.has(name)) continue;
      if (allow && !allow.has(name)) continue;
      out.push(`mcp__gezel__${name}`);
    }
    for (const [name, gate] of Object.entries(CONDITIONALLY_REGISTERED_TOOLS)) {
      const value = this.deps.mcpServer.env[gate.envVar];
      if (!value || (gate.envValue !== '*' && value !== gate.envValue)) continue;
      if (excluded.has(name)) continue;
      if (allow && !allow.has(name)) continue;
      out.push(`mcp__gezel__${name}`);
    }
    // Project-type script tools registered dynamically from the env payload.
    // `toolAllowlist` deliberately doesn't apply: session-build unions these
    // names into GEZEL_MCP_ALLOW, so the server registers them regardless of
    // the role allowlist; only the exclude list can strip them.
    for (const name of scriptToolNamesFromEnv(this.deps.mcpServer.env.GEZEL_SCRIPT_TOOLS)) {
      if (excluded.has(name)) continue;
      out.push(`mcp__gezel__${name}`);
    }
    for (const extra of this.deps.extraMcpServers ?? []) {
      // Extras get their full surface exposed to codex via config.toml.
      // We can't enumerate their tools without starting the server, so
      // surface a wildcard marker per server id so the debug bundle at
      // least signals the server was configured.
      out.push(`mcp__${extra.id}__*`);
    }
    return out;
  }

  private async sendAndWaitInner(prompt: string, opts?: SendAndWaitOpts): Promise<string> {
    if (this.aborted) throw new Error('[codex-cli] session was disconnected');

    const turnTimeoutMs = opts?.timeoutMs ?? TURN_TIMEOUT_DEFAULT_MS;

    const runtime = await this.ensureCodexHome();
    const hooks = this.buildTurnHooks();
    const imagePaths = await writeCodexImageAttachments(runtime.codexHome, opts?.attachments);

    try {
      const invokerOpts: Parameters<typeof runCodexTurn>[0] = {
        binaryPath: this.deps.binaryPath,
        cwd: this.deps.context.cwd,
        codexHome: runtime.codexHome,
        baseEnv: { ...process.env, ...runtime.env },
        model: this.deps.model,
        permissionMode: this.deps.permissionMode,
        prompt,
        hooks,
        timeoutMs: turnTimeoutMs,
      };
      if (imagePaths.length > 0) {
        invokerOpts.imagePaths = imagePaths;
      }
      if (this.deps.reasoningEffort) {
        invokerOpts.reasoningEffort = this.deps.reasoningEffort;
      }
      if (this.deps.extraConfigOverrides) {
        invokerOpts.extraConfigOverrides = this.deps.extraConfigOverrides;
      }
      if (this.codexThreadIdCache) {
        invokerOpts.resumeThreadId = this.codexThreadIdCache;
      }
      if (opts?.queue?.signal) {
        invokerOpts.signal = opts.queue.signal;
      }
      return await runCodexTurn(invokerOpts);
    } catch (err) {
      // Resume failure: clear the cached id so the next sendAndWait
      // starts a fresh thread without `--resume`. ChatManager's
      // higher-level recovery is the source of truth; this is a
      // belt-and-braces local clear so the session remains usable
      // if the manager's resume-handler isn't invoked.
      if (err instanceof Error && err.name === 'SessionResumeError') {
        this.codexThreadIdCache = null;
      }
      throw err;
    }
  }

  /**
   * Build the per-session `CODEX_HOME` directory — `config.toml` with
   * persona + model + reasoning effort + MCP servers, plus a symlink
   * to the user's `~/.codex/auth.json` if it exists. Skipped when the
   * provider was constructed with `manageRuntimeFiles: false`, in
   * which case `codex exec` runs against the user's default
   * `~/.codex/` and gezel-mcp tools won't be visible to the model.
   */
  private async ensureCodexHome(): Promise<{ codexHome: string; env: Record<string, string> }> {
    const path = join(
      this.deps.runtimeDir,
      this.deps.context.projectId,
      this.deps.context.sessionId,
    );
    if (!this.deps.manageRuntimeFiles) {
      // Caller opted out — return a no-op pointer at the user's
      // default. Codex CLI honors `CODEX_HOME` whether or not it's
      // a directory we wrote.
      return { codexHome: process.env.CODEX_HOME ?? '', env: {} };
    }
    const mcpServers: Record<string, CodexMcpServerEntry> = {};
    const codexEnv: Record<string, string> = {};
    if (this.deps.mcpServer) {
      mcpServers.gezel = {
        command: this.deps.mcpServer.command,
        args: this.deps.mcpServer.args,
        env: this.deps.mcpServer.env,
        disabledTools: [...CODEX_CLI_EXCLUDED_MCP_TOOLS],
        ...(this.deps.toolAllowlist
          ? {
              enabledTools: [...this.deps.toolAllowlist].filter(
                (name) => !CODEX_CLI_EXCLUDED_MCP_TOOLS.includes(name),
              ),
            }
          : {}),
      };
    }
    for (const extra of this.deps.extraMcpServers ?? []) {
      if (extra.kind === 'http') {
        const envHttpHeaders: Record<string, string> = {};
        let index = 0;
        for (const [header, value] of Object.entries(extra.headers)) {
          const envName = `${CODEX_HTTP_HEADER_ENV_PREFIX}${sanitizeEnvSegment(extra.id)}_${index}`;
          codexEnv[envName] = value;
          envHttpHeaders[header] = envName;
          index += 1;
        }
        mcpServers[extra.id] = {
          kind: 'http',
          url: extra.url,
          ...(Object.keys(envHttpHeaders).length > 0 ? { envHttpHeaders } : {}),
        };
      } else {
        mcpServers[extra.id] = {
          command: extra.command,
          args: extra.args,
          env: extra.env,
          ...(extra.cwd ? { cwd: extra.cwd } : {}),
        };
      }
    }
    const config: CodexRuntimeConfig = {
      instructions: this.deps.systemMessage,
      model: this.deps.model,
      mcpServers,
      // Default codex's built-in rollout compactor + per-tool-output
      // cap to ON for every session we manage. Codex's per-model
      // defaults leave both `null` for the gpt-5 family, which means
      // `codex exec resume` replays the full rollout every turn and
      // multi-turn token costs scale linearly with conversation
      // length. The codex-cli matrix had a single
      // squisq-review trial send 7.17 M input tokens across 7 turns
      // because of this. 120 K is a conservative ~12 % of a 1 M-token
      // window — well below where the model starts dropping content;
      // 16 K caps any single tool result (file read, repo walk) from
      // blowing the budget on its own. Users on tiny-context models
      // or who want to disable compaction entirely can override via
      // `codexCli.extraConfigOverrides`.
      autoCompactTokenLimit: 120_000,
      toolOutputTokenLimit: 16_000,
    };
    if (this.deps.reasoningEffort) {
      config.reasoningEffort = this.deps.reasoningEffort;
    }
    const codexHome = await writeRuntimeCodexHome({ path, config });
    return { codexHome, env: codexEnv };
  }

  private buildTurnHooks(): CodexInvokerHooks {
    return {
      emitDelta: (text: string) => this.emitDelta(text),
      emitIntent: (label: string) => this.emitIntent(label),
      emitHeartbeat: (label?: string) => this.emitHeartbeat(label),
      emitUsage: (usage: TurnUsage) => this.emitUsage(usage),
      emitWarning: (message: string) => this.emitWarning(message),
      onThreadStarted: (threadId: string) => {
        this.codexThreadIdCache = threadId;
      },
      ...(this.deps.onToolCall
        ? { onToolCall: (ev: ToolCallEvent) => this.deps.onToolCall?.(ev) }
        : {}),
    };
  }
}

async function writeCodexImageAttachments(
  codexHome: string,
  attachments: SendAndWaitOpts['attachments'],
): Promise<string[]> {
  if (!attachments || attachments.length === 0) return [];
  if (!codexHome) return [];
  const dir = join(codexHome, 'attachments', randomUUID());
  await mkdir(dir, { recursive: true });
  const out: string[] = [];
  for (let i = 0; i < attachments.length; i += 1) {
    const attachment = attachments[i]!;
    const ext = imageExtension(attachment.mimeType, attachment.filename);
    const path = join(dir, `image-${String(i + 1).padStart(2, '0')}${ext}`);
    await writeFile(path, Buffer.from(attachment.base64, 'base64'));
    out.push(path);
  }
  return out;
}

function imageExtension(mimeType: string, filename: string): string {
  const fromName = filename.match(/\.[A-Za-z0-9]{1,8}$/)?.[0]?.toLowerCase();
  if (fromName) return fromName;
  switch (mimeType.toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    default:
      return '.img';
  }
}

function sanitizeEnvSegment(value: string): string {
  const normalized = value.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
  return normalized.length > 0 ? normalized : 'MCP';
}
