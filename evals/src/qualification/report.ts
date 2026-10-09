import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Intervention } from './boundary.ts';
import type { LifecycleObservation } from './lifecycle.ts';

interface ApiRecord {
  phase: 'request' | 'result';
  requestId: string;
  provider: string;
  model: string;
  sessionId?: string;
  round?: number;
  outcome?: string;
  usage?: Record<string, number | null>;
  [key: string]: unknown;
}
export interface QualificationReport {
  version: 1;
  passed: boolean;
  artifactSuccess: boolean;
  independence: 'observed' | 'mixed' | 'unobservable' | 'assisted';
  issues: string[];
  lifecycle: LifecycleObservation | null;
  interventions: { delivered: number; blocked: number; unanswered: number; productRuntime: number };
  toolFailures: number;
  taskModes: Array<{ ref: string; executionMode: string | null }>;
  api: {
    toolRounds: number;
    requests: number;
    results: number;
    failures: number;
    incomplete: number;
    sdkRetries: null;
    usage: Record<string, number | null>;
  };
  /** Provenance covers provider requests and recorded tool execution, not an OS process audit. */
  commandAudit: 'recorded-tool-calls';
}

function records<T>(text: string, marker = ''): T[] {
  return text.split('\n').flatMap((line) => {
    const index = marker ? line.indexOf(marker) : 0;
    if (index < 0) return [];
    try {
      return [JSON.parse(line.slice(index + marker.length)) as T];
    } catch {
      return [];
    }
  });
}

