/**
 * `pnpm --filter @bendyline/gezel-evals run factuality -- --home <dir> --gezel <id> [flags]`
 *
 * How often does a gezel state something false when a person asks it to
 * write about real people? Drives a daemon you started yourself: each
 * question goes to a fresh chat session with the named gezel, the final
 * reply is graded claim by claim against a fixed answer key, and the run is
 * written as JSONL plus a markdown table a person can audit.
 *
 * The judge sees only the key, never the gezel's evidence, so "contradicted"
 * means wrong in the world rather than unsupported by what the gezel read.
 * The judge is a model too; read the claims table before trusting a delta.
 *
 * Flags:
 *   --home <dir>            the running daemon's GEZEL_HOME (runtime/ gives port, token, cert)
 *   --gezel <id>            the gezel under test (repeat the run per arm)
 *   --project <id>          project to chat in (default `default`)
 *   --label <name>          arm label for the report (default: the gezel id)
 *   --only <id,id>          run a subset of the questions
 *   --judge-gezel <id>      grade with this gezel's model (default: the gezel under test)
 *   --judge-provider <p>    grade with this provider instead
 *   --judge-model <m>       and this model
 *   --turn-timeout <s>      give up on a reply after this many seconds (default 900)
 *   --runs-dir <path>       override the output folder
 */
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ChatMessage, ProviderName } from '@bendyline/gezel';
import { GezelClient, createTrustingFetch, readRuntime } from '@bendyline/gezel-client/node';
import {
  JUDGE_SCHEMA,
  JUDGE_SYSTEM,
  type Judgement,
  type ReplyScore,
  judgePrompt,
  scoreJudgement,
  summarize,
} from '../factuality/judge.ts';
import { REFERENCE, WASHINGTON_PROMPTS } from '../factuality/washington.ts';
import { repoRoot } from '../native-bin.ts';
import { parseArgs } from './args.ts';

