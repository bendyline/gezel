# Zero-prompt leg 2: eval evidence

Updated 2026-10-08T21:58:05+00:00.

The reliability gate is **not yet met** until every starter records at least 2 passes in 3 trials on both reference models. Diagnostic trials are excluded. This report records measured results only; a running or unrun cell is not a pass.

## Method

Both reference models use MLX and the already installed files under `/Users/mike/.gezel-dev`. Runs use `GEZEL_GILDE_DATA_DIR=/Users/mike/gh/gilde/data`, three strict trials, one heavy trial at a time, a 30-minute ceiling per workflow, and `--write-reports`. The global eval device lock stays enabled. Gemma runs first; Qwen starts after its complete matrix. No external judge API is used.

Each sidecar now executes the real craftbook task, requires terminal completion, and checks the actual saved deliverables. DocBlocks is simulated: DOCX/PPTX/PDF fixture conversion exercises the orchestration and container checks; MP4/GIF fixtures contain valid short test media. These runs do not prove native rendering, layout, audio, or full playback quality. A real-converter smoke test remains a separate follow-up.

## Results

| Plan | Version | Gemma passes / finished | Gemma wall times (min) | Qwen passes / finished | Qwen wall times (min) |
| --- | --- | --- | --- | --- | --- |
| research-report | 1.0.4 | 0 / 1 (running) | 46.4 | 0 / 0 (pending) | — |
| research-to-document | 1.2.8 | 0 / 0 (pending) | — | 0 / 0 (pending) | — |
| powerpoint-deck | 1.7.18 | 0 / 0 (pending) | — | 0 / 0 (pending) | — |
| report-pdf | 1.1.8 | 0 / 0 (pending) | — | 0 / 0 (pending) | — |
| branding-website | 1.1.4 | 0 / 0 (pending) | — | 0 / 0 (pending) | — |
| narrated-slideshow | 1.1.8 | 0 / 0 (pending) | — | 0 / 0 (pending) | — |

## Trial records

| Model | Scenario | Outcome | Seconds | Evidence |
| --- | --- | --- | --- | --- |
| gemma4-12b-q4 | craftbook-research-report | retry loop (fast-path): sniff "craftbook-research-report:15:targetnone:fr17ta1da:rp0:rf0:m8" stuck for 16m — 3 re-writes (21 tool calls) without sniff movement. Artifact produced but never reached success. | 2785.8 | [postmortem](../../evals/runs/zero-prompt-leg2-gemma-2026-10-08-v2/craftbook-research-report/craftbook-research-report-mlx-gemma4-12b-q4-2026-10-08T20-52-34-648Z-83jb/postmortem.md) |

## Diagnostic findings and fixes

- Qwen initially failed before inference because install catalog version 1.0.4 differed from 1.0.5 despite matching file hashes. The harness now permits this exact multi-file match across a metadata release, while retaining conservative behavior for partial or changed records. Same-version installs retain support for the installer’s sanctioned chat-template rewrites. Regression tests cover both cases.
- The first Qwen workflow was interrupted after 555.4 seconds: its inherited one-brief fixture contradicted the workflow’s minimum of five independent sources and offline constraint. No final report existed. The sidecar now supplies a brief plus five independent local operational records and requires their citations. This invalid diagnostic is excluded from the pass counts.
- Gemma produced a report meeting 15/16 deterministic checks, but both reviewer activations marked every criterion PASS and then omitted the routing argument. The plan safely looped back to writing. This diagnostic was interrupted after 797.0 seconds. Core tool guidance and task context now explain configured default routes and explicit branch selection; the repair loop and completion gates remain unchanged. Fresh matrices use the v2 run directories.
- PDF and slideshow previously checked Markdown only. Their new sidecars exercise conversion, preview, save, binary signatures and terminal task completion. Missing inspection/report tools were added to the deterministic mocks.

## Advisory review

Inline qualitative reviews, when available, are stored separately as `codex-inline-judge.json` in each run directory. A missing review means pending, not a quality pass. The Qwen fixture diagnostic had no final artifact. The Gemma routing diagnostic report scored 6/10 on each declared axis (grounding, structure, completeness, tone): facts and caveats were faithful, but references leaked a tool instruction and crowded sources into one paragraph; actions lacked priority. Its review is stored with the diagnostic trial in zero-prompt-leg2-gemma-2026-10-08.

## Reproduce

Run once for each model shown below, sequentially:

```sh
GEZEL_GILDE_DATA_DIR=/Users/mike/gh/gilde/data pnpm eval:all \
  --count 3 --count-strict --no-triage \
  --scenarios craftbook-research-report,craftbook-research-to-document,craftbook-powerpoint-deck,craftbook-report-pdf,craftbook-branding-website,craftbook-narrated-slideshow \
  --provider mlx --model gemma4-12b-q4 \
  --source-home /Users/mike/.gezel-dev --timeout 30m --write-reports
```

Use `--model qwen3.8-27b-q4` for the second model. Keep core/client dist and Gilde sidecars unchanged during the runs.

Implementation details and the unpublished version inventory are in [the launch audit](zero-prompt-leg-2-audit.md).
