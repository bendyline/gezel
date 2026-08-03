/**
 * The fitness probe — one real session against the installed model,
 * two turns, five checks. See checks.ts for the verdict matrix and
 * docs/model-fitness.md for the concept (the proeve van bekwaamheid).
 *
 * Zero user-state pollution: the session is built directly on the
 * pool-resolved provider with a single synthetic external tool — no
 * gezel, no project, no MCP subprocess, no session record. External
 * tools are advertised but never executed; the provider halts on the
 * first call and surfaces it via `capturedToolCalls()`.
 *
 * Turn order matters:
 * - Turn A (plain generation) measures decode t/s — `TurnStatsEvent`
 *   fires only on the no-tool-call turn end, never on the external-
 *   tool halt branch. It also absorbs the cold model load, keeping
 *   turn B's timeout honest.
 * - Turn B (tool round-trip) runs last because after an external-tool
 *   halt the transcript ends on an unanswered assistant tool call —
 *   a subsequent turn risks chat-template alternation errors.
 */

import type { ModelFitnessRecord, ModelFitnessTrigger } from '@bendyline/gezel';
import { createLogger } from '@bendyline/gezel';
import type { ExternalToolCall, ExternalToolSpec, LLMProvider } from '../providers/types.js';
import {
  type FitnessEvidence,
  PROBE_TOOL_NAME,
  buildFitnessChecks,
  fitnessMinTps,
} from './checks.js';

const log = createLogger('fitness');

/** Engines the probe supports today. MLX/Ollama can join later. */
export type FitnessEngine = 'llama-cpp' | 'ds4';

/** Turn A dominates on cold GGUF load; generous by design. */
const GENERATION_TURN_TIMEOUT_MS = 360_000;
const TOOL_TURN_TIMEOUT_MS = 180_000;
/** Whole-probe hard cap — nothing hangs the serialized probe chain. */
const PROBE_HARD_CAP_MS = 12 * 60_000;

/** Provider-default launch context when nothing narrower is known. */
const DEFAULT_LAUNCH_NUM_CTX = 65_536;

const WRITE_FILE_SPEC: ExternalToolSpec = {
  name: PROBE_TOOL_NAME,
  description: 'Create or overwrite a file with the given content.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative file path to write.' },
      content: { type: 'string', description: 'The full file content.' },
    },
    required: ['path', 'content'],
  },
};

/**
 * The pool throws {@link EngineBusyError} (code `engine-busy`) when it
 * cannot evict a busy resident engine to make room for the probe model.
 * That is contention, not a model defect — the record is marked `blocked`
 * ("did not run") rather than `failed`. Match the code first, and fall
 * back to the stable message so a rewrapped error still classifies right.
 */
