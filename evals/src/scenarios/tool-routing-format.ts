/**
 * Routing probes for the two decisions a Meester makes on the user's FIRST
 * message — the half of the workflow the craftbook rail never exercises.
 *
 * `mode: 'workflow'` specs set `skipInitialPrompt` and create the task
 * directly with `createTask({ craftbookId, dispatchEntry: true })`, so the
 * crew starts at step 1 of an already-routed task. 286 of 287 craftbook specs
 * do this. That models execution faithfully and models INVOCATION not at all —
 * and invocation is where every wild failure has happened:
 *
 *   - "Can you create a PowerPoint about France"  — meester looped on
 *     `ensure_gezel` and never called `invoke_craftbook`
 *   - "…about Valencia"                            — same route, stalled later
 *   - "…about Alaska"                              — meester read DocBlocks'
 *     `describe_template` as the craftbook lookup, got "Unknown template",
 *     and hand-built the deck
 *
 * The Alaska case is the reason `docblocks` is installed below. The
 * `exact-craftbook-invocation` clamp reduces the BUILTIN allowlist to
 * `invoke_craftbook` alone, but third-party toolset servers are wired on a
 * separate path — so a project with a document toolset installed hands the
 * router one builtin plus a pile of document tools and no craftbook lookup.
 * Without a toolset installed the clamp leaves exactly one tool and the model
 * cannot go wrong, so a probe that omits it cannot reproduce the bug.
 *
 * Both probes are fast-fail by design, like the rest of the `tool-routing-*`
 * family: they measure the HANDOFF, not the deliverable, and end as soon as
 * the routing decision is observable.
 */

import type { GezelClient } from '@bendyline/gezel-client/node';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';

/** Books that satisfy a "make me a real .pptx" ask. */
const DECK_BOOK_RE = /\b(?:powerpoint-deck|content-deck|narrated-slideshow)\b/;

async function craftbookTasks(
  client: GezelClient,
): Promise<Array<{ taskRef: string; catalogIds: string[] }>> {
  try {
    const res = await client.listTasks();
    return (res.tasks ?? [])
      .map((t) => ({
        taskRef: t.ref,
        catalogIds: (t.sourceCraftbookIds ?? []).map((s) => s.catalogId).filter(Boolean),
      }))
      .filter((t) => t.catalogIds.length > 0);
  } catch {
    return [];
  }
}

/**
 * Sessions belonging to someone OTHER than the meester, that have actually
 * been spoken to.
 *
 * Two details are load-bearing, and this probe's first run got both wrong:
 * the meester's gezel id is RANDOM per trial (`malika`, `wren`, `bastien` —
 * only spec-pinned workers keep a stable name), so it must be read from
 * config rather than assumed to be `"meester"`; and a session must carry at
 * least one message to count, because a created-but-unaddressed session is
 * not a handoff. Without both, the probe passed in 6 seconds by counting the
 * meester's own empty session — rewarding the router for existing.
 */
