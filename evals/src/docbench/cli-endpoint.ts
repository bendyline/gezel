/**
 * Frontier reference models for docbench: an OpenAI-compatible endpoint in
 * front of the Claude and Codex CLIs, so the task pack can run against them
 * exactly as it runs against a trial gezeld.
 *
 * DocBlocks does not route to these models. They are measured as a ceiling
 * beside the local field: the same requests, the same parsers and repairs,
 * the same judge. They can never be published (the publish step refuses any
 * model that is not in the chat-model catalog).
 *
 * Each request runs the CLI as a bare model, as far as the CLI allows:
 *
 * - **Claude**: `claude -p` from an empty directory, the request's system
 *   message as the whole system prompt (`--system-prompt-file`), no tools,
 *   no settings sources (so no CLAUDE.md, memory, hooks or MCP), and
 *   `--json-schema` when the request asks for structured output.
 * - **Codex**: `codex exec` from an empty directory in a read-only sandbox,
 *   ignoring the user's config and rules, the system message as the model
 *   instructions (`model_instructions_file`), web search and the apps,
 *   plugin and multi-agent features off, and `--output-schema` for
 *   structured output. Codex still adds its own tool and permission
 *   framing, which cannot be turned off.
 *
 * What the CLIs cannot honor: `temperature`, `seed` and `max_tokens`. Reasoning
 * cannot be switched off either: a request that asks for none (everything but
 * writing) runs at the lowest effort, `low`; writing runs at `medium`.
 */

import { spawn } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export type ReferenceCli = 'claude' | 'codex';

export interface ReferenceModel {
  readonly cli: ReferenceCli;
  /** The id the CLI takes, such as `claude-opus-5-5` or `gpt-6.1-sol`. */
  readonly model: string;
}

/**
 * The reference model a docbench model id names: `claude-<model>` runs on the
 * Claude CLI as itself, `codex-<model>` runs `<model>` on the Codex CLI.
 * Anything else is a catalog model.
 */
export function referenceModel(modelId: string): ReferenceModel | null {
  if (/^claude-[a-z0-9.-]+$/u.test(modelId)) return { cli: 'claude', model: modelId };
  const codex = /^codex-([a-z0-9][a-z0-9.-]*)$/u.exec(modelId);
  if (codex?.[1]) return { cli: 'codex', model: codex[1] };
  return null;
}

/** The effort a CLI runs at for a request's `reasoning_effort`. */
export function cliEffort(reasoningEffort: unknown): 'low' | 'medium' {
  return reasoningEffort === 'none' || reasoningEffort === 'minimal' || reasoningEffort === 'low'
    ? 'low'
    : 'medium';
}

interface WirePart {
  readonly type?: unknown;
  readonly text?: unknown;
}

interface WireMessage {
  readonly role?: unknown;
  readonly content?: unknown;
}

function messageText(message: WireMessage): string {
  if (typeof message.content === 'string') return message.content;
  if (message.content === null || message.content === undefined) return '';
  if (!Array.isArray(message.content)) throw new Error('message content must be text');
  return (message.content as WirePart[])
    .map((part) => {
      if (part.type !== 'text') throw new Error(`unsupported content part: ${String(part.type)}`);
      return typeof part.text === 'string' ? part.text : '';
    })
    .join('');
}

export interface CliPrompt {
  readonly system: string;
  readonly prompt: string;
}

/**
 * A chat as one system prompt and one user prompt. A CLI takes a single user
 * turn, so a conversation with earlier turns (a repair after an unreadable
 * reply) is written out as a transcript ahead of the last user message.
 */
export function flattenMessages(messages: readonly WireMessage[]): CliPrompt {
  const system = messages
    .filter((message) => message.role === 'system' || message.role === 'developer')
    .map(messageText)
    .filter((text) => text.trim())
    .join('\n\n');
  const turns = messages.filter(
    (message) => message.role === 'user' || message.role === 'assistant',
  );
  const last = turns.at(-1);
  if (!last || last.role !== 'user') {
    throw new Error('the conversation must end with a user message');
  }
  if (turns.length === 1) return { system, prompt: messageText(last) };
  const earlier = turns
    .slice(0, -1)
    .map(
      (message) =>
        `${message.role === 'user' ? 'User' : 'You (your earlier reply)'}:\n${messageText(message)}`,
    )
    .join('\n\n');
  return {
    system,
    prompt: `Earlier in this conversation:\n\n${earlier}\n\nNow the user says:\n\n${messageText(last)}`,
  };
}

