import type { GezelClient } from '@bendyline/gezel-client/node';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';

/**
 * Tool-routing — retrieval before file-walking.
 *
 * Focused probe for the Tier-3 retrieval-first steering: given a seeded
 * multi-file repo and a "where is X and what's wrong with it" question,
 * does the team LOCATE the code with a retrieval tool (`search_files`,
 * `search_code`, `find_symbol`, `map_repo`, `find_references`) instead of
 * readFile-walking the listing? File-walking is the classic local-model
 * failure this measures: each read burns a turn and floods the context.
 *
 * Pass: a retrieval `tool.called` event fires with at most 3 readFile
 * events before the first one. Fail fast: 8+ readFile events with no
 * retrieval call (the walk happened; no point waiting out the clock).
 *
 * Setup seeds the workspace and waits for the STRUCTURAL index (no LLM
 * enrichment needed — keyword FTS over symbols/docs is enough), so the
 * scenario measures model behavior, not index warm-up.
 */

const PROJECT_NAME = 'winkelwagen';

const RETRIEVAL_TOOL_RE = /\b(search_files|search_code|find_symbol|map_repo|find_references)\b/i;
const READ_FILE_RE = /\breadFile\b/;
const MAX_READS_BEFORE_SEARCH = 3;
const WALK_FAIL_THRESHOLD = 8;
const INDEX_WAIT_MS = 120_000;

const DECOY = (name: string) =>
  `export function ${name}(value: number): number {\n  return value;\n}\n`;

const SEED_FILES: Array<{ path: string; content: string }> = [
  {
    path: 'src/pricing/voucher.ts',
    content: [
      'export function applyGiftVoucher(total: number, voucherValue: number): number {',
      '  // Vouchers may not cover the entire order.',
      '  if (voucherValue > total) {',
      '    return total;',
      '  }',
      '  return total - voucherValue + 1;',
      '}',
      '',
    ].join('\n'),
  },
  { path: 'src/pricing/tax.ts', content: DECOY('applyTax') },
  { path: 'src/pricing/shipping.ts', content: DECOY('shippingCost') },
  { path: 'src/cart/items.ts', content: DECOY('countItems') },
  { path: 'src/cart/totals.ts', content: DECOY('cartTotal') },
  { path: 'src/ui/render.ts', content: DECOY('renderCart') },
  { path: 'src/ui/badge.ts', content: DECOY('renderBadge') },
  { path: 'src/data/products.ts', content: DECOY('listProducts') },
  { path: 'src/data/customers.ts', content: DECOY('listCustomers') },
  { path: 'src/util/money.ts', content: DECOY('formatMoney') },
  { path: 'src/util/log.ts', content: DECOY('logEvent') },
  { path: 'docs/overview.md', content: '# Winkelwagen\n\nA small shopping-cart library.\n' },
  { path: 'docs/pricing.md', content: '# Pricing\n\nTotals, tax, shipping, vouchers.\n' },
  { path: 'package.json', content: '{ "name": "winkelwagen", "private": true }\n' },
];

async function resolveProjectId(client: GezelClient): Promise<string | null> {
  const { projects } = await client.listProjects();
  return projects.find((p) => p.name === PROJECT_NAME)?.id ?? null;
}

async function setup({ client, log }: EvalContext): Promise<void> {
  let projectId = await resolveProjectId(client);
  if (!projectId) {
    const created = await client.createProject({
      name: PROJECT_NAME,
      about: 'A small TypeScript shopping-cart library: pricing, cart, UI, and data modules.',
      missionObjectives: 'Keep cart pricing correct: totals, tax, shipping, and voucher discounts.',
    });
    projectId = created.id;
    log(`[scenario:setup] created project id=${projectId}`);
  }
  for (const f of SEED_FILES) {
    await client.writeProjectWorkspaceFile(projectId, f);
  }
  log(`[scenario:setup] seeded ${SEED_FILES.length} files`);

  // Wait for the structural content index so retrieval tools actually work
  // when the model reaches for them — otherwise the scenario measures index
  // readiness instead of routing.
  await client.refreshProjectIndex(projectId).catch(() => undefined);
  const deadline = Date.now() + INDEX_WAIT_MS;
  for (;;) {
    const map = await client.toolMapRepo(projectId, {}).catch(() => null);
    if (map?.indexed) break;
    if (Date.now() > deadline) {
      log('[scenario:setup] WARNING: content index not ready after wait; proceeding anyway');
      break;
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  log('[scenario:setup] content index ready');
}

export const toolRoutingRetrievalScenario: EvalScenario = {
  id: 'tool-routing-retrieval',
  description:
    'Tests whether the team locates code with retrieval tools (search_files/search_code/find_symbol/map_repo) instead of readFile-walking the workspace listing. Probe for the Tier-3 retrieval-first steering.',
  prompt: `In the "${PROJECT_NAME}" project there is a bug: gift-voucher discounts come out one cent too high. Find where gift-voucher discounts are applied and reply IN CHAT with the file path, the line, and what is wrong. Do not fix anything — just locate and explain it.`,
  timeoutMs: 15 * 60_000,
  setup,
  successCheck: async ({ client, logChanged }): Promise<SuccessCheckResult> => {
    const projectId = await resolveProjectId(client);
    if (!projectId) {
      logChanged('routing', '[scenario] winkelwagen project not present yet');
      return { done: false };
    }
    const { entries } = await client.listHistory({ limit: 300 });
    // Newest-first → reverse into chronological order for the walk count.
    const toolEvents = entries
      .filter(
        (e) => e.entryType === 'event' && e.kind === 'tool.called' && e.projectId === projectId,
      )
      .reverse();

    let readsBeforeSearch = 0;
    let retrievalSeen: string | null = null;
    for (const e of toolEvents) {
      const summary = e.entryType === 'event' ? (e.summary ?? '') : '';
      const retrieval = RETRIEVAL_TOOL_RE.exec(summary);
      if (retrieval) {
        retrievalSeen = retrieval[1] ?? 'retrieval';
        break;
      }
      if (READ_FILE_RE.test(summary)) readsBeforeSearch++;
    }

    logChanged(
      'routing',
      `[scenario] readFile-before-search=${readsBeforeSearch} retrieval=${retrievalSeen ?? 'none yet'}`,
    );

    if (retrievalSeen) {
      const ok = readsBeforeSearch <= MAX_READS_BEFORE_SEARCH;
      return {
        done: true,
        success: ok,
        reason: ok
          ? `${retrievalSeen} called after ${readsBeforeSearch} readFile(s)`
          : `${retrievalSeen} called only after ${readsBeforeSearch} readFile-walk steps`,
      };
    }
    if (readsBeforeSearch >= WALK_FAIL_THRESHOLD) {
      return {
        done: true,
        success: false,
        reason: `readFile-walked ${readsBeforeSearch} files without any retrieval call`,
      };
    }
    return { done: false };
  },
};
