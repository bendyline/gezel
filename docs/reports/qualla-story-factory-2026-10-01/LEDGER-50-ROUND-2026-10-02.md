# The 50-article ledger round — October 2, 2026

**Written for the Qualla/Gezel owner. Continues `LEDGER-METHOD-2026-10-02.md` in this folder.**

## Outcome

Round `dp0-ledger50-20261002` (Gemma 4 31B in every role, one GPU) was wound down after
about 14 hours with **11 stories published to `overlays/stories/`**, each through an
independent source audit. Of the 40 articles selected, 31 were attempted: 11 published,
18 blocked (almost all at 6/10 on the model editor's score), 2 interrupted mid-article,
and 9 never started. Everything is resumable:

```powershell
$env:NODE_OPTIONS = '--import tsx'   # see "Open item" below
node pipeline/story-batch/background.mjs --ledger dp0 round=dp0-ledger50-20261002 resume=true
```

| Published story | Model score | Claims supported before audit | Material errors fixed | Auditor prose |
| --- | ---: | ---: | ---: | ---: |
| Sand Ridge State Forest | 7 | 38/40 | 1 | 6 |
| Postville Courthouse | 7 | 50/55 | 0 | 6 |
| Sangamon Ordnance Plant | 7 | 50/57 | 1 | 5 |
| Hubbard House | 7 | 36/40 | 2 | 7 |
| Motion Raceway | 7 | 47/50 | 0 | 7 |
| Decatur Station | 8 | 43/48 | 1 | 7 |
| C. H. Moore House | 7 | 54/61 | 5 | 6 |
| McLean County Courthouse | 7 | 52/66 | 6 | 6 |
| Transfer House | 7 | 42/43 | 0 | 6 |
| Moultrie County Courthouse | 6.5 | 48/61 | 5 | 5 |
| Lincoln Depot | 6.5 | 53/57 | 2 | 6 |

Before the audit, **88% of claim units were supported** and the pipeline still let
through about **2 material errors per story** (23 in total); every one was corrected
before publishing. The audit is doing real work, not rubber-stamping.

**Why not 50.** Two limits, both measured:

- **Prose, not facts, blocks most stories.** The model editor scores 13 of 16 first
  drafts 6/10. Re-scoring five "draft 7, final 6" stories at every stage showed no
  consistent culprit: a single score moves ±1 on the same text. A published story as
  an in-prompt exemplar changed nothing (12/12 drafts scored 6), and a second rewrite
  round converted 0 of 3. What predicts a pass is the subject: forts, plants,
  courthouses with events pass; parks, settler roll calls and NRHP-listed houses don't.
- **Throughput.** About 14 model-minutes per article on one slot, so 50 published at a
  roughly 35% yield is ~140 attempts, ~35 engine-hours. dp3 (Chicago, 2,252 eligible
  articles) and the stricter selection prompt are the way to raise yield.

## What changed in Gezel (uncommitted)

| Change | Why |
| --- | --- |
| Structured one-shots exempt from the ramble detector (`outputIsConstrained` in `core/local-loop/ramble-detector.ts`; llama-cpp, MLX, Ollama) | The repetition guard read a fact-check's repeated JSON object shape as a loop and aborted a healthy 6.8 KB answer, surfacing as an opaque 500. A test reproduces the false fire. |
| Completions route waits out `EngineBusyError` / `CapacityDeniedError` (15 s polls, capacity at most 2 min, never `resident-below-minimum`), then 409 `engine_busy` / `capacity_denied`; loop aborts become 422 `output_aborted` | After a restart the night shift loaded muse-glimmer-30b while the capacity budget was still the pre-measurement 41 GB; Gemma was denied and the workflow saw three opaque 500s. |
| `fetch_url` and the Wikipedia/search routes answer network failures with fixed codes (`upstream_timeout` 504, `upstream_unreachable` / `upstream_tls_failed` 502) that the opaque-error middleware lets through; the MCP tool explains each | A dead link was redacted to `internal_error` and logged as a daemon fault. |

Tests: 45 service route/middleware tests, 876 core local-loop tests, Ollama 20, MLX 281;
service and core typecheck clean; Biome clean.

## What changed in Qualla (uncommitted)

- **Checking:** a narrow *link check* (each risky "supported" claim judged against only
  its cited source words, with the ledger's date); deterministic *number conflicts*
  (sizes that related sources disagree on); dropped-qualifier detection. Calibration:
  known problems caught 8/15 → 14/15, controls accepted 18/19 either way.
- **Writing:** thesis/irony lines are cause claims; keep limits and hedges; skip
  regulations; two drafts per plan, the editor's favourite revised; the summary is
  rewritten and checked if lost; a sentence left dangling by a deletion is repaired;
  a story checked under the length floor gets one expansion (its own budget); a story
  one point under the bar gets a second score and the mean decides.
- **Driver:** selection is told the 125 subjects other rounds hold and that NRHP
  listings or amenity lists are not stories; the ledger gets the subject's identity
  (the Kingston Mines blues club in Chicago had leaked into the village's story);
  `reverify`, `rewriteRounds` on resume, transient failures never supersede a staged
  story; a check-cache bug that crashed Lincoln Depot is fixed.
- **Promotion:** `pipeline/story-batch/ledger-promote.mjs` publishes a staged story only
  with an independent audit of its exact bytes in `audits/<id>.json` whose corrections
  resolve every material defect; `check=true` dry-runs it. It never writes `round.json`,
  and the driver never re-stages a promoted story. Operator guide: `docs/story-ledger.md`.

Tests: 41 ledger tests (run with `node --import tsx --test`).

## Open item

Someone changed `pipeline/processors/CatalogManager.ts` to import
`./CatalogRelocation.js` (the file is `CatalogRelocation.ts`, untracked). That resolves
under tsx but not under plain Node, which is how the Gezel CLI loads workflow modules,
so `gezel do qualla-story-ledger` and `gezel workflow …ledger-promote.mjs` fail until it
is fixed. I left it alone and ran under `NODE_OPTIONS=--import tsx`.

## The general lesson

Every material error the audits found was a model *embellishing* what it retrieved —
an invented cause, a dropped qualifier, one source's number picked silently, a sentence
that reads as the wrong place — never a missing lookup. Prompts that forbid each of
these by name did not stop them. What worked was moving judgments into narrow,
checkable steps: verbatim quotations confirmed by code, claims judged against only
their own cited words, deterministic checks on numbers, and a final independent audit.
That is the basis for the grounding discussion that follows this round.
