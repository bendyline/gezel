/**
 * The record of what each session's system prompt was made of. Every distinct
 * prompt a session runs on is logged once as `prompt.compiled`, sizes only:
 * section by section, plus the tool schemas the engine templated beside it.
 * The text itself is personal (about.md, project docs, recalled memories), so
 * it is kept only in debug mode, the last few per session, under
 * `logs/prompts/<sessionId>/`.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type PromptFootprint, createLogger, estimateTokens } from '@bendyline/gezel';
import type { PromptSectionSize, ToolSurfaceSize } from '@bendyline/gezel/local-loop';
import type { HistoryManager } from '../history/manager.js';

const log = createLogger('prompt-record');

/** Prompt texts kept per session in debug mode. */
export const PROMPT_TEXTS_PER_SESSION = 5;
/** A session folder untouched this long is swept, like the service logs. */
const PROMPT_TEXT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** Sessions whose prompt was built but not yet run; older entries drop first. */
const MAX_TRACKED_SESSIONS = 256;
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface CompiledPrompt {
  systemMessage: string;
  volatileContext?: string;
  sections: PromptSectionSize[];
  /** Blocks the session adds after the build (craftbook editing, visitor rules). */
  extraSections?: PromptSectionSize[];
  provider: string;
  model?: string;
  footprint: PromptFootprint;
  contextWindow?: number;
}

interface PendingPrompt {
  projectId: string;
  gezelId: string;
  hash: string;
  details: Omit<CompiledPrompt, 'systemMessage' | 'volatileContext'> & {
    systemTokens: number;
    volatileTokens: number;
  };
  /** Present only when debug mode was on at build time. */
  text?: { systemMessage: string; volatileContext?: string };
}

export interface PromptRecorderDeps {
  history?: HistoryManager;
  /** `logs/` under the gezel home. */
  logsDir: string;
  debugEnabled: () => boolean;
}

export class PromptRecorder {
  private readonly pending = new Map<string, PendingPrompt>();
  private readonly loggedHash = new Map<string, string>();
  private lastSweepAt = 0;
  /** Orders texts written within the same millisecond. */
  private written = 0;

  constructor(private readonly deps: PromptRecorderDeps) {}

  /** Note the prompt a session was just built with. Logged on its first turn. */
  compiled(
    session: { id: string; projectId: string; gezelId: string },
    prompt: CompiledPrompt,
  ): void {
    const { systemMessage, volatileContext, ...rest } = prompt;
    const hash = createHash('sha256')
      .update(systemMessage)
      .update('\0')
      .update(volatileContext ?? '')
      .digest('hex')
      .slice(0, 16);
    this.pending.delete(session.id);
    this.pending.set(session.id, {
      projectId: session.projectId,
      gezelId: session.gezelId,
      hash,
      details: {
        ...rest,
        systemTokens: estimateTokens(systemMessage),
        volatileTokens: volatileContext ? estimateTokens(volatileContext) : 0,
      },
      ...(this.deps.debugEnabled()
        ? { text: { systemMessage, ...(volatileContext ? { volatileContext } : {}) } }
        : {}),
    });
    trim(this.pending);
  }

  /**
   * Log the session's current prompt if this session has not logged it yet.
   * Called after a turn ran, when the engine can say what tools it sent.
   */
  async flush(sessionId: string, tools?: ToolSurfaceSize): Promise<void> {
    const prompt = this.pending.get(sessionId);
    if (!prompt) return;
    this.pending.delete(sessionId);
    if (this.loggedHash.get(sessionId) === prompt.hash) return;
    this.loggedHash.delete(sessionId);
    this.loggedHash.set(sessionId, prompt.hash);
    trim(this.loggedHash);

    const { details } = prompt;
    const total = details.systemTokens + details.volatileTokens;
    const toolText = tools?.count ? ` + ${tools.count} tools (~${tools.tokens} tokens)` : '';
    await this.deps.history
      ?.log({
        kind: 'prompt.compiled',
        projectId: prompt.projectId,
        gezelId: prompt.gezelId,
        summary: `System prompt of ~${total} tokens${toolText} (${details.footprint})`,
        details: {
          sessionId,
          hash: prompt.hash,
          ...details,
          ...(tools ? { tools } : {}),
        },
      })
      .catch(() => {});
    if (prompt.text) await this.keepText(sessionId, prompt, tools).catch(warn);
  }

  private async keepText(
    sessionId: string,
    prompt: PendingPrompt,
    tools: ToolSurfaceSize | undefined,
  ): Promise<void> {
    if (!SAFE_SESSION_ID.test(sessionId) || !prompt.text) return;
    const root = join(this.deps.logsDir, 'prompts');
    const dir = join(root, sessionId);
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.written += 1;
    const name = `${stamp}-${String(this.written).padStart(6, '0')}-${prompt.hash}.md`;
    await writeFile(join(dir, name), renderPromptText(prompt, tools));
    const files = (await readdir(dir)).filter((name) => name.endsWith('.md')).sort();
    for (const name of files.slice(0, Math.max(0, files.length - PROMPT_TEXTS_PER_SESSION))) {
      await rm(join(dir, name), { force: true });
    }
    await this.sweep(root);
  }

  private async sweep(root: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastSweepAt < SWEEP_INTERVAL_MS) return;
    this.lastSweepAt = now;
    for (const name of await readdir(root)) {
      const dir = join(root, name);
      const info = await stat(dir).catch(() => null);
      if (info?.isDirectory() && now - info.mtimeMs > PROMPT_TEXT_RETENTION_MS) {
        await rm(dir, { recursive: true, force: true });
      }
    }
  }
}

function renderPromptText(prompt: PendingPrompt, tools: ToolSurfaceSize | undefined): string {
  const { details, text } = prompt;
  const sections = [...details.sections, ...(details.extraSections ?? [])]
    .map((s) => `| ${s.name} | ${s.band} | ${s.tokens} |`)
    .join('\n');
  return [
    `# Prompt ${prompt.hash}`,
    '',
    `- provider: ${details.provider}${details.model ? ` (${details.model})` : ''}`,
    `- footprint: ${details.footprint}${details.contextWindow ? `, window ${details.contextWindow}` : ''}`,
    `- system: ~${details.systemTokens} tokens, volatile: ~${details.volatileTokens} tokens`,
    ...(tools ? [`- tools: ${tools.count} (~${tools.tokens} tokens)`] : []),
    '',
    '| Section | Band | Tokens |',
    '|---|---|---|',
    sections,
    '',
    '## System message',
    '',
    text?.systemMessage ?? '',
    ...(text?.volatileContext ? ['', '## Volatile context', '', text.volatileContext] : []),
    '',
  ].join('\n');
}

function trim(map: Map<string, unknown>): void {
  while (map.size > MAX_TRACKED_SESSIONS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

function warn(err: unknown): void {
  log.warn('could not keep the prompt text:', err instanceof Error ? err.message : err);
}
