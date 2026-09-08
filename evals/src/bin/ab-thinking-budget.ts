/**
 * Compact thinking-budget pathology probes through real Gezel chat sessions.
 * One isolated daemon/model stays resident; each cell gets a fresh session,
 * with a stable crew/project, paired seeds and only thinkingBudget varied.
 * This is a diagnostic experiment, not the published capability scorecard.
 *
 * pnpm --filter @bendyline/gezel-evals exec tsx src/bin/ab-thinking-budget.ts
 *   --model gemma4-31b-q4 --budgets 96,512,2048,4096 --count 1 --timeout 15m
 *
 * --conversation-file accepts { id, prompt, history?: [{role,content}], about? }.
 * History is seeded before the session first runs; prior reasoning is omitted.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  copyFile,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { finished } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import {
  AwakeBudget,
  type ChatMessage,
  type ChatSession,
  assertSafeEntityId,
  awakeNow,
} from '@bendyline/gezel';
import type { GezelClient } from '@bendyline/gezel-client';
import { resolveDaemonEntry } from '@bendyline/gezel-client/node';
import { Store } from '@bendyline/gezel-service';
import { acquireEvalDeviceLock } from '../eval-device-lock.ts';
import { defaultCacheRoot } from '../model-cache.ts';
import { resolveLlamaBinary } from '../native-bin.ts';
import { startChatEventRecorder } from '../recording/recorder.ts';
import {
  evalDaemonEnvForTrial,
  evalLlamaSpecTypeOverride,
  localEvalDeviceSafetyConfig,
} from '../runner.ts';
import { inspectServiceDistArtifact } from '../service-dist-authority.ts';
import { installEvalSignalHandlers } from '../signal-handler.ts';
import { shutdownTrialDaemon, spawnTrialDaemon } from '../spawn.ts';
import { assertKnownFlags, parseArgs, parseDuration } from './args.ts';

export interface ThinkingProbe {
  id: string;
  prompt: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  about?: string;
  /** Conversation fixtures may permit file tools while forbidding research. */
  allowTools?: boolean;
  fixture?: Record<string, string>;
  check?: 'tool-write' | 'code-repair';
  expected?: string[];
}

export function experimentProvenance(
  source: string | Buffer,
  env: NodeJS.ProcessEnv = process.env,
) {
  const specType = evalLlamaSpecTypeOverride(env);
  return {
    harnessSha256: createHash('sha256').update(source).digest('hex'),
    projectWritePolicy: 'allow',
    engineOverrides: specType === undefined ? {} : { llamaCppSpecType: specType },
    environment: {
      GEZEL_NATIVE_CAPACITY_AUTHORITY: env.GEZEL_NATIVE_CAPACITY_AUTHORITY ?? null,
    },
  };
}

export function thinkingDaemonArtifact(
  explicitEntry?: string,
  resolveDefault: () => string = () => resolveDaemonEntry(import.meta.url),
) {
  return inspectServiceDistArtifact(resolve(explicitEntry ?? resolveDefault()));
}

function isDescendant(base: string, candidate: string): boolean {
  const suffix = relative(base, candidate);
  return (
    suffix.length > 0 && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
  );
}

/** Clear only a generated probe's contents, retaining the watched directory. */
export async function resetProbeWorkspace(runRoot: string, workspace: string): Promise<void> {
  await resetOwnedProbeDirectory(runRoot, resolve(runRoot, 'workspaces'), workspace, 'workspace');
}

/** Artifacts are another file-tool surface shared by the stable per-probe project. */
export async function resetProbeArtifacts(home: string, projectId: string): Promise<void> {
  assertSafeEntityId(projectId, 'probe project id');
  const projectRoot = resolve(home, 'projects', projectId);
  await resetOwnedProbeDirectory(home, projectRoot, join(projectRoot, 'artifacts'), 'artifacts');
}