async function connect(home: string): Promise<GezelClient> {
  const runtime = await readRuntime(home);
  if (!runtime) throw new Error(`no running daemon found under ${home}/runtime`);
  return new GezelClient({
    baseUrl: runtime.baseUrl,
    token: runtime.token,
    ...(runtime.cert ? { fetch: createTrustingFetch({ cert: runtime.cert }) } : {}),
  });
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Send one question and wait for the turn to finish; returns the final assistant message. */
async function ask(
  client: GezelClient,
  input: { gezelId: string; projectId: string; prompt: string; timeoutMs: number },
): Promise<{ sessionId: string; replies: ChatMessage[]; elapsedMs: number }> {
  const started = Date.now();
  const session = await client.createChatSession({
    gezelId: input.gezelId,
    projectId: input.projectId,
  });
  await client.sendToChatSession(session.id, input.prompt);
  await pause(3_000);
  while (Date.now() - started < input.timeoutMs) {
    const { inflight } = await client.getChatSessionInflight(session.id);
    if (!inflight) {
      const full = await client.getChatSession(session.id);
      const last = full.messages.at(-1);
      if (last?.role === 'assistant' && last.status !== 'streaming') {
        // A turn can commit several assistant messages (continuations); the
        // answer is all of them.
        const asked = full.messages.map((m) => m.role).lastIndexOf('user');
        const replies = full.messages.slice(asked + 1).filter((m) => m.role === 'assistant');
        return { sessionId: session.id, replies, elapsedMs: Date.now() - started };
      }
    }
    await pause(5_000);
  }
  await client.cancelChatSessionTurn(session.id).catch(() => undefined);
  return { sessionId: session.id, replies: [], elapsedMs: Date.now() - started };
}

const PROSE_PATH = /\.(?:md|markdown|mdx|txt|text|rst|adoc)$/i;

/**
 * One field of a tool call's `argsFull`: long values are "key:\nvalue",
 * short ones "key: value", fields separated by a blank line.
 */
function argField(argsFull: string | undefined, key: string): string | undefined {
  if (!argsFull) return undefined;
  const fields = argsFull.split(/\n\n(?=[A-Za-z_]+:[ \n])/);
  const hit = fields.find((f) => f.startsWith(`${key}:\n`) || f.startsWith(`${key}: `));
  return hit?.slice(key.length + 2);
}

/**
 * Prose the gezel put somewhere other than its reply: a saved .md/.txt file
 * or text inserted into the open document. A writer asked for "a paragraph"
 * often saves it and replies with one line, and the paragraph is the answer.
 */
function writtenProse(replies: readonly ChatMessage[]): string[] {
  const out: string[] = [];
  for (const call of replies.flatMap((m) => m.toolCalls ?? [])) {
    if (!call.success) continue;
    if (['write_file', 'write_artifact', 'write_document'].includes(call.name)) {
      const path = argField(call.argsFull, 'path') ?? call.path;
      const content = argField(call.argsFull, 'content');
      if (path && PROSE_PATH.test(path) && content?.trim())
        out.push(`[Saved to ${path}]\n${content}`);
    } else if (['doc_insert_text', 'doc_replace_selection'].includes(call.name)) {
      const text = argField(call.argsFull, 'text');
      if (text?.trim()) out.push(`[Inserted into the document]\n${text}`);
    }
  }
  return out;
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const home = typeof flags.home === 'string' ? flags.home : undefined;
  const gezelId = typeof flags.gezel === 'string' ? flags.gezel : undefined;
  if (!home || !gezelId) throw new Error('--home <dir> and --gezel <id> are required');
  const projectId = typeof flags.project === 'string' ? flags.project : 'default';
  const label = typeof flags.label === 'string' ? flags.label : gezelId;
  const only = typeof flags.only === 'string' ? new Set(flags.only.split(',')) : null;
  const timeoutMs = (Number(flags['turn-timeout']) || 900) * 1000;
  const judgeTarget = {
    gezelId: typeof flags['judge-gezel'] === 'string' ? flags['judge-gezel'] : gezelId,
    ...(typeof flags['judge-provider'] === 'string'
      ? { provider: flags['judge-provider'] as ProviderName }
      : {}),
    ...(typeof flags['judge-model'] === 'string' ? { model: flags['judge-model'] } : {}),
  };

  const client = await connect(home);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir =
    typeof flags['runs-dir'] === 'string'
      ? flags['runs-dir']
      : join(
          repoRoot(),
          'evals',
          'runs',
          'factuality',
          `${stamp}-${label.replace(/[^\w-]+/g, '_')}`,
        );
  await mkdir(outDir, { recursive: true });
  const jsonl = join(outDir, 'replies.jsonl');

  const prompts = WASHINGTON_PROMPTS.filter((p) => !only || only.has(p.id));
  const rows: Array<{
    id: string;
    score: ReplyScore | null;
    judgement: Judgement | null;
    reply: string;
    elapsedMs: number;
    tools: string[];
    grounding?: unknown;
  }> = [];
  for (const item of prompts) {
    process.stdout.write(`${item.id} … `);
    const { sessionId, replies, elapsedMs } = await ask(client, {
      gezelId,
      projectId,
      prompt: item.prompt,
      timeoutMs,
    });
    const text = [...replies.map((m) => m.content), ...writtenProse(replies)]
      .filter((part) => part.trim())
      .join('\n\n');
    const tools = replies
      .flatMap((m) => m.toolCalls ?? [])
      .map((t) => `${t.name}${t.success ? '' : ' ✗'}`);
    let judgement: Judgement | null = null;
    if (text.trim()) {
      const graded = await client.completeInProject(projectId, {
        ...judgeTarget,
        system: JUDGE_SYSTEM,
        prompt: judgePrompt({
          reference: REFERENCE,
          question: item.prompt,
          answer: text,
          expects: item.expects,
        }),
        jsonSchema: JUDGE_SCHEMA as unknown as Record<string, unknown>,
        temperature: 0,
        thinking: false,
        label: `factuality judge · ${item.id}`,
      });
      judgement = (graded.json as Judgement | undefined) ?? null;
    }
    const score = judgement ? scoreJudgement(judgement) : null;
    const grounding = [...replies].reverse().find((m) => m.grounding)?.grounding;
    rows.push({
      id: item.id,
      score,
      judgement,
      reply: text,
      elapsedMs,
      tools,
      ...(grounding ? { grounding } : {}),
    });
    await appendFile(
      jsonl,
      `${JSON.stringify({ id: item.id, sessionId, prompt: item.prompt, reply: text, tools, elapsedMs, judgement, score, grounding })}\n`,
    );
    console.log(
      score
        ? `${score.contradicted} wrong / ${score.claims} claims, ${score.unverified} unverified, ${(elapsedMs / 1000).toFixed(0)}s`
        : 'no reply',
    );
  }

  const scored = rows.flatMap((r) => (r.score ? [r.score] : []));
  const total = summarize(scored);
  const lines = [
    `# Factuality — ${label}`,
    '',
    `Gezel \`${gezelId}\` in project \`${projectId}\`, ${new Date().toISOString()}. Judge: ${JSON.stringify(judgeTarget)}.`,
    '',
    `- Replies graded: ${total.replies} of ${prompts.length}`,
    `- Claims: ${total.claims}; contradicted ${total.contradicted} (${(total.errorRate * 100).toFixed(1)}%), unverified ${(total.unverifiedRate * 100).toFixed(1)}%`,
    `- Replies with at least one error: ${total.repliesWithError}`,
    `- Expected facts stated correctly: ${(total.coverage * 100).toFixed(1)}%`,
    `- Declined / could not verify: ${total.declined}`,
    '',
    '| Question | Claims | Wrong | Unverified | Expected | Tools | Seconds |',
    '|---|---|---|---|---|---|---|',
    ...rows.map((r) =>
      r.score
        ? `| ${r.id} | ${r.score.claims} | ${r.score.contradicted} | ${r.score.unverified} | ${r.score.expectedStated}/${r.score.expectedTotal} | ${r.tools.join(', ') || '—'} | ${(r.elapsedMs / 1000).toFixed(0)} |`
        : `| ${r.id} | — | — | — | — | ${r.tools.join(', ') || '—'} | ${(r.elapsedMs / 1000).toFixed(0)} |`,
    ),
    '',
    '## Contradicted claims',
    '',
    ...rows.flatMap((r) =>
      (r.judgement?.claims ?? [])
        .filter((c) => c.verdict === 'contradicted')
        .map((c) => `- **${r.id}**: ${c.claim} — ${c.note}`),
    ),
  ];
  await writeFile(join(outDir, 'report.md'), `${lines.join('\n')}\n`);
  console.log(`\n${lines.slice(4, 9).join('\n')}\n\nwrote ${outDir}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