/** A JSON schema the request asks the reply to follow, if any. */
function requestedSchema(body: Record<string, unknown>): Record<string, unknown> | null {
  const format = body.response_format as
    | { type?: unknown; json_schema?: { schema?: unknown } }
    | undefined;
  if (format?.type !== 'json_schema') return null;
  const schema = format.json_schema?.schema;
  return schema && typeof schema === 'object' ? (schema as Record<string, unknown>) : null;
}

export interface CliReply {
  readonly text: string;
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly costUsd: number | null;
  /** The schema was sent and honored; false when the CLI refused it and the reply is unconstrained. */
  readonly schemaApplied: boolean;
  /** Why the CLI refused the schema, when it did. */
  readonly schemaRefused?: string;
}

/** The CLI failed: the endpoint's fault, so the pack retries the case and never scores it. */
export class CliFailure extends Error {}

interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

function runProcess(
  command: string,
  args: readonly string[],
  input: string,
  cwd: string,
  timeoutMs: number,
): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
    child.stdin.end(input);
  });
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function tail(text: string, max = 600): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
}

export interface CliRunOptions {
  readonly reference: ReferenceModel;
  readonly prompt: CliPrompt;
  readonly effort: 'low' | 'medium';
  readonly schema: Record<string, unknown> | null;
  readonly claudeBin: string;
  readonly codexBin: string;
  readonly timeoutMs: number;
}

async function runClaude(options: CliRunOptions, dir: string): Promise<CliReply> {
  const systemFile = join(dir, '..', 'system.md');
  await writeFile(systemFile, options.prompt.system || 'You are a helpful assistant.');
  const args = [
    '-p',
    '--model',
    options.reference.model,
    '--system-prompt-file',
    systemFile,
    '--tools',
    '',
    '--setting-sources',
    '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--output-format',
    'json',
    '--effort',
    options.effort,
    ...(options.schema ? ['--json-schema', JSON.stringify(options.schema)] : []),
  ];
  const run = await runProcess(
    options.claudeBin,
    args,
    options.prompt.prompt,
    dir,
    options.timeoutMs,
  );
  if (run.timedOut) throw new CliFailure(`claude timed out after ${String(options.timeoutMs)} ms`);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(run.stdout) as Record<string, unknown>;
  } catch {
    throw new CliFailure(
      `claude exited ${String(run.code)} without a result: ${tail(run.stderr || run.stdout)}`,
    );
  }
  const usage = (parsed.usage ?? {}) as Record<string, unknown>;
  const structured = parsed.structured_output;
  const result = typeof parsed.result === 'string' ? parsed.result : '';
  // A schema the model could not satisfy is the model's failure, not the
  // endpoint's: its last attempt is in `result`, which the product would read.
  const schemaGaveUp = parsed.subtype === 'error_max_structured_output_retries';
  if ((parsed.is_error === true || run.code !== 0) && !schemaGaveUp) {
    throw new CliFailure(`claude ${String(parsed.subtype)}: ${tail(result || run.stderr)}`);
  }
  // The CLI answers a retired model id with the current model and says so
  // only in modelUsage, so a reply from any other model is not this model's.
  const served = Object.keys((parsed.modelUsage ?? {}) as Record<string, unknown>);
  const requested = options.reference.model;
  if (
    served.length > 0 &&
    !served.some((id) => id === requested || new RegExp(`^${requested}-\\d{8}$`).test(id))
  ) {
    throw new CliFailure(`claude served ${served.join(', ')} instead of ${requested}`);
  }
  const promptTokens =
    (count(usage.input_tokens) ?? 0) +
    (count(usage.cache_read_input_tokens) ?? 0) +
    (count(usage.cache_creation_input_tokens) ?? 0);
  return {
    text: structured !== undefined && structured !== null ? JSON.stringify(structured) : result,
    promptTokens: promptTokens || null,
    completionTokens: count(usage.output_tokens),
    costUsd: count(parsed.total_cost_usd),
    schemaApplied: options.schema !== null && structured !== undefined && structured !== null,
  };
}

