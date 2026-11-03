import type { GezelClient } from '@bendyline/gezel-client';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';
import { BUSINESS_PARITY_CASES } from './app-parity-cases/index.ts';
import { isoDaysAhead, lastReply, list, num, records } from './app-parity-helpers.ts';
import { projectTurnInProgress } from './helpers.ts';

/**
 * How long a failing verdict must hold after the lead's turn ends before the
 * case fails on it. Long enough for a runtime re-prompt to start, far shorter
 * than the five-minute stall that would otherwise report "chat stalled".
 */
const SETTLED_FAIL_MS = 60_000;

/**
 * App demo parity: what a Gezel app's website demo shows its companion doing,
 * a real crew member must do in Gezel. Each case creates the app's project,
 * reproduces the demo's starting state through the page's own tools, then
 * either sends the demo's suggestion to the crew lead or takes the page
 * action whose reaction should answer, and grades the app's data files.
 *
 * The demo replies are scripted (gilde `pages/**\/demo-chat.js`); a case
 * failing here means the website promises something the app does not
 * deliver on that model, so fix the app or the demo, not the grader.
 */

type Docs = Record<string, unknown>;

export interface ParityVerdict {
  ok: boolean;
  detail: string;
}

export interface ParityCase {
  /** Scenario id suffix; the scenario is `app-parity-<id>`. */
  id: string;
  typeId: string;
  params: Record<string, unknown>;
  /** Page-tool calls that rebuild the demo's starting sample. */
  prepare?: Array<{ tool: string; input: Record<string, unknown> }>;
  /** The demo suggestion, sent to the crew lead. */
  message?: string;
  /** Instead of a message: the person's page action, whose reaction must answer. */
  pageAction?: (docs: Docs) => { tool: string; input: Record<string, unknown> };
  /** Workspace files the grader reads (JSON). */
  reads: string[];
  check: (docs: Docs, before: Docs) => ParityVerdict;
  /** For a question: grade the crew lead's reply once the files pass. */
  reply?: (text: string) => ParityVerdict;
  timeoutMs?: number;
}

const PANTRY_SAMPLE = [
  ['Olive oil', 'low'],
  ['Limes', 'out'],
  ['Eggs', 'stocked'],
  ['Canned tomatoes', 'stocked'],
  ['Spinach', 'stocked'],
  ['Feta', 'stocked'],
] as const;