export async function writeQualificationReport(
  runDir: string,
  artifactSuccess: boolean,
): Promise<QualificationReport | undefined> {
  const read = (name: string) => readFile(join(runDir, name), 'utf8').catch(() => '');
  const metadataText = await read('measurement.json');
  if (!metadataText) return undefined;
  const issues: string[] = [];
  const parse = <T>(text: string, name: string): T | null => {
    try {
      return JSON.parse(text) as T;
    } catch {
      issues.push(`unreadable measurement evidence: ${name}`);
      return null;
    }
  };
  const metadata = parse<{
    unavailable?: string[];
    treatment?: {
      provider: string;
      model: string;
      repairPolicy: string;
      qualification?: { userSimulation: string };
    };
  }>(metadataText, 'measurement.json');
  const log = await read('daemon.log');
  const api = records<ApiRecord>(log, 'measurement.api ');
  const runtime = records<{ source: string; promptHash: string }>(log, 'measurement.intervention ');
  const interventions = records<Intervention>(await read('interventions.jsonl'));
  const requests = api.filter((r) => r.phase === 'request');
  const results = api.filter((r) => r.phase === 'result');
  if (metadata?.unavailable?.length)
    issues.push(`missing measurement identity: ${metadata.unavailable.join(', ')}`);
  if (log.includes('middle daemon output omitted'))
    issues.push('API request provenance may be truncated');
  const expected = metadata?.treatment;
  if (!expected) issues.push('missing measurement identity: treatment');
  const mixedRequests = requests.filter(
    (r) => r.provider !== expected?.provider || r.model !== expected?.model,
  );
  const blockedProviders = records(log, 'measurement.provenance ');
  let mixed = mixedRequests.length > 0 || blockedProviders.length > 0;
  if (blockedProviders.length) issues.push('a different provider was requested and blocked');
  let uncovered = 0;
  let toolFailures = 0;
  let activeSessions = 0;
  const files = await readdir(join(runDir, 'sessions')).catch(() => [] as string[]);
  for (const file of files.filter((name) => name.endsWith('.json'))) {
    const session = parse<{
      id: string;
      providerName?: string;
      messages?: Array<{
        role: string;
        toolCalls?: Array<{
          name: string;
          argsFull?: string;
          argsSummary?: string;
          success?: boolean;
        }>;
      }>;
    }>(await read(`sessions/${file}`), file);
    if (!session) {
      uncovered++;
      continue;
    }
    if (!session.messages?.some((m: { role: string }) => m.role === 'assistant')) continue;
    activeSessions++;
    if (session.providerName !== expected?.provider) mixed = true;
    if (!requests.some((r) => r.sessionId === session.id)) uncovered++;
    for (const message of session.messages ?? []) {
      for (const call of message.toolCalls ?? []) {
        if (call.success === false) toolFailures++;
        if (
          /(?:^|__)(?:shell|run_command|run_terminal_command|run_shell_command|exec_command|run_script|run_installed_script|run_nodejs_script|run_python_script|run_npx)$/.test(
            call.name,
          ) &&
          /(?:^|[\s/;|"'\[(])(?:codex|claude)(?:[\s"'\],)]|$)/i.test(
            call.argsFull ?? call.argsSummary ?? '',
          )
        ) {
          mixed = true;
          issues.push(`CLI harness referenced by recorded execution in session ${session.id}`);
        }
      }
    }
  }
  if (mixed)
    issues.push('provider/model or CLI harness provenance differs from the requested API arm');
  if (requests.length === 0 || uncovered > 0 || activeSessions === 0)
    issues.push('API request provenance is incomplete');
  const blocked = interventions.filter((e) => e.status === 'blocked').length;
  const delivered = interventions.filter(
    (e) => e.status === 'delivered' && e.source === 'evaluator',
  ).length;
  const unanswered = interventions.filter((e) => e.status === 'unanswered').length;
  if (blocked) issues.push('undeclared evaluator mutation was blocked');
  if (interventions.some((e) => e.reason === 'observation-failed'))
    issues.push('user simulation observation was incomplete');
  if (unanswered) issues.push('user assistance was requested without a matching script');
  const assisted =
    expected?.repairPolicy === 'harness' ||
    delivered > 0 ||
    expected?.qualification?.userSimulation === 'heuristic';
  if (assisted) issues.push('assisted diagnostic; not independent product qualification');
  const lifecycleText = await read('lifecycle.json');
  const lifecycle = lifecycleText
    ? parse<LifecycleObservation>(lifecycleText, 'lifecycle.json')
    : null;
  if (lifecycle?.status !== 'complete')
    issues.push('artifact/turn/task lifecycle did not complete observably');
  const terminalIds = new Set(results.map((r) => r.requestId));
  const incomplete =
    requests.filter((r) => !terminalIds.has(r.requestId)).length +
    results.filter((r) => r.outcome === 'incomplete').length;
  if (incomplete) issues.push('API request observation ended before a terminal result');
  const usage: Record<string, number | null> = {};
  for (const key of [
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
    'cacheWriteTokens',
    'reasoningTokens',
  ]) {
    usage[key] =
      results.length && results.every((r) => typeof r.usage?.[key] === 'number')
        ? results.reduce((sum, r) => sum + (r.usage?.[key] ?? 0), 0)
        : null;
  }
  const incoming = interventions.filter((e) => e.status === 'delivered' && e.promptHash);
  const labeledRuntime = runtime.map((e) => {
    const matched = incoming.find((i) => i.promptHash === e.promptHash);
    return matched ? { ...e, source: matched.source, reason: matched.reason } : e;
  });
  const tasksText = await read('tasks.json');
  const tasks = tasksText
    ? parse<{ tasks?: Array<{ ref: string; executionMode?: string }> }>(tasksText, 'tasks.json')
    : null;
  const taskModes = (tasks?.tasks ?? []).map((t) => ({
    ref: t.ref,
    executionMode: t.executionMode ?? null,
  }));
  const report: QualificationReport = {
    version: 1,
    passed: artifactSuccess && issues.length === 0,
    artifactSuccess,
    independence: mixed
      ? 'mixed'
      : requests.length === 0 || uncovered > 0 || activeSessions === 0
        ? 'unobservable'
        : assisted
          ? 'assisted'
          : 'observed',
    issues,
    lifecycle,
    toolFailures,
    taskModes,
    interventions: {
      delivered,
      blocked,
      unanswered,
      productRuntime: labeledRuntime.filter((e) => e.source === 'product-runtime').length,
    },
    api: {
      toolRounds: results.filter((r) => typeof r.toolCalls === 'number' && r.toolCalls > 0).length,
      requests: requests.length,
      results: results.length,
      failures: results.filter((r) => r.outcome === 'failed').length,
      incomplete,
      sdkRetries: null,
      usage,
    },
    commandAudit: 'recorded-tool-calls',
  };
  await writeFile(join(runDir, 'api-requests.json'), JSON.stringify(api, null, 2));
  await writeFile(
    join(runDir, 'runtime-interventions.json'),
    JSON.stringify(labeledRuntime, null, 2),
  );
  await writeFile(join(runDir, 'qualification.json'), JSON.stringify(report, null, 2));
  return report;
}