/** Codex features that would hand the model tools a person's DocBlocks never has. */
const CODEX_FEATURES_OFF = [
  'apps',
  'plugins',
  'remote_plugin',
  'image_generation',
  'goals',
  'multi_agent',
  'browser_use',
  'browser_use_external',
  'computer_use',
  'tool_suggest',
  'skill_search',
] as const;

async function runCodexOnce(
  options: CliRunOptions,
  dir: string,
  schema: Record<string, unknown> | null,
): Promise<CliReply & { failure: string | null }> {
  const instructions = join(dir, '..', 'instructions.md');
  await writeFile(instructions, options.prompt.system || 'You are a helpful assistant.');
  const lastMessage = join(dir, '..', 'last-message.txt');
  await rm(lastMessage, { force: true });
  const schemaFile = join(dir, '..', 'schema.json');
  if (schema) await writeFile(schemaFile, JSON.stringify(schema));
  const args = [
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    '--sandbox',
    'read-only',
    '-C',
    dir,
    '-m',
    options.reference.model,
    '-c',
    `model_reasoning_effort="${options.effort}"`,
    '-c',
    `model_instructions_file=${JSON.stringify(instructions)}`,
    '-c',
    'web_search="disabled"',
    ...CODEX_FEATURES_OFF.flatMap((feature) => ['-c', `features.${feature}=false`]),
    ...(schema ? ['--output-schema', schemaFile] : []),
    '-o',
    lastMessage,
    '-',
  ];
  const run = await runProcess(
    options.codexBin,
    args,
    options.prompt.prompt,
    dir,
    options.timeoutMs,
  );
  if (run.timedOut) throw new CliFailure(`codex timed out after ${String(options.timeoutMs)} ms`);
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  const errors: string[] = [];
  for (const line of run.stdout.split('\n')) {
    if (!line.trim().startsWith('{')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === 'turn.completed') {
      const usage = (event.usage ?? {}) as Record<string, unknown>;
      promptTokens = count(usage.input_tokens);
      completionTokens = count(usage.output_tokens);
    } else if (event.type === 'turn.failed' || event.type === 'error') {
      const error = (event.error ?? {}) as Record<string, unknown>;
      errors.push(String(error.message ?? event.message ?? JSON.stringify(event)));
    }
  }
  const text = await readFile(lastMessage, 'utf8').catch(() => null);
  const failure =
    run.code === 0 && text !== null
      ? null
      : `codex exited ${String(run.code)}: ${tail(errors.join(' | ') || run.stderr)}`;
  return {
    text: text ?? '',
    promptTokens,
    completionTokens,
    costUsd: null,
    schemaApplied: schema !== null,
    failure,
  };
}

async function runCodex(options: CliRunOptions, dir: string): Promise<CliReply> {
  const first = await runCodexOnce(options, dir, options.schema);
  if (!first.failure) return first;
  // OpenAI's strict mode rejects schemas other engines accept. Without the
  // schema the reply is the model's own JSON, which the product still parses.
  if (options.schema && /schema/iu.test(first.failure)) {
    const second = await runCodexOnce(options, dir, null);
    if (!second.failure) return { ...second, schemaRefused: first.failure.slice(0, 300) };
    throw new CliFailure(second.failure);
  }
  throw new CliFailure(first.failure);
}

