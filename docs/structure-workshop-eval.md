# Building asset workflow probe

The project craftbook and compiler live in the sibling Molen checkout:
`../molen-internal/scripts/structure-workshop/README.md` (instructions) and
`../molen-internal/scripts/structure-workshop/EVALUATION.md` (measured results),
with paths relative to this repository root.
They are project-local content, not bundled Gilde templates.

The registered `molen-structure-workshop` scenario exercises preparation, fanout,
model-authored geometry, real textured GLBs, eight renders per model and visual repair.
`molen-structure-workshop-assets` prepares identical frozen reference inputs first to
separate research orchestration from modeling. Neither seeds geometry answers. Both
require the sibling Molen repository to be built; `MOLEN_REPO` overrides its location.

Two standalone prepared-input scenarios prevent the school from consuming the
landmark's whole budget:

| Scenario | Frozen request |
| --- | --- |
| `molen-structure-space-needle` | The existing Space Needle request and LOC photograph, unchanged |
| `molen-structure-football-stadium` | An original medium-size American football stadium, roughly 25,000-seat proportions, using a public-domain Commons photograph |

Both keep the real child task, textured GLB compiler, eight views, image-read
receipts and bounded visual repair. Their final gate requires exactly the seeded
asset IDs, so editing the request file to drop or substitute an asset cannot pass.
The stadium prompt and attributed image live in Molen's
`scripts/structure-workshop/fixtures/requests-stadium.json` and
`fixtures/references/football-stadium.PROVENANCE.md`.

The September 22 campaign retries Flash Next Q2/DS4 and Gemma 31B/MLX on the
original two-asset scenario after both approval fixes, then runs each standalone
scenario with those models, Qwen 27B/MLX and Muse Glimmer/llama.cpp. All ten local
trials have a 20-minute starting budget and run sequentially. The runtime repair
policy can extend recent deliverable progress in 15-minute increments, up to a
40-minute ceiling for these trials; retain the actual elapsed time and extension
log when comparing results. Muse's 512-token reasoning
cap is a per-run experiment, not a catalog tuning change. The live campaign
manifest, exact commands, fixed reports and autonomous outputs are under Molen's
`.artifacts/structure-workshop/model-comparison/september22/`; incomplete trials
remain incomplete, and any later operator compilation must be stored separately.

Validation for the new cases: four scenario input/output-gate regressions, eval
typecheck, four real compiler/import/material/review tests, and successful offline
preparation of the stadium reference (including its SHA-256 receipt).

The facts extractor reconciles per-session tool counts from completed transcripts
and project history, retaining native CLI tools and interrupted continuations
without adding duplicate observations. Older histories without session IDs supply
a conservative per-tool lower bound. This recovers the earlier Muse follow-up's
41 tools and 17 image reads; its separately recomputed fixed score is 2.8 instead
of 3.3 because the efficiency axis now sees every call. Original reports remain
preserved. The scoring rules and visual judgment are unchanged. The combined
facts, postmortem and standalone-scenario regression suite passes 33 tests.

The fixed-rubric score is not an independent art score. Inspect rendered output and
report visual judgment separately. Earlier trials completed files without delivering
images, and one image-complete frontier trial approved an unfinished rear facade.
The measured report distinguishes those failures from compiler and runtime failures.

## Image evidence for other craftbooks

`wikimedia_image_search` is in the builtin web toolset. It queries Commons file search
without a key and preserves source, credit and licensing metadata. External-research
policy and outbound-credential checks still apply. Results are untrusted reference data.

A completion gate can require images named by a workspace JSON manifest:

```json
{
  "at": "completion",
  "checks": [{
    "kind": "imageEvidence",
    "file": "asset/build.json",
    "imagesKey": "images",
    "baseDir": "asset"
  }]
}
```