function isEngineBusy(err: unknown): boolean {
  if (err && typeof err === 'object' && (err as { code?: unknown }).code === 'engine-busy') {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /did not drain|busy serving requests/i.test(message);
}

const PROBE_SYSTEM_MESSAGE =
  'You are running a short capability check. Follow each instruction exactly.';

const GENERATION_PROMPT =
  'Write a short story of about 150 words about a journeyman carpenter finishing ' +
  'their masterpiece. Reply with prose only — do not call any tool.';

const TOOL_PROMPT = `Call the ${PROBE_TOOL_NAME} tool now to create the file \`proeve.txt\` with the content \`PROEVE OK\`. Make exactly that one tool call. Do not reply with prose.`;

export interface FitnessProbeDeps {
  /** Pool-admitted provider resolution — ChatManager.getProviderForModel. */
  getProviderForModel(name: FitnessEngine, modelId: string): Promise<LLMProvider>;
  /** Installed-model summary for staleness keys + context window. */
  resolveInstalled(
    engine: FitnessEngine,
    modelId: string,
  ): Promise<{ sha256?: string; catalogVersion?: string; contextWindow?: number } | null>;
  /** Manifest reasoning budget the supervisor would launch with. */
  resolveReasoningBudget(modelId: string): Promise<number | undefined>;
  /** Host memory profile, recorded on the report. */
  detectMemory(): Promise<{ totalRamBytes: number; gpuVramBytes: number | null; source: string }>;
  /** The user-facing launch numCtx setting, when configured. */
  configuredNumCtx(): Promise<number | undefined>;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
}

export interface FitnessProbeArgs {
  provider: FitnessEngine;
  modelId: string;
  trigger: ModelFitnessTrigger;
  /** Test seam — shrink the turn/hard-cap timeouts. */
  timeouts?: { generationMs?: number; toolMs?: number; hardCapMs?: number };
}

/**
 * Run the probe to a persisted-shape record. NEVER throws: every
 * failure mode — spawn denial, turn timeout, invalid capture — lands
 * in the returned record (`status: 'failed'` for machinery errors vs
 * `status: 'probed', admitted: false` for failed checks).
 */
export async function runFitnessProbe(
  deps: FitnessProbeDeps,
  args: FitnessProbeArgs,
): Promise<ModelFitnessRecord> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const hardCapMs = args.timeouts?.hardCapMs ?? PROBE_HARD_CAP_MS;

  let hardCapTimer: NodeJS.Timeout | undefined;
  const hardCap = new Promise<never>((_, reject) => {
    hardCapTimer = setTimeout(
      () =>
        reject(new Error(`probe exceeded the ${Math.round(hardCapMs / 60_000)}-minute hard cap`)),
      hardCapMs,
    );
    hardCapTimer.unref?.();
  });

  const host = await deps
    .detectMemory()
    .catch(() => ({ totalRamBytes: 0, gpuVramBytes: null, source: 'unknown' }));
  const installed = await deps.resolveInstalled(args.provider, args.modelId).catch(() => null);
  const reasoningBudget = await deps.resolveReasoningBudget(args.modelId).catch(() => undefined);
  const configuredCtx = await deps.configuredNumCtx().catch(() => undefined);

  const envCtxRaw = (deps.env ?? process.env).GEZEL_LLAMA_NUM_CTX;
  const envCtx = envCtxRaw ? Number.parseInt(envCtxRaw, 10) : Number.NaN;
  const launchCtx =
    Number.isFinite(envCtx) && envCtx > 0 ? envCtx : (configuredCtx ?? DEFAULT_LAUNCH_NUM_CTX);
  const effectiveContextTokens =
    installed?.contextWindow != null ? Math.min(installed.contextWindow, launchCtx) : launchCtx;

  const evidence: FitnessEvidence = {
    genTokensPerSec: null,
    observedThinking: false,
    reasoningBudget,
    effectiveContextTokens,
    minGenTokensPerSec: fitnessMinTps(deps.env),
  };
  let machineryFailed = false;
  let contended = false;

  const runTurns = async (): Promise<void> => {
    let provider: LLMProvider;
    try {
      provider = await deps.getProviderForModel(args.provider, args.modelId);
    } catch (err) {
      evidence.spawnError = err instanceof Error ? err.message : String(err);
      machineryFailed = true;
      if (isEngineBusy(err)) contended = true;
      return;
    }

    let session: Awaited<ReturnType<LLMProvider['createSession']>>;
    try {
      session = await provider.createSession({
        systemMessage: PROBE_SYSTEM_MESSAGE,
        model: args.modelId,
        externalTools: [WRITE_FILE_SPEC],
      });
    } catch (err) {
      evidence.spawnError = `session creation failed: ${err instanceof Error ? err.message : String(err)}`;
      machineryFailed = true;
      return;
    }

    try {
      (
        session as { onTurnStats?: (h: (ev: { tokensPerSec?: number }) => void) => void }
      ).onTurnStats?.((ev) => {
        if (typeof ev.tokensPerSec === 'number' && Number.isFinite(ev.tokensPerSec)) {
          evidence.genTokensPerSec = ev.tokensPerSec;
        }
      });

      const queue = { lane: 'background' as const, job: `proeve · ${args.modelId}` };

      try {
        await session.sendAndWait(GENERATION_PROMPT, {
          timeoutMs: args.timeouts?.generationMs ?? GENERATION_TURN_TIMEOUT_MS,
          queue,
        });
      } catch (err) {
        evidence.generationError = err instanceof Error ? err.message : String(err);
        machineryFailed = true;
        return;
      }
      if (session.getLastTurnReasoning?.() !== undefined) evidence.observedThinking = true;

      let toolTurnText = '';
      try {
        toolTurnText = await session.sendAndWait(TOOL_PROMPT, {
          timeoutMs: args.timeouts?.toolMs ?? TOOL_TURN_TIMEOUT_MS,
          queue,
        });
      } catch (err) {
        evidence.toolTurnError = err instanceof Error ? err.message : String(err);
        machineryFailed = true;
        return;
      }
      if (session.getLastTurnReasoning?.() !== undefined) evidence.observedThinking = true;

      const calls: ExternalToolCall[] = session.capturedToolCalls?.() ?? [];
      const first = calls[0];
      evidence.toolCall = first ? { name: first.name, argumentsJson: first.arguments } : null;
      evidence.toolTurnText = toolTurnText;
    } finally {
      await session.disconnect().catch(() => {});
    }
  };

  try {
    await Promise.race([runTurns(), hardCap]);
  } catch (err) {
    // Hard cap fired (or an unexpected escape). Record it on the most
    // meaningful unset axis so the detail survives into the report.
    const message = err instanceof Error ? err.message : String(err);
    if (!evidence.spawnError && evidence.genTokensPerSec == null && !evidence.generationError) {
      evidence.generationError = message;
    } else if (evidence.toolCall === undefined && !evidence.toolTurnError) {
      evidence.toolTurnError = message;
    }
    machineryFailed = true;
  } finally {
    if (hardCapTimer) clearTimeout(hardCapTimer);
  }

  const { checks, admitted } = buildFitnessChecks(evidence);
  const record: ModelFitnessRecord = {
    schemaVersion: 1,
    provider: args.provider,
    modelId: args.modelId,
    status: contended ? 'blocked' : machineryFailed ? 'failed' : 'probed',
    admitted: machineryFailed ? false : admitted,
    genTokensPerSec: evidence.genTokensPerSec,
    createdAt: new Date(now()).toISOString(),
    durationMs: Math.max(0, now() - startedAt),
    trigger: args.trigger,
    ...(installed?.sha256 ? { sha256: installed.sha256 } : {}),
    ...(installed?.catalogVersion ? { catalogVersion: installed.catalogVersion } : {}),
    ...(installed?.contextWindow != null ? { contextWindow: installed.contextWindow } : {}),
    host,
    checks,
  };
  log.info(
    `proeve ${args.provider}/${args.modelId}: status=${record.status} admitted=${record.admitted} ` +
      `tps=${record.genTokensPerSec?.toFixed(1) ?? 'n/a'} (${Math.round(record.durationMs / 1000)}s, ${args.trigger})`,
  );
  return record;
}
