/**
 * TRUE end-to-end passes: one user message to the Meester, through whatever
 * routing and execution the runtime chooses, to a real deliverable on disk.
 *
 * Everything else in the suite tests one half of that. The craftbook rail sets
 * `skipInitialPrompt` in workflow mode and creates the task directly
 * (`createTask({ craftbookId, dispatchEntry: true })`), so 286 of 287 specs
 * prove the crew can execute a book and never that the router hands off. The
 * `tool-routing-*` probes prove the handoff and stop there by design. Both
 * halves passing is not the same as the chain working — and the chain is the
 * only thing a user actually exercises.
 *
 * The seam is where the real failures happened: "Can you create a PowerPoint
 * about France" (router looped on `ensure_gezel`), "…about Valencia" (routed,
 * then stalled), "…about Alaska" (router mistook DocBlocks' `describe_template`
 * for a craftbook lookup). No eval could catch any of them.
 *
 * Three rules these scenarios share:
 *
 *   1. **No pinned output path.** A Meester-started run picks its own craftbook
 *      params. Grading a fixed path would measure the harness's guess, not the
 *      work, so each scenario searches both drawers for a deliverable that is
 *      really what it claims.
 *   2. **Verify the bytes, not the extension.** A markdown file renamed `.pptx`
 *      satisfies a name check. ZIP magic plus the presentation part does not.
 *   3. **Require BOTH halves.** A deliverable with no routing evidence means the
 *      Meester hand-built it — which is the documented failure, not a pass.
 *
 * Slow by construction: routing plus a full multi-step book. They are their own
 * suite (`meester-e2e`) rather than riding in a fast one.
 */

import type { GezelClient } from '@bendyline/gezel-client/node';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';

interface FoundFile {
  path: string;
  surface: 'workspace' | 'artifacts';
  projectId: string;
  bytes: number;
}

/** Walk both drawers of every project, newest surface first. */
async function eachProjectFile(
  client: GezelClient,
  visit: (
    projectId: string,
    surface: 'workspace' | 'artifacts',
    path: string,
  ) => Promise<FoundFile | null>,
): Promise<FoundFile | null> {
  const projects = await client.listProjects().catch(() => ({ projects: [] }));
  for (const project of projects.projects ?? []) {
    for (const surface of ['workspace', 'artifacts'] as const) {
      const listing = await (surface === 'workspace'
        ? client.listProjectWorkspace(project.id, undefined, true)
        : client.listProjectArtifacts(project.id, undefined, true)
      ).catch(() => ({ files: [] }));
      for (const file of listing.files ?? []) {
        if (file.isDirectory) continue;
        const hit = await visit(project.id, surface, file.path);
        if (hit) return hit;
      }
    }
  }
  return null;
}

async function readBytes(
  client: GezelClient,
  projectId: string,
  surface: 'workspace' | 'artifacts',
  path: string,
): Promise<Uint8Array | null> {
  try {
    const blob =
      surface === 'workspace'
        ? await client.fetchProjectWorkspaceBlob(projectId, path)
        : await client.fetchProjectArtifactBlob(projectId, path);
    return new Uint8Array(await blob.arrayBuffer());
  } catch {
    return null; // mid-write, or not readable through this surface
  }
}

