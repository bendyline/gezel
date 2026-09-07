# Gemma thinking-budget investigation — 2026-09-07

**Finding:** Gezel's 96-token Gemma thinking cap can end the reasoning channel
inside a sentence, exposing its continuation as ordinary chat text. The reported
31B incident has direct runtime evidence; historical E4B conversations show the
same visible symptom. **Budget selection remains pending controlled results.**

## Reported conversation and cause

The September 7 debug bundle identifies `gemma4-31b-q4`, llama.cpp, session
`005102b2-38e2-4081-aa25-3d10652b33e5`. Its saved reasoning ends “without using
tools (” and the visible reply begins “as requested).”, then continues internal
planning. The engine launch records `reasoningBudgetTokens: 96` from the catalog.

The actual native revision is
`5266f24da75dc449bd56cbed7addb9c8e4a6a73e` (v0.4.0 / build 10809; see the
[source pin](../../native/engines/llama-cpp/VERSION)). Its
[reasoning-budget sampler](https://github.com/ggml-org/llama.cpp/blob/5266f24da75dc449bd56cbed7addb9c8e4a6a73e/common/reasoning-budget.cpp)
forces the closing sequence when the token counter expires; it does not wait for
a sentence boundary. Generation continues after that forced channel close.

Google's [Gemma 4 prompt-formatting guidance](https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4#tip-adaptive-thought-efficiency-using-system-instructions)
documents thinking as an on/off feature. It describes an optional “LOW” system
instruction as a proof of concept, with approximately 20% fewer thinking tokens
observed in testing; it does not recommend a hard 96-token limit. The implication
is that llama.cpp's budget is a framework-enforced cutoff, rather than a
documented Gemma reasoning-effort level. System instructions remain unchanged in
this budget-only campaign.

The daemon subsequently requested a recovery pass at **21:22:14 UTC**. The engine
was released for memory pressure at **21:22:19 UTC**, after generation completed;
that later eviction explains additional waiting, not the earlier sentence split.
Primary local evidence is the saved session and September 7 logs under
`C:/Users/party/.gezel-dev/`; the original incident has not been modified.

## Catalog and historical evidence

| Catalog models | Base thinking tokens | Profile behavior |
|---|---:|---|
| Gemma 4 E2B, E4B, 26B, 31B Q4 | 96 | Every profile inherits the base cap |
| Gemma 4 12B Q4 and Q8 | 256 | Every profile inherits the base cap |
| DeepSeek R1 8B Q4 | 512 | General/coding/precise explicitly repeat 512 |

These are the only seven manifests below 1,024 tokens. The 31B value is explicit
in Gilde's root manifest, preserved by normal authoring rebuilds, and present
since its initial content import. No 31B-specific experiment establishing 96 as
optimal was found. DeepSeek's [recorded unrestricted-thinking failure](../../packages/catalog/src/chat-model-manifest-lint.ts)
supports a finite cap, not a claim that 512 is the best finite value.

The [historical audit](../../evals/runs/thinking-budget-2026-09-07/historical-audit/README.md)
manually reviewed 22 non-synthetic 31B messages, 29 for 26B, and a balanced sample
of 30 E4B messages from completed core matrices. It found **two explicit E4B
continuations across channels**: one completed an unfinished sentence about tool
availability; another completed a gezel ID and continued internal handoff
commentary. No such continuation was confirmed in the sampled 31B/26B saved
messages. Unfinished thinking alone was not classified as forced closure, and
persisted messages can conceal intermediate stream behavior.

Historical core results were 31B **9/11**, 26B **9/11** (August 27), and E4B
**10/11** (September 6). These are regression references, not budget comparisons.
Earlier E4B postmortems proposed both decreasing 96 to 64 and increasing it to
192; neither proposal supplies controlled evidence for an accepted setting.

## Runtime correction

The pinned server also accepts per-request `reasoning_budget_tokens`, but Gezel's
[llama.cpp tuning map](../../packages/service/src/model-profile/tuning.ts)
discarded this field. The working change now forwards resolved profile/user
budgets, records the effective request budget, preserves explicit experiment
overrides, and excludes the incompatible DS4 request path. This correction makes
the requested budget measurable while engines are shared; it does not itself
select a larger catalog default. Tests cover inheritance, explicit user overrides,
the experiment environment override, preload and generation requests, diagnostic
logging, and the DS4 exclusion.

## Experiment method and exclusions

The [session-level harness](../../evals/src/bin/ab-thinking-budget.ts) compares
finite caps with paired seeds, a common 16,384-token total output ceiling, and a
fresh session for every cell. Each model stays resident across its comparisons.
The ten broad probes cover simple answers, arithmetic, logic, code explanation,
actual code repair, grounded summaries, constrained writing, probability,
scheduling, and actual file writes. An eleventh probe replays the original
Issaquah follow-up context. Sampling, prompts, tools and model behavior settings
are held constant within each comparison. Experiments started only after the
existing E4B core suite finished, as requested.

The campaign uses the
[isolated runtime](../../evals/runs/thinking-budget-2026-09-07/runtime-provenance.json)
and the same native upstream revision as the incident, on an AMD Radeon AI PRO
R9700 through Vulkan. All paired arms use f16 KV cache; the original incident
used q8_0. The follow-up is a diagnostic replay with fresh assistant/project
identity, not a byte-identical reconstruction. Each run records the harness hash,
runtime entry and native revision, and validates the actual request budget.
Native traces distinguish forced closure from a natural reasoning end. The
natural-end trace does not report consumed reasoning tokens, so reasoning
character counts are not presented as token counts.

The following exclusions matter:

- The initial `31b-scout` failed before inference because the installed broker
  lacked the newer native-capacity endpoint. Later runs use explicit local
  capacity authority with the shared resource ledger, live capacity checks and
  device lock still active; the installed broker was idle and was not modified.
- `31b-scout-local` omitted its project workspace-write grant. Its tool tasks
  cannot measure edit success. Its arithmetic comparison remains informative:
  96 forced a close and exposed a malformed answer with checking notes, while
  2,048 ended naturally and gave a clean, correct answer.
- The first E4B broad code-explanation pair triggered the framework's
  `prose-deliverable` recovery despite an explicit no-tools request. An unexpected
  `report.md` from the first arm also reached the next arm's workspace context.
  Exclude that pair from comparative task-quality conclusions. The harness now
  clears the entire owned workspace before each arm, including unexpected files.
- The first 26B launch failed loading the MTP draft with `invalid vector
  subscript`. The replacement run disables speculative decoding in both arms;
  the main model and native revision are unchanged. This is an infrastructure
  limitation, not a failed budget trial or a proposed catalog engine change.
- 26B's code-explanation recovery wrote a project artifact. It remained accessible
  to the next arm, although no artifact listing/content appeared in that arm's
  prompt and it made no tools. Treat this pair as potentially contaminated and
  framework-confounded. Subsequent refinement also resets project artifacts.

Smoke gates are supplemented by manual review of visible answers, tool results
and recovery logs. In particular, a response that opens with a wrong result and
later corrects itself can pass a substring gate. The Issaquah gate only detects
a nonempty topical reply: a pass is not evidence of a substantive fact expansion.
The replay retains the earlier conversation text but omits original tool records;
26B at 2,048 consequently inferred that an earlier promised write had not happened.
This limits interpretation of differences in replayed file actions.
This is a targeted budget investigation, not a full tuning scorecard or a
measurement of factual knowledge. The
[campaign plan](../../evals/runs/thinking-budget-2026-09-07/PLAN.md) describes the
acceptance criteria.

## Controlled results

All three broad runs completed 11 paired probes using seed 0, or 66 cells. The 96-token cap
forced a reasoning close in **28 of 33 cells**, versus **0 of 33** at 2,048.
Every cell's actual request budget was verified. Forced closure alone is not a
task failure: several small-budget answers remained correct and clean.

| Model | Cells with a forced close, 96 | Cells with a forced close, 2,048 | Median seconds, 96 → 2,048 |
|---|---:|---:|---:|
| E4B Q4 | 9/11 | 0/11 | 5.0 → 7.1 |
| 31B Q4 | 9/11 | 0/11 | 58.7 → 60.7 |
| 26B Q4, speculation off | 10/11 | 0/11 | 5.1 → 10.1 |

The E4B broad comparison completed all 22 cells. At 96 tokens, 9 of 11 cells
encountered a forced close (11 forced reasoning ends across 15 requests); at
2,048, every reasoning end was natural (17 requests). Manual inspection found
three substantive defects in the small-budget arm that were absent in its paired
large-budget arm: a falsely claimed code edit, an 80-word email despite a 70-word
limit, and a probability answer with a wrong opening result followed by exposed
self-correction. The probability gate incorrectly passed that mixed answer.
The larger-budget email was 61 words, the code was actually edited correctly,
and the probability answer was correct throughout.

Both E4B Issaquah replies remained clean but supplied no fact expansion or file
edit. The larger cap allowed a natural reasoning end without resolving the
research task.

31B's scheduling response at 96 opened with the wrong time, 10:00, exposed a
recalculation and then correctly ended with 9:55. At 2,048 it consistently
answered 9:55. Both code-repair arms made the correct edit; both original-context
arms actually expanded `Issaquah.md`, with factual truth unverified. The 96
code-explanation failure came from a framework recovery requesting an unasked-for
report, after an initially correct answer; the 2,048 arm needed no recovery.

26B at 96 incorrectly calculated `131 - 76` as 59. Its scheduling answer opened
with 09:50, exposed a recalculation, and ended with the correct 09:55. Both paired
2,048 answers were consistently correct. Both budgets actually repaired the code
and met the email constraints. Only the larger-budget follow-up wrote an expanded
`Issaquah.md`; the replay caveat above prevents a knowledge-quality conclusion.
These distinctions matter: answer correctness,
visible deliberation and direct continuation across channels are separate
observations. None of the broad-run visible self-corrections is independently
proven to be a grammatical continuation of its reasoning channel.

Timings include framework and tool work, and one-time startup affects the first
cell. The 31B comparisons repeatedly reprocess roughly 11,000 prompt tokens,
dominating latency. A larger thinking budget is a ceiling, not a requirement to
consume all of it. These timings do not establish general performance ratios.

The E4B refinement repeated code repair, constrained writing, probability and
logic with three fresh paired seeds (1–3) and budgets 96, 512 and 2,048: 36 cells.
Manual task passes were **8/12, 10/12 and 11/12** respectively. These are small
diagnostic samples, not estimates of general accuracy.

| E4B refinement | 96 | 512 | 2,048 |
|---|---:|---:|---:|
| Cells with a forced close | 12/12 | 9/12 | 0/12 |
| Manually clean visible output | 10/12 | 11/12 | 12/12 |
| Direct continuation across channels | 1 | 0 | 0 |
| Task passes | 8/12 | 10/12 | 11/12 |

The decisive boundary reproduction was seed 3's code-repair task: 96 ended
thinking inside a function signature, and the visible reply continued that
signature and internal planning. The 2,048 pair made a correct edit and gave a
clean answer. Seed 2's probability answer remained inconsistent even at 512,
opening with the wrong fraction before correcting itself; 2,048 was correct
throughout. All nine final code artifacts passed an additional 196-case
integer-range oracle, but some lower-cap runs needed recovery after malformed
tool requests or false completion claims. Final file correctness does not erase
those earlier defects.

One seed's email exceeded 70 words at both 512 and 2,048, with identical natural
reasoning and output. More allowance does not guarantee constraint compliance.
Some correct `replace_lines` edits also triggered a false unsaved-file-claim
recovery and an unnecessary rewrite; that is a separate framework defect,
not evidence that the model failed to edit.

An independent eight-topic scheduling holdout is checked against an exhaustive
40,320-permutation oracle with exactly one solution. E4B's initial 512 and 2,048
schedules were both wrong, and both exhausted their budgets before answering.
The later forced report-write recovery violated the no-tools request, but does
not explain the already incorrect schedules. **In progress:** 31B/26B holdouts
and a paired 2,048/4,096 comparison wherever 2,048 still exhausts.

## Source changes and scope

The current candidate changes only the root Gemma E4B, 26B and 31B catalog
thinking budgets from 96 to 2,048, plus the generated chat-model index. All five
profiles per model inherit the base budget. Per-profile resolution checks verify
all 15 effective budgets reach the request, leave output room, and allow an
explicit 4,096-token user override to win. E2B, both 12B quantizations and
DeepSeek R1 8B remain unchanged because their weights were unavailable locally.
Other finite family defaults are mostly 2,048–8,192; there is no evidence here
for a blanket increase outside Gemma.

The separate runtime correction has a broader compatibility effect: it activates
28 previously ignored profile-budget differences across 22 llama.cpp models.
Most depend on coding/precise/deep profiles, including automatically suggested
role profiles. Nemotron3 Nano 30B's ordinary general profile is the exception:
its effective budget becomes the authored 4,096 instead of the launch base's
8,192. **These non-Gemma effects were not empirically validated in this campaign**;
no non-Gemma catalog values were changed. The full
[profile impact audit](../../evals/runs/thinking-budget-2026-09-07/profile-budget-impact.md)
separates this configuration-correctness change from measured Gemma calibration.

These are local source edits in Gezel and its sibling Gilde checkout. The bundled
`@bendyline/gilde` pin remains 0.1.60; no catalog package was published, no
dependencies were relinked, and no installed app/service was updated. The runtime
under test was built separately so ongoing development and installed services
were preserved.

## Validation and evidence

- 303 focused production tests passed for tuning, reasoning launch, llama.cpp and
  DS4 providers; service typecheck passed.
- 59 harness tests and the two isolated daemon-entry tests passed; evals typecheck
  and Biome passed.
- 16 catalog service tests passed against the candidate content, plus the 15
  effective-profile checks and user-override assertions.
- Gilde's schema validation (29,130 files), authoring, formatting, index,
  model-lint and page-demo checks passed. All 14 existing tool tests passed,
  including manifest assembly; semantic diff verification found only the three
  budget changes. This completes the direct equivalent of `npm check` without
  invoking its dependency installation step.

Raw runs, prompts, native traces, model outputs and manual sidecars are under
[`evals/runs/thinking-budget-2026-09-07`](../../evals/runs/thinking-budget-2026-09-07/).
The `summarize.mjs` helper reads immutable per-cell logs and recomputes recovery
counts; early `results.json` files used an incomplete recovery-marker detector,
so their stored zero counts must not be treated as proof of no recovery.
