import type { GezelClient } from '@bendyline/gezel-client/node';
import type { EvalContext, EvalScenario, SuccessCheckResult } from '../types.ts';

/**
 * Tool-routing — craftbook adoption for one-off data-transform asks.
 *
 * Focused probe on ONE capability: when the user hands the Meester a
 * one-off "clean up these spreadsheets" job, does the Meester route it
 * through the craftbook surface (`suggest_craftbook` →
 * `invoke_craftbook`, creating a GATED task) instead of delegating it
 * raw? Raw delegation loses the data books' integrity gates (dedup
 * keys, `valuesSubsetOf` value conservation) exactly where they matter.
 *
 * Wild-caught (core-sweep follow-ups): both data-wrangle
 * probes bypassed the books entirely — the meesters went straight to
 * `delegate_developer`/`delegate_builder`, so the freshly shipped ETL
 * gate never ran. The `prompt.meester-craftbook-prelude` transform
 * branch is the steering this probe measures; A/B it via
 * `--remove-behaviors prompt.meester-craftbook-prelude`.
 *
 * Pass: within the window, a task exists whose `sourceCraftbookIds`
 * names a catalog craftbook (a data-class book scores full marks in the
 * sniff signals; any invoked book still passes — recipe-routing is the
 * capability, book choice is quality). Fail: timeout with no
 * craftbook-sourced task (however much raw delegation happened).
 *
 * The probe measures ROUTING, not the transform itself — it does not
 * wait for the cleaned output. Fast-fail by design, like
 * `tool-routing-image` and `tool-routing-retrieval`.
 */

const PROJECT_NAME = 'Customer List Cleanup';

/** Data-class books whose gates this routing exists to reach. */
const DATA_CLASS_BOOK_RE =
  /\b(?:dataset-clean|csv-transformer|data-pipeline-etl|data-quality-audit|data-join-merge|records?-[a-z-]+)\b/;

const RAW_A = [
  'id,name,email,signup_date',
  'A-001,Alice Jansen,ALICE@example.com,03/12/2026',
  'A-002,Bram Peters,bram@example.com ,2026-01-19',
  'A-003,"Vries, Carla de",carla@example.com,17.02.2026',
].join('\n');

const RAW_B = [
  'id,name,email,signup_date',
  'B-001,Alice Jansen,alice@example.com,2026-03-14',
  'B-002,Deniz Kaya,deniz@example.com,2026-02-02',
].join('\n');

async function findCraftbookTask(
  client: GezelClient,
): Promise<{ taskRef: string; catalogIds: string[] } | null> {
  try {
    const res = await client.listTasks();
    for (const t of res.tasks ?? []) {
      const ids = (t.sourceCraftbookIds ?? []).map((s) => s.catalogId).filter(Boolean);
      if (ids.length > 0) return { taskRef: t.ref, catalogIds: ids };
    }
  } catch {
    /* task API not ready yet */
  }
  return null;
}

export const toolRoutingCraftbookScenario: EvalScenario = {
  id: 'tool-routing-craftbook',
  description:
    'Tests whether the Meester routes a one-off data-transform ask through the craftbook ' +
    'surface (suggest_craftbook → invoke_craftbook, creating a gated task) instead of raw ' +
    'delegation. Fast-fail probe for the data books + valuesSubsetOf gate adoption path.',
  prompt:
    'Please clean up the raw customer spreadsheets in the "Customer List Cleanup" project: ' +
    'normalize the emails and dates, dedupe the records, and produce one tidy consolidated ' +
    'customers file. The raw CSV exports are already in the workspace under data/raw/.',
  timeoutMs: 15 * 60_000,
  setup: async (ctx: EvalContext): Promise<void> => {
    const { client, log } = ctx;
    const created = await client.createProject({
      name: PROJECT_NAME,
      about:
        'Consolidate two raw customer CSV exports into one clean, deduplicated customers file.',
    });
    await client.writeProjectWorkspaceFile(created.id, {
      path: 'data/raw/customers_a.csv',
      content: RAW_A,
    });
    await client.writeProjectWorkspaceFile(created.id, {
      path: 'data/raw/customers_b.csv',
      content: RAW_B,
    });
    log(`[scenario:setup] seeded 2 raw CSVs under project ${created.id}`);
  },
  successCheck: async ({ client, logChanged, recordSniff }): Promise<SuccessCheckResult> => {
    const hit = await findCraftbookTask(client);
    if (!hit) {
      logChanged('sniff', '[scenario] tool-routing-craftbook: no craftbook-sourced task yet');
      recordSniff?.({ key: 'tool-routing-craftbook', score: 0, bytes: 0 });
      return { done: false };
    }
    const dataClass = hit.catalogIds.some((id) => DATA_CLASS_BOOK_RE.test(id));
    const signals = ['craftbook-invoked', ...(dataClass ? ['data-class-book'] : [])];
    logChanged(
      'sniff',
      `[scenario] tool-routing-craftbook: task ${hit.taskRef} from craftbook(s) ${hit.catalogIds.join(', ')} (signals: ${signals.join(', ')})`,
    );
    recordSniff?.({ key: 'tool-routing-craftbook', score: signals.length, bytes: 0 });
    return {
      done: true,
      success: true,
      reason: `task ${hit.taskRef} created from craftbook ${hit.catalogIds.join(', ')} (signals: ${signals.join(', ')})`,
    };
  },
};