/** An Open XML package: ZIP magic plus the format's own main part. */
function isOpenXml(bytes: Uint8Array, requiredPart: string): boolean {
  if (bytes.length < 1000 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  return Buffer.from(bytes).toString('latin1').includes(requiredPart);
}

function isPdf(bytes: Uint8Array): boolean {
  if (bytes.length < 800) return false;
  const text = Buffer.from(bytes.subarray(0, 1024)).toString('latin1');
  return text.startsWith('%PDF-');
}

function findBinaryDeliverable(
  client: GezelClient,
  extension: RegExp,
  verify: (bytes: Uint8Array) => boolean,
): Promise<FoundFile | null> {
  return eachProjectFile(client, async (projectId, surface, path) => {
    if (!extension.test(path)) return null;
    const bytes = await readBytes(client, projectId, surface, path);
    if (!bytes || !verify(bytes)) return null;
    return { path, surface, projectId, bytes: bytes.length };
  });
}

function findTextFile(
  client: GezelClient,
  pathRe: RegExp,
  contentRe: RegExp,
  minBytes = 400,
): Promise<FoundFile | null> {
  return eachProjectFile(client, async (projectId, surface, path) => {
    if (!pathRe.test(path)) return null;
    const bytes = await readBytes(client, projectId, surface, path);
    if (!bytes || bytes.length < minBytes) return null;
    const text = Buffer.from(bytes).toString('utf8');
    return contentRe.test(text) ? { path, surface, projectId, bytes: bytes.length } : null;
  });
}

/** Craftbook-sourced tasks, which is the routing evidence half of every pass. */
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
 * Sessions belonging to someone other than the meester that were actually
 * spoken to. The meester's gezel id is random per trial, so it is read from
 * config — hardcoding `"meester"` made an earlier probe pass in six seconds by
 * counting the meester's own session. A session must carry a message: created
 * but unaddressed is not a handoff.
 */
async function delegatedSessionCount(client: GezelClient): Promise<number> {
  try {
    const config = await client.getConfig();
    const meesterId = config.meesterGezelId;
    const maybe = client as unknown as {
      listChatSessions?: () => Promise<{
        sessions: Array<{ gezelId?: string; id: string; messages?: unknown[] }>;
      }>;
      getChatSession?: (id: string) => Promise<{ messages?: unknown[] }>;
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

async function installDocblocks(ctx: EvalContext): Promise<void> {
  try {
    await ctx.client.installToolset('docblocks', {
      sourceId: 'bundled',
      scope: { kind: 'shared' },
    });
    ctx.log('[scenario:setup] installed the docblocks toolset');
  } catch (err) {
    ctx.log(
      `[scenario:setup] docblocks unavailable (${err instanceof Error ? err.message : String(err)})`,
    );
  }
}

/** Shared grader for the three document-production passes. */
function documentPass(opts: {
  key: string;
  bookRe: RegExp;
  extension: RegExp;
  verify: (bytes: Uint8Array) => boolean;
  label: string;
}) {
  return async ({ client, logChanged, recordSniff }: EvalContext): Promise<SuccessCheckResult> => {
    const tasks = await craftbookTasks(client);
    const routed = tasks.find((t) => t.catalogIds.some((id) => opts.bookRe.test(id))) ?? tasks[0];
    const file = await findBinaryDeliverable(client, opts.extension, opts.verify);
    if (!file) {
      const stage = routed
        ? `routed to ${routed.catalogIds.join(', ')}, ${opts.label} pending`
        : 'not routed yet';
      logChanged('sniff', `[scenario] ${opts.key}: ${stage}`);
      recordSniff?.({ key: opts.key, score: routed ? 1 : 0, bytes: 0 });
      return { done: false };
    }
    if (!routed) {
      return {
        done: true,
        success: false,
        reason: `a ${opts.label} exists at ${file.path} but no craftbook task was created — hand-built, not routed`,
      };
    }
    recordSniff?.({ key: opts.key, score: 2, bytes: file.bytes });
    return {
      done: true,
      success: true,
      reason: `routed to ${routed.catalogIds.join(', ')} (${routed.taskRef}) and produced a real ${file.bytes}-byte ${opts.label} at ${file.surface}:${file.path}`,
    };
  };
}

export const pptxMeesterEndToEndScenario: EvalScenario = {
  id: 'pptx-meester-e2e',
  description:
    'Whole chain: user asks the Meester for a PowerPoint → routes to a deck craftbook → the ' +
    'crew executes it → a real ZIP-shaped .pptx lands in the project. The seam where the ' +
    'France, Valencia and Alaska failures all lived.',
  prompt: 'Can you create a PowerPoint about the history of lighthouses?',
  timeoutMs: 45 * 60_000,
  setup: installDocblocks,
  successCheck: documentPass({
    key: 'pptx-meester-e2e',
    bookRe: /\b(?:powerpoint-deck|content-deck|narrated-slideshow)\b/,
    extension: /\.pptx$/i,
    verify: (b) => isOpenXml(b, 'ppt/presentation.xml'),
    label: '.pptx',
  }),
};

export const pdfMeesterEndToEndScenario: EvalScenario = {
  id: 'pdf-meester-e2e',
  description:
    'Whole chain for a PDF: user asks the Meester for a formatted PDF report → routes to a ' +
    'report craftbook → a real %PDF-headed file lands in the project.',
  prompt:
    'Can you put together a short PDF report on how tidal energy works and where it is used ' +
    'today? Two or three pages is plenty.',
  timeoutMs: 45 * 60_000,
  setup: installDocblocks,
  successCheck: documentPass({
    key: 'pdf-meester-e2e',
    bookRe: /\b(?:report-pdf|research-to-document|one-pager)\b/,
    extension: /\.pdf$/i,
    verify: isPdf,
    label: '.pdf',
  }),
};

export const docxMeesterEndToEndScenario: EvalScenario = {
  id: 'docx-meester-e2e',
  description:
    'Whole chain for a Word document: user asks the Meester for an editable .docx → routes ' +
    'to a document craftbook → a real Open XML wordprocessing file lands in the project.',
  prompt:
    'Can you write me a Word document — an editable .docx — briefing a new volunteer on how ' +
    'our Saturday food-bank shift runs?',
  timeoutMs: 45 * 60_000,
  setup: installDocblocks,
  successCheck: documentPass({
    key: 'docx-meester-e2e',
    bookRe: /\b(?:research-to-document|technical-documentation|one-pager)\b/,
    extension: /\.docx$/i,
    verify: (b) => isOpenXml(b, 'word/document.xml'),
    label: '.docx',
  }),
};

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
  "test('multiplies price by quantity', () => {",
  '  expect(cartTotal([{ price: 5, quantity: 3 }])).toBe(15);',
  '});',
  '',
].join('\n');

/** The fix, however it is spelled: price and quantity multiplied together. */
const QUANTITY_APPLIED_RE =
  /price\s*\*\s*[^;\n]*quantity|quantity\s*\*\s*[^;\n]*price|price\s*\*\s*quantity|quantity\s*\*\s*price/;

export const bugfixMeesterEndToEndScenario: EvalScenario = {
  id: 'bugfix-meester-e2e',
  description:
    'Whole chain for a code fix: user reports a bug to the Meester → routes to a developer ' +
    'or a fix craftbook → src/cart.js actually multiplies price by quantity. Graded on the ' +
    'SOURCE changing, not on anyone reporting that it did.',
  prompt:
    'There is a bug in src/cart.js — cartTotal ignores item quantity, so three $5 items bill ' +
    'as $5. There is a failing test in src/cart.test.js. Can you get it fixed?',
  timeoutMs: 45 * 60_000,
  setup: async (ctx: EvalContext): Promise<void> => {
    const created = await ctx.client.createProject({
      name: 'Checkout Total Bug',
      about: 'A small JavaScript cart module with a failing quantity calculation.',
    });
    await ctx.client.writeProjectWorkspaceFile(created.id, {
      path: 'src/cart.js',
      content: CART_SOURCE,
    });
    await ctx.client.writeProjectWorkspaceFile(created.id, {
      path: 'src/cart.test.js',
      content: CART_TEST,
    });
    ctx.log(`[scenario:setup] seeded the buggy cart module in ${created.id}`);
  },
  successCheck: async ({ client, logChanged, recordSniff }): Promise<SuccessCheckResult> => {
    // The deliverable IS the edited file. A chat reply saying "fixed" is the
    // failure this grades against.
    const fixed = await findTextFile(client, /(^|\/)cart\.js$/, QUANTITY_APPLIED_RE, 60);
    if (!fixed) {
      logChanged('sniff', '[scenario] bugfix-meester-e2e: cart.js still ignores quantity');
      recordSniff?.({ key: 'bugfix-meester-e2e', score: 0, bytes: 0 });
      return { done: false };
    }
    const tasks = await craftbookTasks(client);
    const delegated = await delegatedSessionCount(client);
    if (tasks.length === 0 && delegated === 0) {
      return {
        done: true,
        success: false,
        reason: `cart.js was fixed at ${fixed.path} but nothing was routed — the Meester edited it itself`,
      };
    }
    const how =
      tasks.length > 0 ? `task ${tasks[0]!.taskRef}` : `${delegated} specialist session(s)`;
    recordSniff?.({ key: 'bugfix-meester-e2e', score: 2, bytes: fixed.bytes });
    return {
      done: true,
      success: true,
      reason: `routed (${how}) and cart.js now multiplies price by quantity`,
    };
  },
};

const REVIEW_SOURCE = [
  'export function applyDiscount(order, code) {',
  '  // Codes are compared case-sensitively, so "SAVE10" works and "save10" does not.',
  '  if (code === "SAVE10") order.total = order.total * 0.9;',
  '  // No guard: a negative total is possible when credits exceed the order.',
  '  return order;',
  '}',
  '',
  'export function creditOrder(order, credit) {',
  '  order.total = order.total - credit;',
  '  return order;',
  '}',
  '',
].join('\n');

export const codeReviewMeesterEndToEndScenario: EvalScenario = {
  id: 'code-review-meester-e2e',
  description:
    'Whole chain for a review: user asks the Meester to review seeded source → routes to a ' +
    'reviewer or review craftbook → a written review lands on disk that cites the real file ' +
    'path. Graded on the review document existing and being grounded, not on chat prose.',
  prompt:
    'Can you get someone to review src/pricing.js and write up what the quality risks are? ' +
    'I want the findings written down, not just described to me.',
  timeoutMs: 45 * 60_000,
  setup: async (ctx: EvalContext): Promise<void> => {
    const created = await ctx.client.createProject({
      name: 'Pricing Review',
      about: 'A small pricing module awaiting a quality review.',
    });
    await ctx.client.writeProjectWorkspaceFile(created.id, {
      path: 'src/pricing.js',
      content: REVIEW_SOURCE,
    });
    ctx.log(`[scenario:setup] seeded src/pricing.js in ${created.id}`);
  },
  successCheck: async ({ client, logChanged, recordSniff }): Promise<SuccessCheckResult> => {
    // A review that never names the file it reviewed is not grounded, which is
    // the failure mode worth catching here.
    const review = await findTextFile(client, /\.(?:md|markdown)$/i, /src\/pricing\.js/, 500);
    if (!review) {
      logChanged(
        'sniff',
        '[scenario] code-review-meester-e2e: no written review citing the file yet',
      );
      recordSniff?.({ key: 'code-review-meester-e2e', score: 0, bytes: 0 });
      return { done: false };
    }
    const tasks = await craftbookTasks(client);
    const delegated = await delegatedSessionCount(client);
    if (tasks.length === 0 && delegated === 0) {
      return {
        done: true,
        success: false,
        reason: `a review exists at ${review.path} but nothing was routed — the Meester wrote it itself`,
      };
    }
    const how =
      tasks.length > 0 ? `task ${tasks[0]!.taskRef}` : `${delegated} specialist session(s)`;
    recordSniff?.({ key: 'code-review-meester-e2e', score: 2, bytes: review.bytes });
    return {
      done: true,
      success: true,
      reason: `routed (${how}) and a ${review.bytes}-byte review citing src/pricing.js landed at ${review.surface}:${review.path}`,
    };
  },
};

const DECK_BOOK_RE = /\b(?:powerpoint-deck|content-deck|narrated-slideshow)\b/;

/**
 * Tools that count as research: the user's own material (`search` covers the
 * shared library, memories, artifacts and installed knowledge catalogs) and
 * the live web. The book names every one of these in its research step.
 */
const RESEARCH_TOOLS = new Set([
  'search',
  'read_document',
  'web_search',
  'wikipedia_search',
  'wikipedia_read',
  'fetch_url',
  'browser_navigate',
  'run_playwright_script',
]);

async function installFoodKnowledge(ctx: EvalContext): Promise<void> {
  try {
    await ctx.client.installKnowledgeCatalogFromCatalog('wikipedia-food-drink', () => {});
    ctx.log('[scenario:setup] installed the wikipedia-food-drink knowledge catalog');
  } catch (err) {
    ctx.log(
      `[scenario:setup] wikipedia-food-drink unavailable (${err instanceof Error ? err.message : String(err)}) — research falls back to the web`,
    );
  }
}

/**
 * The front-door PowerPoint ask, exactly as a user types it, against the
 * setup a real install has: DocBlocks in Default and a food-and-drink
 * knowledge catalog beside the live web.
 *
 * Stricter than `pptx-meester-e2e`, which passes the moment a .pptx exists:
 * this one waits for the task to finish every phase, and requires that
 * research actually ran, that the deck is about the topic, and that one ask
 * started one crew.
 */
export const pptxMeesterPizzaScenario: EvalScenario = {
  id: 'pptx-meester-pizza',
  description:
    'Front-door PowerPoint in Default: "Create a PowerPoint about pizza" → Meester routes to the deck craftbook → one crew runs every phase (research with real tool evidence, outline, write, review, publish, evaluate, finish) → a real .pptx about pizza.',
  prompt: 'Create a PowerPoint about pizza',
  timeoutMs: 180 * 60_000,
  // Measure the product, not the harness: a real user gets no "direct kick".
  // Under the harness policy a kick queued 14 s into the write step landed
  // after that step had handed off, the finished session failed its forced
  // write twice, and "repair-aborted" ended a run that was progressing
  // normally on publish (qwen3.8-27b, 2026-09-23).
  repairPolicy: 'runtime',
  setup: async (ctx) => {
    await installDocblocks(ctx);
    await installFoodKnowledge(ctx);
  },
  successCheck: async ({ client, logChanged, recordSniff }: EvalContext) => {
    const listed = await client.listTasks().catch(() => ({ tasks: [] }));
    const decks = (listed.tasks ?? []).filter((t) =>
      (t.sourceCraftbookIds ?? []).some((s) => DECK_BOOK_RE.test(s.catalogId ?? '')),
    );
    if (decks.length === 0) {
      logChanged('sniff', '[scenario] pptx-meester-pizza: not routed yet');
      recordSniff?.({ key: 'pptx-meester-pizza', score: 0, bytes: 0 });
      return { done: false };
    }
    if (decks.length > 1) {
      return {
        done: true,
        success: false,
        reason: `one ask started ${decks.length} deck crews (${decks.map((t) => t.ref).join(', ')})`,
      };
    }
    const task = decks[0]!;
    const deck = await findBinaryDeliverable(client, /\.pptx$/i, (b) =>
      isOpenXml(b, 'ppt/presentation.xml'),
    );
    logChanged(
      'sniff',
      `[scenario] pptx-meester-pizza: ${task.ref} ${task.status} step=${task.activeStepId ?? '-'} pptx=${deck ? `${deck.bytes}B` : 'none'}`,
    );
    // Score climbs with every step reached, so a book walking its phases
    // reads as progress to the deliverable-anchored deadline instead of one
    // long plateau from research to publish.
    const steps = task.craftbook?.steps ?? [];
    const reached =
      Math.max(
        0,
        steps.findIndex((s) => s.id === task.activeStepId),
      ) + 1;
    const score = task.status === 'complete' ? steps.length + 1 : reached;
    recordSniff?.({ key: 'pptx-meester-pizza', score, bytes: deck?.bytes ?? 0 });
    if (task.status === 'paused' || task.status === 'canceled') {
      return {
        done: true,
        success: false,
        reason: `${task.ref} ${task.status} at step ${task.activeStepId ?? '?'}${deck ? ` (a ${deck.bytes}-byte .pptx exists)` : ''}`,
      };
    }
    if (task.status !== 'complete') return { done: false };

    const gaps: string[] = [];
    if (!deck) gaps.push('no real .pptx');
    const source = await findTextFile(client, /(?:^|\/)deck\.md$/, /pizza/i, 200);
    if (!source) gaps.push('no Markdown deck source mentions pizza');
    const history = await client
      .listHistory({ kind: 'tool.called', limit: 2000 })
      .catch(() => ({ entries: [] }));
    const research = (history.entries ?? []).flatMap((e) => {
      if (e.entryType !== 'event') return [];
      const d = (e.details ?? {}) as Record<string, unknown>;
      const hit =
        d.taskRef === task.ref &&
        d.stepId === 'research' &&
        d.success === true &&
        RESEARCH_TOOLS.has(String(d.name));
      return hit ? [String(d.name)] : [];
    });
    if (research.length === 0) gaps.push('research step made no successful research-tool call');
    if (gaps.length > 0) {
      return { done: true, success: false, reason: `${task.ref} complete but ${gaps.join('; ')}` };
    }
    const used = [...new Set(research)];
    return {
      done: true,
      success: true,
      reason: `${task.ref} ran every phase; research used ${used.join(', ')}; ${deck!.bytes}-byte .pptx at ${deck!.surface}:${deck!.path}`,
    };
  },
};

export function meesterEndToEndScenarios(): EvalScenario[] {
  return [
    pptxMeesterEndToEndScenario,
    pptxMeesterPizzaScenario,
    pdfMeesterEndToEndScenario,
    docxMeesterEndToEndScenario,
    bugfixMeesterEndToEndScenario,
    codeReviewMeesterEndToEndScenario,
  ];
}