export const PARITY_CASES: ParityCase[] = [
  {
    id: 'meal-planner-plan-sunday',
    typeId: 'meal-planner',
    params: { household: 'two adults' },
    prepare: [
      ...PANTRY_SAMPLE.map(([name, level]) => ({
        tool: 'page_pantry_add',
        input: { name, level },
      })),
      { tool: 'page_set_menu', input: { day: 'monday', meal: 'Roasted tomato pasta' } },
    ],
    message: 'Plan Sunday around what we have',
    reads: ['menu.json'],
    check: (docs) => {
      const days = (docs['menu.json'] as { days?: Record<string, unknown> } | null)?.days ?? {};
      const sunday = typeof days.sunday === 'string' ? days.sunday.trim() : '';
      return sunday
        ? { ok: true, detail: `sunday="${sunday}"` }
        : { ok: false, detail: 'menu.json has no Sunday dinner' };
    },
  },
  {
    id: 'meal-planner-ran-out',
    typeId: 'meal-planner',
    params: { household: 'two adults' },
    prepare: PANTRY_SAMPLE.map(([name, level]) => ({
      tool: 'page_pantry_add',
      input: { name, level },
    })),
    message: 'We just ran out of olive oil',
    reads: ['pantry.json'],
    check: (docs) => {
      const oil = records(docs['pantry.json']).filter((r) =>
        /olive oil/i.test(String(r.fields?.name ?? '')),
      );
      if (oil.length === 0) return { ok: false, detail: 'no olive oil in pantry.json' };
      if (oil.length > 1) return { ok: false, detail: `${oil.length} olive oil records` };
      return oil[0]!.status === 'out'
        ? { ok: true, detail: 'olive oil marked out' }
        : { ok: false, detail: `olive oil is ${oil[0]!.status}` };
    },
  },
  {
    id: 'household-budget-log-expense',
    typeId: 'household-budget',
    params: { currency: 'USD' },
    message: 'Log 64.30 on groceries',
    reads: ['ledger.json'],
    check: (docs) => {
      const entries = list(docs['ledger.json'], 'entries');
      const hit = entries.find((e) => num(e.amountCents) === 6430 || num(e.amountCents) === -6430);
      if (!hit) return { ok: false, detail: `no 64.30 entry among ${entries.length}` };
      return /grocer/i.test(JSON.stringify(hit))
        ? { ok: true, detail: 'recorded $64.30 on groceries' }
        : {
            ok: false,
            detail: `64.30 recorded without a groceries category: ${JSON.stringify(hit)}`,
          };
    },
  },
  {
    id: 'trip-planner-party-grows',
    typeId: 'trip-planner',
    params: { destination: 'Lisbon', start: isoDaysAhead(18), travellers: '4' },
    message: 'Marta is joining us',
    reads: ['trip.json'],
    check: (docs) => {
      const party = String(
        (docs['trip.json'] as { travellers?: unknown } | null)?.travellers ?? '',
      );
      return /\b5\b|five/i.test(party)
        ? { ok: true, detail: `travelers="${party}"` }
        : { ok: false, detail: `travelers="${party}"` };
    },
  },
  {
    id: 'caregiving-binder-new-med',
    typeId: 'caregiving-binder',
    params: { person: 'Mom' },
    message: 'Dr. Chen started her on metformin, 500 mg with dinner',
    reads: ['meds.json'],
    check: (docs) => {
      const med = records(docs['meds.json']).find((r) =>
        /metformin/i.test(JSON.stringify(r.fields)),
      );
      if (!med) return { ok: false, detail: 'no metformin in meds.json' };
      return med.status === 'active'
        ? { ok: true, detail: `metformin active: ${JSON.stringify(med.fields)}` }
        : { ok: false, detail: `metformin is ${med.status}` };
    },
  },
  {
    id: 'job-hunt-applied',
    typeId: 'job-hunt',
    params: { role: 'Product Designer' },
    message: 'I just applied to Harbor & Co',
    reads: ['pipeline.json'],
    check: (docs) => {
      const app = records(docs['pipeline.json']).find((r) =>
        /harbor/i.test(String((r.fields as { company?: unknown } | undefined)?.company ?? '')),
      );
      return app
        ? { ok: true, detail: `Harbor & Co is ${app.status}` }
        : { ok: false, detail: 'no Harbor & Co application' };
    },
  },
  {
    id: 'fitness-coach-log-run',
    typeId: 'fitness-coach',
    params: { goal: 'running a 10K in the spring', weeklyTarget: 4 },
    message: 'I just did a 55-minute long run',
    reads: ['training.json'],
    check: (docs) => {
      const events = list(docs['training.json'], 'events');
      const run = events.find(
        (e) => num((e.data as Record<string, unknown> | undefined)?.minutes) === 55,
      );
      return run
        ? { ok: true, detail: `logged ${JSON.stringify(run.data)}` }
        : { ok: false, detail: `no 55-minute session among ${events.length} events` };
    },
  },
  {
    id: 'freelance-office-new-invoice',
    typeId: 'freelance-office',
    params: { business: 'brand design' },
    message: 'Bill Harbor & Pine for 14 hours at 85',
    reads: ['invoices.json'],
    check: (docs) => {
      const inv = records(docs['invoices.json']).find((r) =>
        /harbor/i.test(String((r.fields as { client?: unknown } | undefined)?.client ?? '')),
      );
      if (!inv) return { ok: false, detail: 'no Harbor & Pine invoice' };
      const cents = num((inv.fields as { amountCents?: unknown }).amountCents);
      return cents === 119000
        ? { ok: true, detail: `invoice of 1,190.00 is ${inv.status}` }
        : { ok: false, detail: `invoice amountCents=${cents}, expected 119000 (14 x 85)` };
    },
  },
  {
    id: 'fundraiser-hq-gift',
    typeId: 'fundraiser-hq',
    params: { cause: 'the library roof', goalCents: 500000 },
    message: 'Lotte Jansen just gave $200',
    reads: ['donations.json'],
    check: (docs) => {
      const gift = list(docs['donations.json'], 'entries').find(
        (e) => num(e.amountCents) === 20000,
      );
      if (!gift) return { ok: false, detail: 'no $200 gift recorded' };
      return /lotte/i.test(JSON.stringify(gift))
        ? { ok: true, detail: 'recorded $200 from Lotte Jansen' }
        : { ok: false, detail: `$200 recorded without the donor: ${JSON.stringify(gift)}` };
    },
  },
  {
    id: 'flashcards-add-cards',
    typeId: 'flashcards',
    params: { subject: 'Dutch phrases for the market' },
    message: 'Add five more market phrases',
    reads: ['deck.json'],
    check: (docs, before) => {
      const count = (d: unknown) => list(d, 'cards').length;
      const was = count(before['deck.json']);
      const now = count(docs['deck.json']);
      return now - was >= 3
        ? { ok: true, detail: `deck ${was}→${now} cards` }
        : { ok: false, detail: `deck ${was}→${now} cards` };
    },
  },
  {
    id: 'checkers-reply-move',
    typeId: 'checkers',
    params: { personality: 'gracious', playStyle: 'Opponent' },
    pageAction: (docs) => {
      const moves = (docs['game.json'] as { legalMoves?: Array<{ from: string; to: string }> })
        ?.legalMoves;
      const first = moves?.[0];
      if (!first) throw new Error('checkers: the seeded game has no legal move for the person');
      return { tool: 'user_move', input: { from: first.from, to: first.to } };
    },
    reads: ['game.json'],
    check: (docs, before) => {
      const game = docs['game.json'] as {
        moveLog?: Array<{ by?: string }>;
        turn?: string;
        status?: string;
      } | null;
      const was = (before['game.json'] as { moveLog?: unknown[] } | null)?.moveLog?.length ?? 0;
      const log = game?.moveLog ?? [];
      const replied = log.slice(was).some((m) => m.by === 'ai');
      if (!replied) return { ok: false, detail: `moveLog ${was}→${log.length}, no reply move yet` };
      return game?.turn === 'user' || game?.status !== 'playing'
        ? { ok: true, detail: `replied; moveLog ${was}→${log.length}` }
        : { ok: false, detail: `replied but turn=${game?.turn}` };
    },
  },
];