/** Run one request on a CLI, in a fresh empty directory. */
export async function runCli(options: CliRunOptions): Promise<CliReply> {
  const scratch = await mkdtemp(join(tmpdir(), 'docbench-cli-'));
  const dir = join(scratch, 'work');
  try {
    await mkdir(dir);
    return options.reference.cli === 'claude'
      ? await runClaude(options, dir)
      : await runCodex(options, dir);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export interface CliEndpointOptions {
  /** The docbench model id the pack sends, such as `claude-opus-5-5`. */
  readonly modelId: string;
  readonly reference: ReferenceModel;
  /** The context window `/v1/models` reports, so budgets match the local field's. */
  readonly contextWindow: number;
  readonly claudeBin: string;
  readonly codexBin: string;
  /** One CLI run's limit; under the pack's own request timeout. */
  readonly timeoutMs?: number;
  /** Every call, one JSON line each: effort, schema, tokens, cost, time. */
  readonly callLog?: string;
  readonly log?: (line: string) => void;
  /**
   * CLI runs at once. One (the default) for a contestant, as a laptop runs a
   * local model; more only when the endpoint serves a judge.
   */
  readonly concurrency?: number;
  /** A fixed port, so a judge keyed by its base URL stays the same across runs; any free port by default. */
  readonly port?: number;
}

export interface CliEndpoint {
  /** The base URL, ending in `/v1`. */
  readonly baseUrl: string;
  close(): Promise<void>;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Serve `/v1/models` and `/v1/chat/completions` for one reference model, `concurrency` requests at a time. */
export async function startCliEndpoint(options: CliEndpointOptions): Promise<CliEndpoint> {
  const timeoutMs = options.timeoutMs ?? 9 * 60_000;
  const limit = Math.max(1, options.concurrency ?? 1);
  let running = 0;
  const waiting: (() => void)[] = [];
  const serialized = async <T>(work: () => Promise<T>): Promise<T> => {
    if (running >= limit) await new Promise<void>((resolveTurn) => waiting.push(resolveTurn));
    running += 1;
    try {
      return await work();
    } finally {
      running -= 1;
      waiting.shift()?.();
    }
  };

  const complete = async (body: Record<string, unknown>) => {
    const messages = Array.isArray(body.messages) ? (body.messages as WireMessage[]) : [];
    const prompt = flattenMessages(messages);
    const effort = cliEffort(body.reasoning_effort);
    const schema = requestedSchema(body);
    const started = Date.now();
    try {
      const reply = await serialized(() =>
        runCli({
          reference: options.reference,
          prompt,
          effort,
          schema,
          claudeBin: options.claudeBin,
          codexBin: options.codexBin,
          timeoutMs,
        }),
      );
      if (options.callLog) {
        await appendFile(
          options.callLog,
          `${JSON.stringify({
            at: new Date().toISOString(),
            ms: Date.now() - started,
            effort,
            schema: schema !== null,
            schemaApplied: reply.schemaApplied,
            ...(reply.schemaRefused ? { schemaRefused: reply.schemaRefused } : {}),
            turns: messages.length,
            promptTokens: reply.promptTokens,
            completionTokens: reply.completionTokens,
            costUsd: reply.costUsd,
            chars: reply.text.length,
          })}\n`,
        );
      }
      return reply;
    } catch (error: unknown) {
      if (options.callLog) {
        await appendFile(
          options.callLog,
          `${JSON.stringify({
            at: new Date().toISOString(),
            ms: Date.now() - started,
            effort,
            schema: schema !== null,
            error: error instanceof Error ? error.message : String(error),
          })}\n`,
        );
      }
      throw error;
    }
  };

  const server = createServer((request, response) => {
    void (async () => {
      const path = (request.url ?? '').split('?')[0];
      if (request.method === 'GET' && path === '/v1/models') {
        sendJson(response, 200, {
          object: 'list',
          data: [{ id: options.modelId, object: 'model', context_window: options.contextWindow }],
        });
        return;
      }
      if (request.method !== 'POST' || path !== '/v1/chat/completions') {
        sendJson(response, 404, { error: { message: 'not found' } });
        return;
      }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(await readBody(request)) as Record<string, unknown>;
      } catch {
        sendJson(response, 400, { error: { message: 'Request body is not valid JSON.' } });
        return;
      }
      try {
        const reply = await complete(body);
        sendJson(response, 200, {
          id: `docbench-${Date.now().toString(36)}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: options.modelId,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: reply.text },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: reply.promptTokens ?? 0,
            completion_tokens: reply.completionTokens ?? 0,
          },
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        options.log?.(`cli failure: ${message.slice(0, 300)}`);
        // A 5xx: the pack records an endpoint failure, retries the case, and never scores it.
        sendJson(response, error instanceof CliFailure ? 502 : 500, {
          error: { message, type: 'server_error' },
        });
      }
    })();
  });
  // A CLI run can take minutes; never let Node's defaults cut the socket first.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 0;
  await new Promise<void>((resolvePromise) =>
    server.listen(options.port ?? 0, '127.0.0.1', resolvePromise),
  );
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}/v1`,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.closeAllConnections();
        server.close(() => resolvePromise());
      }),
  };
}
