import type { GezelClient } from '@bendyline/gezel-client/node';

/**
 * Drive a project's AI enrichment to completion via the bounded on-demand
 * route (`POST /:id/index/enrich`) — the service does one budgeted pass per
 * call, this loop runs it dry. Runs during scenario `setup`, which the eval
 * watchdogs deliberately do not cover, so THIS loop owns its own deadline
 * and wedge detection; both throw so a stuck drive fails the trial loudly
 * instead of hanging it forever.
 */

const DEFAULT_DEADLINE_MS = 90 * 60_000;
const WEDGE_CALLS = 5;

export interface DriveTotals {
  files: number;
  summarized: number;
  embedded: number;
  areasUpdated: number;
  architectureUpdated: boolean;
  /** Files processed by the review pass (reviews stored + capped attempts). */
  reviewed: number;
  /** Wall-clock spent in review-only calls — the review pass is a second full
   *  LLM sweep and its cost must be visible next to the recall numbers. */
  reviewMs: number;
  calls: number;
  durationMs: number;
}

export async function driveEnrichmentToCompletion(
  client: GezelClient,
  projectId: string,
  opts: {
    deadlineMs?: number;
    areas?: boolean;
    reviews?: boolean;
    log?: (line: string) => void;
    signal?: AbortSignal;
  } = {},
): Promise<DriveTotals> {
  const started = Date.now();
  const deadline = started + (opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const totals: DriveTotals = {
    files: 0,
    summarized: 0,
    embedded: 0,
    areasUpdated: 0,
    architectureUpdated: false,
    reviewed: 0,
    reviewMs: 0,
    calls: 0,
    durationMs: 0,
  };
  let lastPending = Number.POSITIVE_INFINITY;
  let stuckCalls = 0;

  for (;;) {
    if (opts.signal?.aborted) throw new Error('enrichment drive aborted');
    if (Date.now() > deadline) {
      throw new Error(
        `enrichment drive deadline exceeded (${Math.round((Date.now() - started) / 60_000)}m, ${totals.files} files done, pending stuck at ${lastPending})`,
      );
    }
    const callStarted = Date.now();
    const pass = await client.driveIndexEnrichment(projectId, {
      maxFiles: 25,
      budgetMs: 60_000,
      ...(opts.areas ? { areas: true } : {}),
      ...(opts.reviews ? { reviews: true } : {}),
    });
    totals.calls++;
    if (pass.paused) {
      stuckCalls++;
      if (stuckCalls >= WEDGE_CALLS) {
        throw new Error('enrichment drive wedged: boekwachter task is paused');
      }
      await sleep(2_000);
      continue;
    }
    totals.files += pass.files;
    totals.summarized += pass.summarized;
    totals.embedded += pass.embedded;
    totals.areasUpdated += pass.areasUpdated;
    totals.architectureUpdated ||= pass.architectureUpdated;
    const reviewedThisCall = pass.reviewed ?? 0;
    totals.reviewed += reviewedThisCall;
    if (reviewedThisCall > 0 && pass.files === 0) {
      totals.reviewMs += Date.now() - callStarted;
    }
    const reviewPending = opts.reviews ? (pass.reviewPending ?? 0) : 0;
    opts.log?.(
      `[drive] +${pass.files} files (Σ${totals.files})${opts.reviews ? ` +${reviewedThisCall} reviewed (Σ${totals.reviewed})` : ''}, pending=${pass.pending}${opts.reviews ? `, reviewPending=${reviewPending}` : ''}, elapsed=${Math.round((Date.now() - started) / 1000)}s`,
    );
    // The route runs the area pass inside the same call that drains the file
    // tier (when `areas` is set), so a drained+empty pass is fully done.
    if (pass.drained && pass.pending === 0 && reviewPending === 0) break;
    const combinedPending = pass.pending + reviewPending;
    if (combinedPending >= lastPending && pass.files === 0 && reviewedThisCall === 0) {
      stuckCalls++;
      if (stuckCalls >= WEDGE_CALLS) {
        throw new Error(
          `enrichment drive wedged: pending=${pass.pending}${opts.reviews ? `+${reviewPending} reviews` : ''} not decreasing after ${WEDGE_CALLS} calls`,
        );
      }
    } else {
      stuckCalls = 0;
    }
    lastPending = combinedPending;
  }

  totals.durationMs = Date.now() - started;
  return totals;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
