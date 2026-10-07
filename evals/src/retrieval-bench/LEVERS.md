# Retrieval-bench levers

The retrieval bench (`pnpm --filter @bendyline/gezel-evals run retrieval-bench`)
exists to decide these levers with numbers. Record each run here: date, arm,
labels hash, and the headline figures. `report.md` in the run directory has
the full table.

## Levers

| Lever | Where | Today |
|---|---|---|
| Per-kind injection floors | `INJECTION_MIN_RELEVANCE`, `packages/service/src/search/project-retrieval.ts` | Behaviour-preserving quotients of the old absolute floor; rank-derived relevance means they only reject empty arms |
| Keyword grounding | `isGrounded`, same file | FTS hits must name a query term in the injected text |
| Knowledge caps | `KNOWLEDGE_MAX_CHUNKS`, `KNOWLEDGE_TOKEN_SHARE` | 2/2/4 chunks; 25/25/35% of the turn budget |
| Knowledge vector floors | `KNOWLEDGE_VECTOR_FLOORS`, `packages/service/src/knowledge/vector-floors.ts`; `GEZEL_KNOWLEDGE_VECTOR_FLOORS` | Handboek 0.65, bge-small default 0.55, multilingual-e5-small 0.865, embeddinggemma-2-512 0.735; unjudged catalog hits need `vector` (KNOWLEDGE-CALIBRATION-2026-09-30.md; gemma in MEDIA-BENCH-2026-10-06.md) |
| Knowledge relevance bar | `KNOWLEDGE_FILTER_MIN_RELEVANCE`, `packages/core/src/search-ranking.ts`; `GEZEL_RELEVANCE_KNOWLEDGE_KEEP` | 0.5 on filter surfaces, above the general keep 0.3 (KNOWLEDGE-CALIBRATION-2026-09-30.md) |
| Catalog fusion | `ARM_WEIGHTS`, `RRF_K`, `packages/service/src/knowledge/manager.ts` | vector 1, doc FTS 1, chunk FTS 0.5; k=60 |
| Reference-list grounding | `gatherTaskReferences`, `packages/service/src/tasks/references.ts` | Lexical: title/path/snippet must name a subject term outside the book's name |
| Relevance model and threshold | `packages/service/src/relevance/registry.ts`, `search/relevance-stage.ts` | `ms-marco-minilm-l6@1` calibrated: drop 1e-5, keep 3e-5, strong 0.95 (RELEVANCE-CALIBRATION-2026-09-26.md); logit-space mapping between drop and strong; on for new installs since 2026-09-30 |

## Run log

| Date | Arm | Mode | Labels | Turn FIR (strict) | Turn nDCG@5 | Refs set precision | Turn p95 | Notes |
|---|---|---|---|---:|---:|---:|---:|---|
| 2026-09-26 | baseline | balanced | 0071356c3eb68f10 | 1.00 | 0.82 | 0.51 | 17 ms | Pre-model baseline. Turn keeps something for 100% of every class, including absent and step-prose (abstention bal. acc. 0.50); turn set precision 0.64. References abstain on 42% of absent subjects (FIR 0.58), decoy item share 0.15. Ran on the pre-rename corpus (family 1 was "Halvard"; renamed "Rasmund" to avoid clashing with the powerpoint-sources scenario), so the next run carries a new labels hash. Run dir: `evals/runs/retrieval-bench-2026-09-26T17-18-51-027Z`. |
| 2026-09-26 | off / raw | balanced | 259a61bbaafc9c49 | 1.00 / 1.00 | 0.82 / 0.84 | 0.53 / 0.55 | 17 / 63 ms | First relevance-model run. Uncalibrated MiniLM only reorders: search nDCG@5 0.79 → 0.87 dev, references 0.85 → 0.95 dev; AUC 0.90–0.96. Offline sweep put the useful keep cut near 1e-4. Run dir: `evals/runs/retrieval-bench-2026-09-26T20-03-41-429Z`. |
| 2026-09-26 | t=1e-5/3e-5/0.5 (chosen) | balanced | 259a61bbaafc9c49 | 0.42 dev / 0.50 test | 0.83 dev | 0.64 dev | 25 ms (cached) | Live confirmation of four cuts; keep 3e-5 chosen: test Δ false injection −0.50 [−0.67, −0.17], Δ strict R@5 −0.05, Δ set precision +0.11. Search untouched at drop 1e-5. Run dir: `evals/runs/retrieval-bench-2026-09-26T20-10-35-372Z`; record: RELEVANCE-CALIBRATION-2026-09-26.md. |