async function delegatedSessionCount(client: GezelClient): Promise<number> {
  try {
    const config = await client.getConfig();
    const meesterId = config.meesterGezelId;
    const maybe = client as unknown as {
      listChatSessions?: (filter?: { projectId?: string }) => Promise<{
        sessions: Array<{ gezelId?: string; id: string; messages?: unknown[] }>;
      }>;
      getChatSession?: (sessionId: string) => Promise<{ messages?: unknown[] }>;
    };
    if (typeof maybe.listChatSessions !== 'function') return 0;
    const { sessions } = await maybe.listChatSessions();
    let count = 0;
    for (const listed of sessions ?? []) {
      if (!listed.gezelId || listed.gezelId === meesterId) continue;
      const messages =
        listed.messages ??
        (typeof maybe.getChatSession === 'function'
          ? ((await maybe.getChatSession(listed.id)).messages ?? [])
          : []);
      if (messages.length > 0) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

const PPTX_PROJECT = 'Alaska Deck Request';

export const toolRoutingPptxScenario: EvalScenario = {
  id: 'tool-routing-pptx',
  description:
    "Tests whether the Meester turns a plain 'make me a PowerPoint' message into an " +
    'invoke_craftbook handoff. Reproduces the Alaska failure: a document toolset is ' +
    'installed, so the exact-craftbook clamp leaves the router holding document tools ' +
    'and no craftbook lookup. Fast-fail routing probe — does not build the deck.',
  prompt: 'Can you create a PowerPoint about Alaska?',
  timeoutMs: 12 * 60_000,
  setup: async (ctx: EvalContext): Promise<void> => {
    const { client, log } = ctx;
    const created = await client.createProject({
      name: PPTX_PROJECT,
      about: 'A one-off request for a presentation. No source material is supplied.',
    });
    // The load-bearing half of this fixture — see the module docstring.
    try {
      await client.installToolset('docblocks', {
        sourceId: 'bundled',
        scope: { kind: 'shared' },
      });
      log('[scenario:setup] installed the docblocks toolset (reproduces the Alaska roster)');
    } catch (err) {
      // A probe without it still tests routing, just not the regression.
      log(
        `[scenario:setup] docblocks toolset unavailable (${err instanceof Error ? err.message : String(err)}) — ` +
          'routing is still measured, but the document-tool confusion cannot reproduce',
      );
    }
    log(`[scenario:setup] project ${created.id} ready for the routing probe`);
  },
  successCheck: async ({ client, logChanged, recordSniff }): Promise<SuccessCheckResult> => {
    const tasks = await craftbookTasks(client);
    if (tasks.length === 0) {
      logChanged('sniff', '[scenario] tool-routing-pptx: no craftbook-sourced task yet');
      recordSniff?.({ key: 'tool-routing-pptx', score: 0, bytes: 0 });
      return { done: false };
    }
    const deckTask = tasks.find((t) => t.catalogIds.some((id) => DECK_BOOK_RE.test(id)));
    const hit = deckTask ?? tasks[0]!;
    // Any invoked book proves the handoff; a deck book also proves the CHOICE.
    const signals = ['craftbook-invoked', ...(deckTask ? ['deck-book'] : [])];
    logChanged(
      'sniff',
      `[scenario] tool-routing-pptx: task ${hit.taskRef} from ${hit.catalogIds.join(', ')} (${signals.join(', ')})`,
    );
    recordSniff?.({ key: 'tool-routing-pptx', score: signals.length, bytes: 0 });
    return {
      done: true,
      success: true,
      reason: `routed to craftbook ${hit.catalogIds.join(', ')} as task ${hit.taskRef} (${signals.join(', ')})`,
    };
  },
};

const BUGFIX_PROJECT = 'Checkout Total Bug';

const CART_SOURCE = [
  'export function cartTotal(items) {',
  '  let total = 0;',
  '  for (const item of items) {',
  '    // BUG: quantity is ignored, so 3 x $5 bills as $5.',
  '    total += item.price;',
  '  }',
  '  return total;',
  '}',
  '',
].join('\n');

const CART_TEST = [
  "import { cartTotal } from './cart.js';",
  '',
  'test('.concat("'multiplies price by quantity', () => {"),
  '  expect(cartTotal([{ price: 5, quantity: 3 }])).toBe(15);',
  '});',
  '',
].join('\n');

export const toolRoutingBugfixScenario: EvalScenario = {
  id: 'tool-routing-bugfix',
  description:
    'Tests whether the Meester routes a plain "fix this bug" message to a specialist ' +
    'instead of answering in prose or editing files itself. The implementation branch of ' +
    'the turn-intent plan (route: specialist, requiredTools: message_gezel) has the same ' +
    'zero eval coverage the craftbook branch had. Fast-fail routing probe — does not ' +
    'wait for the fix.',
  prompt:
    'There is a bug in src/cart.js — cartTotal ignores item quantity, so three $5 items ' +
    'bill as $5. Can you get that fixed?',
  timeoutMs: 12 * 60_000,
  setup: async (ctx: EvalContext): Promise<void> => {
    const { client, log } = ctx;
    const created = await client.createProject({
      name: BUGFIX_PROJECT,
      about: 'A small JavaScript cart module with a failing quantity calculation.',
    });
    await client.writeProjectWorkspaceFile(created.id, {
      path: 'src/cart.js',
      content: CART_SOURCE,
    });
    await client.writeProjectWorkspaceFile(created.id, {
      path: 'src/cart.test.js',
      content: CART_TEST,
    });
    log(`[scenario:setup] seeded the buggy cart module under project ${created.id}`);
  },
  successCheck: async (ctx): Promise<SuccessCheckResult> => {
    const { client, logChanged, recordSniff } = ctx;
    // Either handoff shape counts: a craftbook task (bug-fix-tdd and friends)
    // or a plain delegation to a specialist. What fails is the Meester
    // answering in prose, or editing the file itself.
    const tasks = await craftbookTasks(client);
    const delegated = await delegatedSessionCount(client);
    const signals: string[] = [];
    if (tasks.length > 0) signals.push('craftbook-invoked');
    if (delegated > 0) signals.push('specialist-dispatched');
    if (signals.length === 0) {
      logChanged('sniff', '[scenario] tool-routing-bugfix: no handoff observed yet');
      recordSniff?.({ key: 'tool-routing-bugfix', score: 0, bytes: 0 });
      return { done: false };
    }
    const detail = tasks.length > 0 ? ` task ${tasks[0]!.taskRef}` : ` ${delegated} specialist session(s)`;
    logChanged('sniff', `[scenario] tool-routing-bugfix: handed off —${detail}`);
    recordSniff?.({ key: 'tool-routing-bugfix', score: signals.length, bytes: 0 });
    return {
      done: true,
      success: true,
      reason: `routed the fix to a specialist (${signals.join(', ')}):${detail}`,
    };
  },
};


/** History tool-call names observed anywhere in the trial. */
async function calledToolNames(client: GezelClient): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const maybe = client as unknown as {
      listHistory?: (q: { kind?: string; limit?: number }) => Promise<{
        entries: Array<{ entryType?: string; kind?: string; details?: Record<string, unknown> }>;
      }>;
    };
    if (typeof maybe.listHistory !== 'function') return out;
    const { entries } = await maybe.listHistory({ kind: 'tool.called', limit: 500 });
    for (const e of entries ?? []) {
      const name = (e.details ?? {}).name;
      if (typeof name === 'string') out.add(name);
    }
  } catch {
    /* history not ready yet */
  }
  return out;
}

/**
 * Tools that manufacture work. Counting TASKS looked equivalent and is not:
 * the daemon creates its own at boot — a night-shift oversight task and the
 * Boekwachter indexing job — so a task census fails an advice probe six
 * seconds in, before the model has answered, for work the model never did.
 *
 * Keying on the meester's own tool calls is both robust to ambient runtime
 * activity and closer to what "over-routing" means. `consult_*` is absent on
 * purpose: the persona's documented route for an opinion is to consult a
 * specialist and relay, so consulting is a PASS, not a failure.
 */
const WORK_CREATING_TOOLS = new Set([
  'start_project',
  'start_job',
  'create_task',
  'invoke_craftbook',
]);

const REPO_URL = 'https://github.com/bendyline/gezel';

export const toolRoutingRepoIntakeScenario: EvalScenario = {
  id: 'tool-routing-repo-intake',
  description:
    'Tests whether the Meester fetches a named repository into the project BEFORE recruiting ' +
    'a reviewer. The meester persona says "an empty project cannot be reviewed" and the ' +
    'loop-breaker carries a fetch-first hint, but nothing measured the routing decision. ' +
    'Fast-fail probe — grades the fetch attempt, not the review.',
  prompt:
    `Can you review the code in ${REPO_URL} and tell me what the main quality risks are?`,
  timeoutMs: 12 * 60_000,
  successCheck: async ({ client, logChanged, recordSniff }): Promise<SuccessCheckResult> => {
    const called = await calledToolNames(client);
    // The routing decision is the FETCH — whether the clone then succeeds is a
    // network question this probe deliberately does not grade, the same way
    // tool-routing-craftbook grades the invoke and not the transform.
    const fetched = called.has('fetch_repo') || called.has('fetch_diff');
    if (!fetched) {
      logChanged('sniff', '[scenario] tool-routing-repo-intake: no repo intake attempted yet');
      recordSniff?.({ key: 'tool-routing-repo-intake', score: 0, bytes: 0 });
      return { done: false };
    }
    const tool = called.has('fetch_repo') ? 'fetch_repo' : 'fetch_diff';
    logChanged('sniff', `[scenario] tool-routing-repo-intake: ${tool} called`);
    recordSniff?.({ key: 'tool-routing-repo-intake', score: 1, bytes: 0 });
    return {
      done: true,
      success: true,
      reason: `fetched the source with ${tool} before reviewing`,
    };
  },
};

/**
 * The inverse failure. Every other probe in this family checks that the
 * Meester DOES route; none checks that it declines to when the user only
 * asked a question. Spinning up a project and a crew for "what do you think
 * about X" is its own annoyance shape, and the persona explicitly covers it:
 * "For advice, research, or an opinion that does not need a project, consult
 * a specialist and relay the answer briefly."
 *
 * Pass: the meester answers in chat and creates no task. A consult that
 * produces a specialist session is fine — that IS the documented route; what
 * fails is manufacturing project work out of a question.
 */
export const toolRoutingAdviceScenario: EvalScenario = {
  id: 'tool-routing-advice',
  description:
    'Tests that the Meester answers a plain opinion question without manufacturing a task. ' +
    'The inverse of every other routing probe: measures OVER-routing, which nothing else ' +
    'covers. Fails if a task is created for a question that only needed an answer.',
  prompt:
    'Quick question, no need to start anything: for a small single-user desktop app that ' +
    'stores a few thousand records, would you lean towards SQLite or Postgres, and why?',
  timeoutMs: 10 * 60_000,
  successCheck: async ({ client, logChanged, recordSniff }): Promise<SuccessCheckResult> => {
    const called = await calledToolNames(client);
    const overRouted = [...called].filter((name) => WORK_CREATING_TOOLS.has(name));
    if (overRouted.length > 0) {
      logChanged('sniff', `[scenario] tool-routing-advice: over-routed via ${overRouted.join(', ')}`);
      recordSniff?.({ key: 'tool-routing-advice', score: 0, bytes: 0 });
      return {
        done: true,
        success: false,
        reason: `over-routed: called ${overRouted.join(', ')} for a question that asked for no work`,
      };
    }
    // Wait for a real answer before passing — "no task yet" is also what an
    // unanswered question looks like, and a probe that cannot tell those apart
    // passes for the wrong reason.
    const maybe = client as unknown as {
      listChatSessions?: () => Promise<{ sessions: Array<{ id: string; messages?: unknown[] }> }>;
      getChatSession?: (id: string) => Promise<{ messages?: Array<{ role?: string }> }>;
    };
    if (typeof maybe.listChatSessions !== 'function') return { done: false };
    let answered = false;
    try {
      const { sessions } = await maybe.listChatSessions();
      for (const listed of sessions ?? []) {
        const msgs =
          (listed.messages as Array<{ role?: string }> | undefined) ??
          (typeof maybe.getChatSession === 'function'
            ? ((await maybe.getChatSession(listed.id)).messages ?? [])
            : []);
        if (msgs.some((m) => m.role === 'assistant')) answered = true;
      }
    } catch {
      return { done: false };
    }
    if (!answered) {
      logChanged('sniff', '[scenario] tool-routing-advice: no answer yet');
      recordSniff?.({ key: 'tool-routing-advice', score: 0, bytes: 0 });
      return { done: false };
    }
    logChanged('sniff', '[scenario] tool-routing-advice: answered in chat, no task created');
    recordSniff?.({ key: 'tool-routing-advice', score: 1, bytes: 0 });
    return { done: true, success: true, reason: 'answered the question without creating work' };
  },
};


export function toolRoutingFormatScenarios(): EvalScenario[] {
  return [
    toolRoutingPptxScenario,
    toolRoutingBugfixScenario,
    toolRoutingRepoIntakeScenario,
    toolRoutingAdviceScenario,
  ];
}
