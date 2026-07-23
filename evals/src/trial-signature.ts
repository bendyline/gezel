/**
 * Cell-relative failure signatures for batch auto-triage (Theme E / E2).
 *
 * A "cell" is one `runBatch` invocation = one (scenario × model). When k
 * consecutive trials in a cell fail with an *identical* signature, the
 * batch loop stops launching more trials of that cell and surfaces the
 * cluster (see `batch.ts`). The signature answers "did these trials die
 * the same way?" — the harness twin of the product's
 * `gateFailureSignature`/`plateauScore` ladder (gate-escalation.ts), but
 * scoped to trial outcomes across a batch rather than gate-check identity
 * inside one repair loop.
 *
 * Leaf module: imports only `./types.ts`, so `batch.ts` can pull it
 * without dragging in the `runner.ts` graph.
 */

import type { FailureClass, TriageCluster, TrialFinalSniff, TrialResult } from './types.ts';

/**
 * Digit-blind a reason so numeric churn collapses: "inline JS is only 342
 * bytes" and "…511 bytes" both become "inline js is only # bytes", and
 * "stalled at 04:03" / "04:57" both become "stalled at #". Without this, a
 * model bouncing around the same defect would look like a different
 * failure every trial and never cluster.
 *
 * Lineage: the unit-aware numeric pass is lifted from `runner.ts`'s
 * private `retryLoopFailReasonKey`; the readable (un-hashed) output shape
 * is from `sniff-feedback.ts`'s private `normalizeFailReasonForSignature`.
 * Kept un-hashed here so the composed signature stays human-greppable.
 */
export function blindDigits(text: string): string {
  return (
    text
      .toLowerCase()
      // Blind every number but leave the surrounding words (including any
      // unit) as context: "…only 342 bytes" and "…only 511 bytes" both
      // become "…only # bytes"; "04:03"/"04:57" both become "#:#"; "5/7"
      // and "6/7" both become "#/#".
      .replace(/\d+(?:\.\d+)?/g, '#')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * A cell-relative failure identity, or `null` when the trial must never
 * cluster:
 *  - passes (nothing to triage), and
 *  - operator interrupts (a human Ctrl-C is not a repeatable *cell*
 *    defect — clustering on it would let a triple-SIGINT skip a cell).
 *
 * For real failures: non-`model-default` classifier rules are already
 * discriminating (`capacity-denial`, `spawn-error`, `context-overflow`,
 * `engine-hung`, `daemon-crash`, `render-killed`, `chat-template-500`,
 * `scheduler-voorman-deadlock`) — the rule *is* the signature. The
 * catch-all `model-default` is undifferentiated, so it is refined with
 * the near-miss sniff identity (`finalSniff.key` + digit-blinded
 * `failReason`) so distinct model misses don't all collapse together.
 * `score` and the runtime pass/fail counts are deliberately excluded —
 * they churn like byte counts and would *under*-cluster the same defect.
 */
export function trialSignature(result: TrialResult): string | null {
  if (result.success) return null;
  if (result.failureClass === 'operator' || result.failureMode === 'interrupted') return null;

  const cls: FailureClass = result.failureClass ?? 'model';
  const rule = result.failureClassRule ?? 'model-default';
  if (rule !== 'model-default') return `${cls}/${rule}`;

  const sniff: TrialFinalSniff | undefined = result.finalSniff;
  const key = sniff?.key ?? 'no-sniff';
  const fail = blindDigits(sniff?.failReason ?? '');
  return `${cls}/${rule}#${key}#${fail}`;
}

/**
 * Scan trial results (in push order) for the first maximal run of
 * identical non-null signatures with length ≥ k, and describe it. Returns
 * `null` when no such run exists. This is the single source of the
 * cluster's *shape*; the live streak in `runBatch` only decides *when* to
 * stop, and the two agree because both mean "consecutive identical
 * non-null signature ≥ k in push order."
 */
export function detectTriageCluster(
  results: readonly TrialResult[],
  k: number,
  ctx: { stopped: boolean; requestedCount: number },
): TriageCluster | null {
  if (k <= 0) return null;

  let runSig: string | null = null;
  let runStart = 0;
  let runLen = 0;

  for (let i = 0; i < results.length; i++) {
    const sig = trialSignature(results[i]!);
    if (sig !== null && sig === runSig) {
      runLen += 1;
    } else {
      if (runSig !== null && runLen >= k) break;
      runSig = sig;
      runStart = i;
      runLen = sig === null ? 0 : 1;
    }
  }
  if (runSig === null || runLen < k) return null;

  const members = results.slice(runStart, runStart + runLen);
  const rep = members[0]!;
  return {
    signature: runSig,
    count: runLen,
    k,
    stopped: ctx.stopped,
    skipped: ctx.stopped ? Math.max(0, ctx.requestedCount - results.length) : 0,
    representativeReason: rep.reason,
    ...(rep.failureClass ? { failureClass: rep.failureClass } : {}),
    ...(rep.failureClassRule ? { failureClassRule: rep.failureClassRule } : {}),
    ...(rep.failureClassEvidence ? { representativeEvidence: rep.failureClassEvidence } : {}),
    ...(rep.finalSniff ? { representativeSniff: rep.finalSniff } : {}),
    trialIds: members.map((m) => m.trialId),
  };
}
