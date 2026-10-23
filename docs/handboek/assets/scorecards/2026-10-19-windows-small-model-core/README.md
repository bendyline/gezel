# October 2026 Windows small-model core evaluation

All 264 requested trials are accounted for: **182 passes, 70 model failures,
and 12 infrastructure exclusions**. Eight models each attempted the 11 core
scenarios three times. Every trial was reviewed; no judging remains pending.
The campaign ran October 20–22 UTC (its original local run date was October 19).

## Files and consumers

- [scorecard.json](scorecard.json) is a `ScorecardDatasetSchema` v1 dataset
  containing three explicit runtime rounds. The matching files in `runs/`
  are registered in `packages/core/src/scorecard/data/runs/`. Import the
  combined file or the shards, never both.
- [scorecard-details.json](scorecard-details.json) contains the 264 unique
  trial records, exact advisory axes and justifications, per-journal quality
  and performance summaries, provenance, and evidence hashes.
- [verification.json](verification.json) reconciles the counts and exclusions.
  [manifest.json](manifest.json) records publication-file hashes and the
  reproducible import/check commands.

Gezel's Handboek and public-site exporter read the same registered dataset.
The exporter copies this download directory into the site's assets. The
separate Gilde catalog is not the scorecard's data owner. These files prepare
the results for the next app build and site export; they do not deploy either.

## Comparison boundaries

| Round | Requested cells represented | Context and scope |
| --- | ---: | --- |
| Original runtime (A) | 49 | Seven models, first seven scenarios once each, observed 65,536 tokens and one slot; a subset |
| Corrected runtime continuation (B) | 182 | The same seven models, all 11 scenarios, observed 65,536 tokens and one slot; two repeats of the first seven and three of the last four |
| Nanbeige rerun (N1–N12) | 33 | All 11 scenarios three times, 32,768 tokens, one slot, f16 KV; identical verified runtime across preserved continuation journals |

A and B have different runtime content hashes and remain separate rounds.
Their individual cells do not support a three-repeat percentage, so the
reader shows counts. Nanbeige has 12 passes, nine model failures and 12
context-overflow infrastructure exclusions. Some of its scenarios have no
attributable trials; the existing reader withholds its full-suite score and
names it as unmeasured. Its complete trial accounting remains in the download.
Neither exclusions nor deterministic outcomes were reclassified for publication.

Imported coverage rows are counted once. Seven historical Nanbeige 64K trials
and one operator-interrupted Qwen attempt remain diagnostic evidence outside
these 264 cells. They are not added to scorecard denominators.

## Judging

There are **254 artifact reviews**: 247 eligible for advisory aggregates,
six infrastructure diagnostic reviews and one review with a protocol
deviation. Ten trials produced no artifact and have no invented score.
The protocol deviation was an original Saluki petshop review with 21,664
input bytes, 1,184 over the combined 20 KiB cap. Its advisory score is
excluded; its deterministic pass is unchanged.

The four frozen rubrics cover HTML, code, data and documents. Each retains
its original integer axes, mean, justification, input size and limitations.
The judge identity is `codex-inline/current-session`; model identity was
known during review. `judging.aggregatesByJournalModelRubric` preserves
sample counts and exact rubric boundaries. The scorecard's **Artifact reviews**
table shows separate HTML, code, data and document means with sample counts
for each journal. Missing artifacts and excluded reviews have separate counts.
The companion contains the exact axes and justifications. No combined quality
score is calculated across rubrics.

Some early reviews did not record contemporaneous artifact hashes. The
publication audit verifies the retained files today; it cannot establish
historical bytes where no earlier hash exists. `verifiedAgainstRecorded`
preserves that distinction. Evidence paths are repository-relative archive
references, not downloadable raw transcripts or artifacts in this package.

## Performance and memory

The scorecard's **Task performance** table shows native engine-log output
and prefill rates, wall time, peak system RSS and peak GPU memory. Each value
is a per-trial median with its minimum, maximum and sample count, grouped by
journal and model. All attempted trials contribute available observations,
including failures. These are not paired admission probes. Wall time includes
tools and other task work. System RSS excludes GPU allocations; their medians
must not be added together. Exact per-trial observations remain in the companion.

This was a Windows laptop with a Ryzen AI 9 HX 370, an RTX 5070 Ti Laptop GPU
(12,227 MiB reported VRAM), and approximately 31 GiB system RAM. The native
engine was CUDA build 11669, revision `620d2225`.

Hardware performance varied substantially. N1–N2 ran on October 20.
N3–N4 ran during October 22's restricted period; samples showed a 33 W GPU
power cap and 810 MHz memory clock. N5 spans a throughput increase after
14:00 UTC without operator changes; N6–N12 ran afterward. Neither a uniform
speed ranking nor a cause for the recovery is established by these results.

Nanbeige's 32K GPU fit was verified with all 45 effective layers offloaded:
about 2,282 MiB of weights, 5,632 MiB of FP16 KV, and 8,208 MiB board usage.
Its repeated blocks require more KV memory than its 3B parameter label
suggests. Allow roughly 10 GiB of free GPU memory for this 32K single-chat
configuration; this is headroom guidance from this device, not a guarantee.
Its context-overflow failures were not GPU out-of-memory failures.

## Reproducing publication

From the Gezel checkout containing the retained evaluation archive:

```sh
node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-small-model-core-scorecard.mjs
node scripts/run-with-dependency-lease.mjs --direct-node scripts/gen-scorecard-barrel.mjs
node scripts/run-with-dependency-lease.mjs --direct-node scripts/import-small-model-core-scorecard.mjs --check
```

The importer pins the final report's SHA-256, checks its evidence hashes and
original result/score classifications, validates the normal scorecard schema,
and rejects duplicate cells or machine-local paths. It makes no inference
calls, edits no original evidence and changes no scores or gates.