async function resetOwnedProbeDirectory(
  root: string,
  ownedRoot: string,
  directory: string,
  label: string,
): Promise<void> {
  const target = resolve(directory);
  if (!isDescendant(ownedRoot, target))
    throw new Error(`refusing to reset ${label} outside the owned probe directory`);
  const [realRunRoot, realOwnedRoot, realTarget, targetStat] = await Promise.all([
    realpath(resolve(root)),
    realpath(ownedRoot),
    realpath(target),
    lstat(target),
  ]);
  if (
    !isDescendant(realRunRoot, realOwnedRoot) ||
    !isDescendant(realOwnedRoot, realTarget) ||
    relative(resolve(realRunRoot, relative(resolve(root), ownedRoot)), realOwnedRoot) !== '' ||
    relative(resolve(realOwnedRoot, relative(ownedRoot, target)), realTarget) !== '' ||
    targetStat.isSymbolicLink() ||
    !targetStat.isDirectory()
  )
    throw new Error(`refusing to reset redirected or non-directory probe ${label}`);
  const entries = await readdir(target, { withFileTypes: true });
  const removals: Array<{ path: string; recursive: boolean }> = [];
  for (const entry of entries) {
    const path = resolve(target, entry.name);
    if (!isDescendant(target, path))
      throw new Error(`refusing to remove an entry outside the owned probe ${label}`);
    const entryStat = await lstat(path);
    // Links are removed as links, never traversed. Actual directories must
    // also resolve inside this directory before any recursive removal begins.
    const recursive = entryStat.isDirectory() && !entryStat.isSymbolicLink();
    if (recursive && !isDescendant(realTarget, await realpath(path)))
      throw new Error(`refusing to remove a redirected probe ${label} directory`);
    removals.push({ path, recursive });
  }
  for (const entry of removals) await rm(entry.path, { recursive: entry.recursive, force: true });
}

export const THINKING_PROBES: ThinkingProbe[] = [
  {
    id: 'tool-write',
    prompt:
      'Please create receipt.txt in this project workspace containing exactly READY on its own line. Then tell me it is done.',
    check: 'tool-write',
  },
  {
    id: 'simple-answer',
    prompt: 'What is the capital of France? Please answer in one sentence without tools.',
    expected: ['Paris'],
  },
  {
    id: 'arithmetic',
    prompt:
      'No tools: a workshop starts with 47 bolts, receives 3 boxes of 28 bolts, and uses 19 bolts on each of 4 repairs. How many bolts remain? Give the result and a short calculation.',
    expected: ['55'],
  },
  {
    id: 'logic-order',
    prompt:
      'No tools. Four talks A, B, C and D occupy slots 1–4. A is before B, C is immediately after A, and D is before A. What is the only possible order? Briefly explain.',
  },
  {
    id: 'code-explain',
    prompt:
      'Without tools, explain why this JavaScript returns [3,3,3] and show the smallest correction that makes it return [0,1,2]: const callbacks=[]; for(var i=0;i<3;i++){callbacks.push(()=>i)}; callbacks.map(f=>f()).',
    expected: ['let'],
  },
  {
    id: 'code-repair',
    prompt:
      'Please fix rangeSum in sums.js in this workspace. It must add every integer from start through end inclusive, and return 0 when end is less than start. Preserve the function name. Make the edit, then briefly describe it.',
    fixture: {
      'sums.js':
        'function rangeSum(start, end) { let total = 0; for (let n = start; n < end; n++) total += n; return total; }\n',
    },
    check: 'code-repair',
  },
  {
    id: 'grounded-summary',
    prompt:
      'Use only these notes, without tools: Monday: pump A pressure normal; Tuesday: pressure fell after filter replacement; Wednesday: fitting tightened, pressure normal again; technician says cause unconfirmed. Give a two-sentence incident summary that preserves uncertainty.',
    expected: ['filter', 'pressure'],
  },
  {
    id: 'constraint-writing',
    prompt:
      'Without tools, write a friendly email of at most 70 words asking a neighbor to turn music down after 10 pm. Mention an early work shift and suggest headphones. Do not threaten or invoke any law.',
    expected: ['headphones'],
  },
  {
    id: 'probability',
    prompt:
      'No tools. A bag contains 3 red and 2 blue marbles. Two are drawn without replacement. What is the probability they have different colors? Give an exact fraction and a brief explanation.',
    expected: ['3/5'],
  },
  {
    id: 'schedule',
    prompt:
      'No tools. Packaging takes 20 minutes after assembly (35 minutes). Inspection (15 minutes) also starts after assembly. Shipping can begin only after both packaging and inspection finish. All tasks start as early as possible from 9:00. When can shipping begin? Briefly explain.',
    expected: ['9:55'],
  },
];