async function readWorkspaceJson(
  client: GezelClient,
  projectId: string,
  path: string,
): Promise<unknown | null> {
  try {
    return JSON.parse(await (await client.fetchProjectWorkspaceBlob(projectId, path)).text());
  } catch {
    return null;
  }
}

async function readDocs(client: GezelClient, projectId: string, paths: string[]): Promise<Docs> {
  const docs: Docs = {};
  for (const path of paths) docs[path] = await readWorkspaceJson(client, projectId, path);
  return docs;
}

function parityScenario(c: ParityCase): EvalScenario {
  const name = `Parity ${c.id}`;
  let projectId: string | null = null;
  let leadId: string | null = null;
  let before: Docs = {};
  let settled: { since: number; detail: string } | null = null;
  return {
    id: `app-parity-${c.id}`,
    description: `Demo parity for ${c.typeId}: ${c.message ? `"${c.message}"` : 'a page action whose reaction must answer'}`,
    prompt: `The "${name}" project is being exercised; no action needed.`,
    timeoutMs: c.timeoutMs ?? 8 * 60_000,
    skipInitialPrompt: true,
    // The harness's generic write_file kick misdirects a typed app's lead,
    // whose deliverable is a tool call, not a file (as for first projects).
    repairPolicy: 'runtime',
    setup: async (ctx: EvalContext) => {
      const { client, log } = ctx;
      const created = await client.createTypedProject({
        name,
        projectType: { typeId: c.typeId, params: c.params },
      });
      projectId = created.project.id;
      const lead =
        created.applied.gezelsCreated.find((g) => g.voorman)?.id ??
        (await client.getProject(projectId))?.voormanGezelId;
      if (!lead) throw new Error(`${c.id}: the ${c.typeId} project has no crew lead`);
      leadId = lead;
      for (const step of c.prepare ?? []) {
        await client.invokeProjectPageTool(projectId, step);
      }
      before = await readDocs(client, projectId, c.reads);
      if (c.message) {
        await client.sendChatMessage(lead, { message: c.message, projectId });
        log(`[scenario:setup] ${c.id}: sent "${c.message}" to ${lead}`);
      } else if (c.pageAction) {
        const action = c.pageAction(before);
        const result = await client.invokeProjectPageTool(projectId, action);
        log(
          `[scenario:setup] ${c.id}: page ${action.tool} ${JSON.stringify(action.input)} reaction=${JSON.stringify(result.reaction ?? null)}`,
        );
        if (result.reaction && !result.reaction.delivered) {
          throw new Error(`${c.id}: reaction not delivered (${result.reaction.reason})`);
        }
      }
    },
    successCheck: async (ctx): Promise<SuccessCheckResult> => {
      if (!projectId) return { done: false };
      const docs = await readDocs(ctx.client, projectId, c.reads);
      let verdict = c.check(docs, before);
      const text = leadId ? await lastReply(ctx.client, leadId, projectId) : null;
      if (verdict.ok && c.reply) {
        const answer = text ? c.reply(text) : { ok: false, detail: 'no reply yet' };
        verdict = { ok: answer.ok, detail: `${verdict.detail}; reply: ${answer.detail}` };
      }
      ctx.logChanged(
        'parity',
        `[scenario] ${c.id}: ${verdict.ok ? 'PASS' : 'waiting'} ${verdict.detail}`,
      );
      if (verdict.ok) return { done: true, success: true, reason: verdict.detail };
      if (!text || (await projectTurnInProgress(ctx.client, projectId))) {
        settled = null;
        return { done: false };
      }
      if (settled?.detail !== verdict.detail)
        settled = { since: Date.now(), detail: verdict.detail };
      if (Date.now() - settled.since < SETTLED_FAIL_MS) return { done: false };
      return {
        done: true,
        success: false,
        reason: `the lead's turn ended without passing: ${verdict.detail}`,
        failureMode: 'success-check-false',
      };
    },
  };
}

/** Every case: the personal apps above plus each business app's own file. */
export const ALL_PARITY_CASES: ParityCase[] = [...PARITY_CASES, ...BUSINESS_PARITY_CASES];

export const appParityScenarios: EvalScenario[] = ALL_PARITY_CASES.map(parityScenario);