For `{"images":[{"path":"revisions/2/front.png"}]}`, the model must successfully read
`asset/revisions/2/front.png` with `read_image_as_base64`. The gate requires every listed
path and fails closed without telemetry. It only counts workspace reads for the current
task and activation; stepwise workers also need the current step tag. Generalist
sessions can retain a previous bridge step tag across a repair edge, so the active
step's activation timestamp scopes their receipts. No previous activation, other task,
failed read or artifact-drawer read can substitute. Use immutable revision paths and
separate hash checks when content freshness matters.

This proves image delivery, not correctness of visual reasoning. Keep technical validity,
image delivery and aesthetic judgment as separate requirements.

## MLX image handoff

MLX previously returned image-tool text while discarding its pixels. A successful
read receipt could therefore not establish perception. `MlxProvider` now preserves
successful tool images and user attachments. Its Python engine loads the full installed
vision tower when native vision is enabled and the checkpoint has a vision configuration.
The bound provider/session advertises actual image support; a text-only session refuses
image reads before recording a successful tool receipt.

Vision requests decode only bounded in-memory PNG/JPEG/WebP inputs and preserve image
placeholders in their owning messages. They use a separate uncached generation path.
A shared generation lock isolates the model's multimodal position state from text batch
waves; no image KV prefix is reused as text. Text prewarming skips image histories.
This prioritizes correct delivery over throughput: long visual tool loops re-prefill
history and do not currently use speculative decoding.

The inference-only remote wire preserves image history after local tool/result pairs.
Such requests opt into protocol version 2; ordinary text retains version 1 compatibility.
Old brokers reject version 2, and a current broker rejects engines without explicit image
support. The broker receives pixels, never workspace access or tools. Automatic pasted
image routing through remote admission metadata is not expanded by this change.

Validation includes synthetic image recognition on the installed Qwen checkpoint, an
actual service/MCP/provider image read, text after vision, concurrent text/image requests,
and unit/real-service regressions for the remote continuation path. Probe fixtures and
results are under Molen's ignored `.artifacts/structure-workshop/vision-handoff/`. Older
Qwen workshop runs must be marked framework-invalid for visual capability assessment;
only a rerun with this handoff can test image-informed modeling.

The llama.cpp tool loop needs the same delivery guarantee. With a loaded projector,
it now appends rich MCP image results as typed user image content after all tool/result
pairs. Without a projector it refuses image inspection before issuing a successful
receipt. The DS4 provider shares this loop. A live Muse Glimmer probe correctly
identified the colored shapes and text in a synthetic image through the actual
service/MCP/provider path; this is separate from the architectural modeling trial.

For bounded model comparisons, an explicit eval `--timeout` takes precedence over
the large-model engine's default minimum. Without an explicit timeout, engine floors
and throughput scaling remain active. Use the same prepared-input scenario and budget
across models, retain incomplete outputs, and distinguish an operator's diagnostic
compile from a model completing the build and review itself.

## Command approval handoff

The Flash Next baseline exposed a second handoff issue: a command approval was
answered while the local provider continued generating in the same turn. The
queued approval follow-up could not run until that turn ended. The MCP bridge now
signals structured pending results from `run_package_script` and `run_npx`, and
the llama.cpp/DS4, MLX and broker-backed loops yield after completing the tool-result batch.
Only successful structured results with a question ID trigger this behavior;
ordinary file text cannot request a handoff. Approval checks themselves are unchanged.

Eight new regressions cover the signal and all three provider paths, including
retaining tool history for the next approved turn through a broker. The focused
bridge, pool, MLX cache and llama.cpp vision suite passes 106 tests. The original
Flash Next timeout remains a failed trial with a framework-confounded endpoint;
its later operator compilation is separate diagnostic evidence.
The added broker approval test and remote session/vision suite pass 32 tests.

Gemma's first trial exposed the remaining manager-level race: the provider
yielded correctly, but the chat manager treated its empty tool-only reply as a
stall and started recovery before the approval answer could run. The manager now
yields for command approvals created in the current session and iteration, even
if an answer arrived immediately. Earlier approvals and other sessions' questions
do not suppress recovery. Four regression cases cover those boundaries; the
continuation, question and provider-handoff suites pass 29 tests.