export interface BudgetCell {
  id: string;
  probeId: string;
  budget: number;
  seed: number;
}
export function buildBudgetPlan(
  probes: ThinkingProbe[],
  budgets: number[],
  count: number,
  seedStart = 0,
): BudgetCell[] {
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    !budgets.length ||
    budgets.some((b) => !Number.isSafeInteger(b) || b < 1)
  )
    throw new Error('count and budgets must be positive integers');
  if (
    !Number.isSafeInteger(seedStart) ||
    seedStart < 0 ||
    new Set(budgets).size !== budgets.length ||
    new Set(probes.map((p) => p.id)).size !== probes.length
  )
    throw new Error('seeds must be nonnegative integers and probe/budget ids unique');
  const plan: BudgetCell[] = [];
  for (let replicate = 0; replicate < count; replicate++) {
    for (const [index, probe] of probes.entries()) {
      const offset = (replicate + index) % budgets.length;
      const order = [...budgets.slice(offset), ...budgets.slice(0, offset)];
      for (const budget of order)
        plan.push({
          id: `${probe.id}__seed-${seedStart + replicate}__budget-${budget}`,
          probeId: probe.id,
          budget,
          seed: seedStart + replicate,
        });
    }
  }
  return plan;
}

/** Review flags, not an automatic claim that every first-person phrase leaks. */
export function inspectThinkingOutput(
  messages: Pick<ChatMessage, 'role' | 'content' | 'reasoning' | 'toolCalls'>[],
) {
  const assistant = messages.filter((m) => m.role === 'assistant');
  const content = assistant.map((m) => m.content).join('\n');
  const reasoning = assistant.map((m) => m.reasoning ?? '').join('\n');
  const flags: string[] = [];
  if (/<\/?think>|<\|(?:channel|analysis|thought)\|>/.test(content))
    flags.push('reasoning-markup-in-content');
  if (
    /\b(?:the user (?:asks|wants|requested)|I (?:need|should|must) (?:to )?(?:answer|respond|reply)|I will (?:answer|reply)|let me (?:think|reason|analyze))\b/i.test(
      content,
    )
  )
    flags.push('possible-planning-in-content');
  if (assistant.some((m) => /[,(]\s*$/.test(m.reasoning ?? '') && /^[a-z]/.test(m.content.trim())))
    flags.push('possible-mid-sentence-channel-boundary');
  return {
    content,
    reasoning,
    assistantMessages: assistant.length,
    toolCalls: assistant.reduce((n, m) => n + (m.toolCalls?.length ?? 0), 0),
    flags,
  };
}

export function parseBudgetDiagnostics(log: string) {
  const requests: Record<string, unknown>[] = [];
  for (const line of log.split('\n')) {
    const at = line.indexOf('[llama-cpp] request-reasoning ');
    if (at < 0) continue;
    try {
      requests.push(JSON.parse(line.slice(line.indexOf('{', at))) as Record<string, unknown>);
    } catch {
      /* incomplete tail */
    }
  }
  return {
    requests,
    forcedEndCount: (
      log.match(/budget exhausted[^\n]*(?:forcing|end sequence)|forcing end sequence/gi) ?? []
    ).length,
    naturalEndCount: (log.match(/deactivated \(natural end\)/g) ?? []).length,
    // Count actual manager continuations once, not both the detector's
    // explanation (e.g. prose-deliverable) and its subsequent recovery send.
    recoveryCount: (log.match(/continuing stalled session \S+ \(nudge \d+\/\d+/g) ?? []).length,
    launchCount: (log.match(/\[llama-server\] launch /g) ?? []).length,
  };
}

export function checkBudgetDiagnostics(
  diagnostics: ReturnType<typeof parseBudgetDiagnostics>,
  budget: number,
) {
  const requests = diagnostics.requests;
  const thinkingEnabledRequestCount = requests.filter((r) => r.enableThinking !== false).length;
  return {
    configValid: requests.length > 0 && requests.every((r) => r.reasoningBudgetTokens === budget),
    thinkingEnabledRequestCount,
    thinkingDisabledRequestCount: requests.length - thinkingEnabledRequestCount,
    // Immediate file edits may deliberately disable thinking in the product.
    // They remain useful regression controls, not cap-effect measurements.
    informativeForThinkingBudget: thinkingEnabledRequestCount > 0,
  };
}

/** Preserve terminal errors even when a partial answer passes a smoke gate. */
export function resolveProbeError(
  session: Pick<ChatSession, 'lastTurnError' | 'lastTurnErrorDetail'>,
  configValid: boolean,
  executionError?: string,
): string | undefined {
  const code = session.lastTurnErrorDetail?.code;
  if (session.lastTurnError || code) {
    const serviceError = `${code ? `${code}: ` : ''}${session.lastTurnError ?? 'the service could not complete this turn'}`;
    return executionError && !serviceError.includes(executionError)
      ? `${serviceError}\n${executionError}`
      : serviceError;
  }
  if (executionError) return executionError;
  if (!configValid)
    return 'request budget was not verified; the probe is excluded from model comparison';
  return undefined;
}

/** Attribute only recognized failures; a deadline alone does not diagnose infra. */
export function classifyProbeError(
  session: Pick<ChatSession, 'lastTurnErrorDetail'>,
  configValid: boolean,
  error: string,
  interrupted = false,
): 'operator' | 'infra' | 'model' | 'incomplete' {
  if (interrupted || /operator interrupted/i.test(error)) return 'operator';
  const code = session.lastTurnErrorDetail?.code;
  if (
    code === 'capacity-denied' ||
    code === 'native-engine-crash' ||
    /\b(?:ECONNREFUSED|ECONNRESET|EPIPE|ENOENT|EACCES)\b|on-device engine crashed|capacity broker denied|lost its internal tool connection|\/v1\/chat\/completions (?:unreachable|returned [45]\d\d)|cell log capture failed|fetch failed|context overflow|ran out of working memory/i.test(
      error,
    )
  )
    return 'infra';
  if (/probe exceeded timeout/i.test(error)) return 'incomplete';
  if (!configValid) return 'infra';
  if (
    code === 'turn-aborted' ||
    /too many tool-call loops|post-reasoning runaway|emitted \d+ characters of prose this turn|ramble abort/i.test(
      error,
    )
  )
    return 'model';
  return 'incomplete';
}

/** Completed failures are evidence, so resume must not replace them with retries. */
export function isCompletedProbeResult(result: Record<string, unknown>): boolean {
  return (
    result.configValid === true &&
    result.includedInModelAggregate === true &&
    typeof result.passed === 'boolean' &&
    (result.failureClass === 'pass' || result.failureClass === 'model')
  );
}

// Keep mutable install metadata private; immutable weights can share disk blocks.
async function stageModel(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await stageModel(from, to);
    else if (entry.isFile()) {
      if (entry.name.endsWith('.gguf')) await link(from, to).catch(() => copyFile(from, to));
      else await copyFile(from, to);
    }
  }
}

async function waitForTurn(
  client: GezelClient,
  sessionId: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<void> {
  const budget = new AwakeBudget(timeoutMs);
  // sendToChatSession awaits acceptance; inflight is registered before it returns.
  while (!budget.expired() && !signal.aborted) {
    const state = await client.getChatSessionInflight(sessionId);
    if (!state.inflight) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  await client.cancelChatSessionTurn(sessionId);
  throw new Error(
    signal.aborted
      ? 'operator interrupted'
      : `probe exceeded timeout; excluded from capability interpretation${budget.describeSuspension()}`,
  );
}

function containsExpectedAnswerElement(content: string, expected: string): boolean {
  const fraction = /^(\d+)\/(\d+)$/.exec(expected);
  if (fraction) {
    const normalized = content.replace(
      /\\(?:frac|dfrac|tfrac)\s*\{\s*([+-]?\d+)\s*\}\s*\{\s*([+-]?\d+)\s*\}/g,
      '$1/$2',
    );
    return [...normalized.matchAll(/(?<![\w./])([+-]?\d+)\s*\/\s*([+-]?\d+)(?![\w/]|\.\d)/g)].some(
      (match) => {
        const numerator = BigInt(match[1]!);
        const denominator = BigInt(match[2]!);
        return (
          denominator !== 0n &&
          numerator * BigInt(fraction[2]!) === denominator * BigInt(fraction[1]!)
        );
      },
    );
  }
  if (/^[+-]?\d+$/.test(expected))
    return [...content.matchAll(/(?<![\w.])[+-]?\d+(?:\.\d+)?(?!\w|\.\d)/g)].some(
      (match) => Number(match[0]) === Number(expected),
    );
  return content.toLowerCase().includes(expected.toLowerCase());
}

/** Mechanical checks supplement manual review of correctness and reasoning leakage. */
export async function checkProbe(
  probe: ThinkingProbe,
  workspace: string,
  output: ReturnType<typeof inspectThinkingOutput>,
) {
  const failures: string[] = [];
  if (!output.content.trim()) failures.push('no visible answer');
  for (const expected of probe.expected ?? [])
    if (!containsExpectedAnswerElement(output.content, expected))
      failures.push(`missing expected answer element: ${expected}`);
  if (
    probe.id === 'grounded-summary' &&
    !/\b(?:unconfirmed|uncertain(?:ty)?|unknown|undetermined|unresolved|not\s+(?:(?:yet|fully|conclusively)\s+)?(?:confirmed|established|determined))\b/i.test(
      output.content,
    )
  )
    failures.push('summary omits uncertainty about the cause');
  if (
    probe.id === 'logic-order' &&
    !/\bD\b[^A-Z]{0,20}\bA\b[^A-Z]{0,20}\bC\b[^A-Z]{0,20}\bB\b/.test(output.content)
  )
    failures.push('missing ordered solution D, A, C, B');
  if (probe.id === 'constraint-writing' && output.content.trim().split(/\s+/).length > 70)
    failures.push('email exceeds 70-word limit');
  if (!probe.check && !probe.allowTools && output.toolCalls)
    failures.push('called tools despite no-tools request');
  if (probe.check === 'tool-write') {
    if ((await readFile(join(workspace, 'receipt.txt'), 'utf8').catch(() => '')).trim() !== 'READY')
      failures.push('receipt.txt missing or incorrect');
    if (!output.toolCalls) failures.push('no recorded tool call');
  }
  if (probe.check === 'code-repair') {
    try {
      const source = await readFile(join(workspace, 'sums.js'), 'utf8');
      const result = runInNewContext(
        `${source}\nJSON.stringify([rangeSum(1,4),rangeSum(4,4),rangeSum(5,3),rangeSum(-2,2)])`,
        {},
        { timeout: 1000 },
      );
      if (result !== '[10,4,0,0]') failures.push(`rangeSum incorrect: ${String(result)}`);
    } catch (error) {
      failures.push(`code validation failed: ${String(error)}`);
    }
  }
  return { passed: failures.length === 0, failures };
}

async function main(): Promise<void> {
  const { flags } = parseArgs(process.argv.slice(2));
  assertKnownFlags(flags, [
    'model',
    'budgets',
    'count',
    'seed-start',
    'timeout',
    'max-tokens',
    'runs-dir',
    'cache-root',
    'llama-bin',
    'daemon-entry',
    'probes',
    'conversation-file',
    'dry-run',
    'resume',
  ]);
  const value = (key: string, fallback: string) => {
    if (typeof flags[key] === 'boolean') throw new Error(`--${key} requires a value`);
    return typeof flags[key] === 'string' ? flags[key] : fallback;
  };
  const model = value('model', 'gemma4-31b-q4');
  const budgets = value('budgets', '96,512,2048,4096').split(',').map(Number);
  const count = Number(value('count', '1'));
  const maxTokens = Number(value('max-tokens', '16384'));
  const timeoutMs = parseDuration(value('timeout', '15m'));
  const root = resolve(
    value(
      'runs-dir',
      join(
        'evals',
        'runs',
        `thinking-budget-${model}-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      ),
    ),
  );
  let probes = [...THINKING_PROBES];
  if (flags['conversation-file']) {
    const fixture = JSON.parse(
      await readFile(value('conversation-file', ''), 'utf8'),
    ) as ThinkingProbe;
    if (!fixture.id || typeof fixture.prompt !== 'string' || !/^[a-z0-9_-]+$/i.test(fixture.id))
      throw new Error('conversation fixture requires a safe id and string prompt');
    if (
      fixture.history?.some(
        (m) => !['user', 'assistant'].includes(m.role) || typeof m.content !== 'string',
      )
    )
      throw new Error('invalid conversation history');
    probes.push(fixture);
  }
  if (flags.probes) {
    const selected = value('probes', '').split(',');
    if (selected.some((id) => !probes.some((p) => p.id === id)))
      throw new Error('unknown probe id');
    probes = selected.map((id) => probes.find((p) => p.id === id)!);
  }
  const plan = buildBudgetPlan(probes, budgets, count, Number(value('seed-start', '0')));
  if (flags['dry-run']) {
    console.log(JSON.stringify({ model, root, maxTokens, timeoutMs, plan }, null, 2));
    return;
  }
  if (process.env.GEZEL_LLAMA_REASONING_BUDGET_TOKENS)
    throw new Error(
      'Unset GEZEL_LLAMA_REASONING_BUDGET_TOKENS: it would collapse per-request arms',
    );
  if (!Number.isSafeInteger(maxTokens) || maxTokens < Math.max(...budgets) + 1024)
    throw new Error(
      'max-tokens must leave at least 1024 output tokens above every reasoning budget',
    );
  const binary = resolveLlamaBinary(flags['llama-bin'] ? value('llama-bin', '') : undefined);
  const daemonArtifact = thinkingDaemonArtifact(
    flags['daemon-entry'] ? value('daemon-entry', '') : undefined,
  );
  const { daemonEntry } = daemonArtifact;
  const provenance = {
    experiment: experimentProvenance(await readFile(fileURLToPath(import.meta.url))),
    model,
    maxTokens,
    timeoutMs,
    binary,
    daemonEntry,
    daemonStat: { size: daemonArtifact.size, mtimeMs: daemonArtifact.mtimeMs },
    probes,
    plan,
  };
  const existingPlan = await readFile(join(root, 'plan.json'), 'utf8').catch(() => null);
  if (
    existingPlan &&
    (!flags.resume || JSON.stringify(JSON.parse(existingPlan)) !== JSON.stringify(provenance))
  )
    throw new Error(
      'run directory exists: use --resume with the identical model, runtime and plan',
    );
  const results = existingPlan
    ? (JSON.parse(await readFile(join(root, 'results.json'), 'utf8').catch(() => '[]')) as Record<
        string,
        unknown
      >[])
    : [];
  const lease = acquireEvalDeviceLock();
  const signal = installEvalSignalHandlers('thinking-budget probe');
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(join(tmpdir(), 'gezel-thinking-budget-'));
  let spawned: Awaited<ReturnType<typeof spawnTrialDaemon>> | undefined;
  try {
    await stageModel(
      join(
        resolve(value('cache-root', defaultCacheRoot())),
        'engines',
        'llama-cpp',
        'models',
        model,
      ),
      join(home, 'engines', 'llama-cpp', 'models', model),
    );
    await writeFile(join(root, 'plan.json'), JSON.stringify(provenance, null, 2));
    await writeFile(
      join(root, 'runtime.json'),
      JSON.stringify({ home, startedAt: new Date().toISOString() }, null, 2),
    );
    spawned = await spawnTrialDaemon({
      home,
      llamaBin: binary.path,
      daemonEntry,
      stderrLogPath: join(root, 'daemon.log'),
      timeoutMs: 300_000,
      extraEnv: {
        ...evalDaemonEnvForTrial({ disableBackgroundEnrich: true, providerLock: 'llama-cpp' }),
        LLAMA_ARG_LOG_VERBOSITY: '4',
      },
    });
    const client = spawned.client;
    const recorder = startChatEventRecorder({ client, runDir: root, log: console.log });
    try {
      await client.updateConfig({
        provider: 'llama-cpp',
        defaultModel: { 'llama-cpp': model },
        firstRunCompleted: true,
        autoRecall: { enabled: false },
        ...localEvalDeviceSafetyConfig('llama-cpp'),
        ...provenance.experiment.engineOverrides,
        providerConcurrency: { 'llama-cpp': 1 },
        securityPolicy: {
          level: 'free',
          allowFileEdits: true,
          allowScriptExecution: true,
          allowExternalChat: false,
          allowExternalServices: false,
          allowAppNetwork: false,
        },
      });
      const store = new Store({ home });
      const defaultAbout =
        'You are a helpful assistant. Complete the user request carefully and concisely. Use tools when the user requests a file change. For questions, answer directly in the conversation.';
      const gezel = await client.createGezel({
        name: 'Robin',
        role: 'Assistant',
        model,
        about: defaultAbout,
      });
      const projects = new Map<string, { id: string; workspace: string }>();
      // Prepare a stable crew/project roster before the first measured turn.
      // New per-arm identities would otherwise change the prompt with the cap.
      for (const probe of probes) {
        const workspace = join(root, 'workspaces', probe.id);
        await mkdir(workspace, { recursive: true });
        const project = await client.createProject({
          name: 'Chat',
          workingDir: workspace,
        });
        // External folders default to read-only; these are owned eval workspaces.
        const writableProject = await client.updateProject(project.id, {
          managedWorkspaceWritePolicy: 'allow',
        });
        if (writableProject.managedWorkspaceWritePolicy !== 'allow')
          throw new Error(`probe workspace write authority was not granted for ${probe.id}`);
        projects.set(probe.id, { id: project.id, workspace });
      }
      for (const cell of plan) {
        if (signal.signal.aborted) break;
        if (results.some((r) => r.id === cell.id && isCompletedProbeResult(r))) {
          console.log(`[thinking-budget] SKIP completed ${cell.id}`);
          continue;
        }
        const probe = probes.find((p) => p.id === cell.probeId)!;
        const project = projects.get(cell.probeId)!;
        const cellDir = join(root, cell.id);
        const workspace = project.workspace;
        await mkdir(cellDir, { recursive: true });
        await resetProbeWorkspace(root, workspace);
        await resetProbeArtifacts(home, project.id);
        for (const [name, contents] of Object.entries(probe.fixture ?? {}))
          await writeFile(join(workspace, name), contents);
        await client.updateGezelAbout(gezel.id, { source: probe.about ?? defaultAbout });
        await client.updateGezelSettings(gezel.id, {
          provider: 'llama-cpp',
          autoRecall: false,
          tuning: {
            sampling: { seed: cell.seed, maxTokens },
            reasoning: { enableThinking: true, thinkingBudget: cell.budget },
          },
        });
        const session = await client.createChatSession({
          gezelId: gezel.id,
          projectId: project.id,
        });
        if (probe.history?.length)
          await store.writeSession({
            ...session,
            messages: probe.history.map((m, i) => ({
              role: m.role,
              content: m.content,
              at: new Date(Date.now() - (probe.history!.length - i) * 1000).toISOString(),
            })),
          });
        // Capture this turn directly. The cumulative daemon log compacts after
        // 32MiB, so byte offsets cannot delimit a long campaign's cells.
        const cellLogPath = join(cellDir, 'daemon.log');
        const cellLog = createWriteStream(cellLogPath);
        let cellLogError: unknown;
        const cellLogFinished = finished(cellLog).catch((e) => {
          cellLogError = e;
        });
        const streams = [spawned.child?.stdout, spawned.child?.stderr].filter(
          (stream): stream is NonNullable<typeof stream> => stream != null,
        );
        for (const stream of streams) stream.pipe(cellLog, { end: false });
        const started = awakeNow();
        let error: string | undefined;
        console.log(`[thinking-budget] START ${cell.id} session=${session.id}`);
        try {
          await client.sendToChatSession(session.id, { message: probe.prompt });
          await waitForTurn(client, session.id, timeoutMs, signal.signal);
        } catch (e) {
          error = String(e);
        } finally {
          for (const stream of streams) stream.unpipe(cellLog);
          cellLog.end();
          await cellLogFinished;
          if (cellLogError) error = `cell log capture failed: ${String(cellLogError)}`;
        }
        const saved: ChatSession = await client.getChatSession(session.id);
        const output = inspectThinkingOutput(saved.messages.slice(probe.history?.length ?? 0));
        const log = await readFile(cellLogPath, 'utf8');
        const diagnostics = parseBudgetDiagnostics(log);
        const budgetCheck = checkBudgetDiagnostics(diagnostics, cell.budget);
        const { configValid } = budgetCheck;
        error = resolveProbeError(saved, configValid, error);
        const errorClass = error
          ? classifyProbeError(saved, configValid, error, signal.signal.aborted)
          : undefined;
        const includedInModelAggregate = !error || errorClass === 'model';
        const check = error
          ? {
              passed: includedInModelAggregate ? false : null,
              failures: includedInModelAggregate ? [error] : [],
            }
          : await checkProbe(probe, workspace, output);
        const failureClass = errorClass ?? (check.passed ? 'pass' : 'model');
        const result = {
          ...cell,
          sessionId: session.id,
          durationMs: awakeNow() - started,
          ...budgetCheck,
          ...check,
          error,
          failureClass,
          includedInModelAggregate,
          ...(saved.lastTurnError ? { lastTurnError: saved.lastTurnError } : {}),
          ...(saved.lastTurnErrorDetail ? { lastTurnErrorDetail: saved.lastTurnErrorDetail } : {}),
          diagnostics,
          output,
        };
        await writeFile(join(cellDir, 'session.json'), JSON.stringify(saved, null, 2));
        await writeFile(
          join(cellDir, 'debug.json'),
          JSON.stringify(await client.getChatSessionDebug(session.id), null, 2),
        );
        for (const name of probe.check === 'tool-write'
          ? ['receipt.txt']
          : Object.keys(probe.fixture ?? {}))
          await copyFile(join(workspace, name), join(cellDir, name)).catch(() => {});
        await writeFile(join(cellDir, 'result.json'), JSON.stringify(result, null, 2));
        const prior = results.findIndex((r) => r.id === cell.id);
        if (prior >= 0) results[prior] = result;
        else results.push(result);
        await writeFile(join(root, 'results.json'), JSON.stringify(results, null, 2));
        console.log(
          `[thinking-budget] END ${cell.id} pass=${check.passed} config=${configValid} reasoningChars=${output.reasoning.length} visibleChars=${output.content.length} forced=${diagnostics.forcedEndCount} flags=${output.flags.join(',')} error=${error ?? ''}`,
        );
        if (error && failureClass !== 'model') throw new Error(error);
      }
    } finally {
      await recorder.stop();
    }
  } finally {
    try {
      if (spawned) await shutdownTrialDaemon(spawned);
    } finally {
      lease.release();
      // Only the owned, generated temporary home is removed; evidence stays.
      const tempRoot = resolve(tmpdir()) + sep;
      if (
        resolve(home).startsWith(tempRoot) &&
        resolve(home).slice(tempRoot.length).startsWith('gezel-thinking-budget-')
      )
        await rm(home, { recursive: true, force: true });
    }
  }
  console.log(`[thinking-budget] ${results.length}/${plan.length} cells saved to ${root}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
