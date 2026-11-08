# Speculative decoding on llama.cpp

A drafter proposes a few tokens, and the model checks them all in one step.
Every token the person sees is one the model itself accepted, so speculation
changes speed and memory, never what the model says. This document is the
contract for how a catalog entry turns it on, and how the launch keeps a
drafter from ever costing a working model. The decision and its alternatives
are in [ADR 0030](decisions/0030-per-backend-speculation.md).

Gezel runs two kinds on llama.cpp:

- **MTP** (`draft-mtp`) uses the model's own multi-token-prediction head. Qwen
  3.8 27B ships one inside its GGUF. It needs no extra download, and a
  confirmed head turns it on with no catalog setting at all.
- **DFlash2** (`draft-dflash`) uses a separate block-diffusion drafter, a
  small GGUF trained for one base model. One file serves every quantization
  of that model.

## What a catalog entry declares

Speculation lives in two places, because Gilde keeps tuning on the item and
download payloads on each version:

```jsonc
// tuning.engine.llamaCpp (the item's manifest.json)
"spec": {
  "mtp": true,
  "nMax": 4,
  "byBackend": { "cuda": { "type": "draft-dflash", "nMax": 4 } }
}

// llamaCpp (versions/<v>/manifest.json)
"draftModel": {
  "huggingfaceRepo": "incoai/Qwen3.8-27B-DFlash2-GGUF",
  "revision": "144eb06583b4fb0b6e54bc814b16a206a240f4d2",
  "filename": "Qwen3.8-27B-DFlash2-Q4_K_M.gguf",
  "sha256": "d169ad335929adc0d77e10e2523f968f3e75f547637ad739b0a137ccde111b5f",
  "sizeBytes": 1143006816,
  "backends": ["cuda"],
  "residentBytes": 2852126720
}
```

- `spec` is the block every backend uses. `spec.byBackend.<backend>` overlays
  `type`, `nMax` and `sampling` for a backend the speculation was measured on.
  Read it through `llamaCppSpecForBackend` ([core llama-cpp-spec.ts](../packages/core/src/llama-cpp-spec.ts)).
- `draftModel.backends` limits the drafter to those backends. Elsewhere it is
  neither downloaded, nor part of the payload fingerprint, nor a reason to
  offer an update. Read it through `llamaCppDraftModelApplies`.
- `draftModel.residentBytes` is the drafter's measured cost: GPU memory
  against the same launch without speculation. Read it through
  `llamaCppDraftResidentBytes`.

## The rules

1. **Speculation is per backend.** A drafter is turned on only for backends it
   was measured on: CUDA for every entry below, and ROCm and Vulkan for Muse
   Glimmer. The gain differs by backend and by model (see
   [AMD results](#amd-rocm-and-vulkan)): the 27B's drafter is barely ahead of
   MTP on Vulkan, and Bolt E4B's slows Vulkan decode as the context grows.
   Every other backend, and any build that predates `byBackend`, keeps the
   base block. An unknown backend (an external server, a host whose probe has
   not run) is treated as untested.
2. **A missing drafter never fails a launch.** A live Gilde update can deliver
   the new tuning before the person updates the model, so the drafter is
   often absent. `resolveSpecDraft` ([spec-draft.ts](../packages/inference/src/providers/llama-cpp/spec-draft.ts))
   falls back to the base block when it needs no drafter, and to no
   speculation otherwise. A draft algorithm with no draft model is a fatal
   llama-server launch, which is why this is settled before the argv is built.
3. **The right file reaches the right algorithm.** engine-flags passes the
   installed sidecar to any `draft-*` type, so a target with its own MTP head
   would otherwise load its DFlash2 drafter as an MTP head.
   `llamaCppSidecarLoads` decides: a drafter algorithm always loads it, MTP
   loads it only as a separate MTP assistant (Gemma 4), and a target with its
   own head never does.
4. **A drafter is priced, and the target window wins over it.** The launch,
   the Settings preview and the installed-model badges price it at
   `residentBytes`, or estimate it from the file (weights × 1.1 plus
   `LLAMA_CPP_DRAFT_CONTEXT_BYTES`, [model-fit.ts](../packages/core/src/model-fit.ts)).
   If the drafter would make the launch cap the target window (the entry's
   `contextSize`, the 64K default, or the person's own size), drop to a
   coarser KV cache, or stop fitting, the launch leaves it out
   (`drafterCostsContext`). On a discrete card it also goes when the model
   beside it, at that window and one slot, would not fit in the graphics
   memory free right now (`drafterCostsGpuResidency`), which is the reading
   device admission charges the launch against. Checked against the card's
   total alone, the drafter stayed and admission refused a model that starts
   without it: the 74B Bolt and the 27B on a 32 GB card beside a desktop
   holding 6.5 GB. Both offload planners count a loaded drafter as GPU memory
   beside the target's own weights. Above the target it is paid for like any
   resident memory: adaptive sizing grows the window into what is left, and
   may give up a slot. On a 40 GB card the 27B's grown window falls from
   about 248K tokens to 214K with its drafter. Catalog rows and
   recommendations price models without their drafter, since a drafter that
   does not fit is dropped, never a reason to refuse the model.
5. **A failing drafter is dropped, not quarantined.** Drafter formats have
   changed between engine releases. If a start with a catalog drafter fails,
   or the engine later exits unexpectedly with one loaded, `brokenDrafters`
   records the engine and drafter pair and the retry runs without it for the
   rest of the daemon's life. Without this, three such starts would read as a
   build that cannot run and quarantine the whole GPU backend.
6. **The person's choice wins.** An explicit `llamaCppSpecType` in Settings
   replaces the catalog's choice. The overlay's `nMax` and `sampling` stand only
   when the person chose the overlay's own type, so MTP never inherits tuning
   measured for a drafter. Settings shows the catalog's choice as "Auto — the
   model's own setting".
7. **Sibling quants share one drafter.** When another installed quant of the
   same model already verified the drafter, install hard-links that file
   instead of downloading it again. Each model's folder stays complete, so
   deleting one quant leaves the other whole. A volume that cannot link
   downloads.
8. **Older builds skip the version.** A build that predates this contract
   drops `byBackend` and `backends`, then hands the DFlash2 file to MTP. Every
   version that adds a drafter therefore sets `versionMinGezelVersion`, and
   older builds stay on the previous version.

## Measured results

llama.cpp v0.9.0 (native-v0.1.61), CUDA, an RTX Spark N1X (Blackwell, 40 GB
GPU share), greedy drafting, n=4. Decode is tokens per second over nine
workloads (prose, code and tool calls; greedy and sampled; 27K- and 91K-token
prompts), as a geometric mean against the configuration named.

| Model | Against | DFlash2 | Drafter cost after use |
| --- | --- | --- | --- |
| Qwen 3.8 27B Q4 | MTP n=4 | 1.15x | +2,711 MiB (MTP +2,198 MiB) |
| Muse Glimmer 30B Q4 | no speculation | 1.64x | +2,483 MiB |
| Nemotron 3.5 Bolt E4B Q4 | no speculation | 1.52x | +2,025 MiB |

Drafter cost is GPU memory after a long-prompt workload against the same
launch without speculation. Muse and Bolt have no MTP head, so they ran
without speculation before.

Per-quant and tuning results:

- n=4 is best on every model: n=3, 6 and 7 are slower on the 27B and n=5
  ties; Muse loses 8% at n=5 and 13% at n=6; Bolt loses 4% at n=6.
- Probabilistic draft sampling gained 2% on the 27B and 4% on Muse: more on
  sampled prose and tool calls, less on creative writing and long-context
  code. Greedy, the upstream default, stays.
- The drafter's cost does not depend on context or quant: on v0.8.0 it was
  within 10 MB across Q2, Q4 and IQ1-S, and within 60 MB of the 244K-token
  figure at a small window. Every DFlash2 drafter's layers use a sliding
  window, so its KV cache stays small.
- `--spec-draft-n-ubatch 256` saved 228 MiB on the 27B, 241 MiB on Muse and
  528 MiB on Bolt at the same speed, and turning off backend sampling changed
  nothing. Neither is wired yet; the first is the obvious next saving.
- Every 27B quant gains over MTP, A-B-B-A at a 64K window: Q2 1.16x, Q3
  1.17x, Q4 1.15x, Q6 1.18x, Q8 1.18x. All of them use the Q4_K_M drafter:
  the Q8_0 drafter was 3% slower even on the Q8 target.
- IQ1-S has no MTP head and gained 1.03 to 1.16x on v0.8.0 for 2.4 GB, so it
  gets no drafter.

Whole turns gain less than decode, because speculation does nothing for
prefill. On a 13-turn tool loop that reads twelve 1.5K-token results
(A-B-B-A, v0.9.0):

| Model | Loop time | Prefill |
| --- | --- | --- |
| Qwen 3.8 27B Q4, MTP → DFlash2 | 61.2 s → 60.6 s (about 4.5% at equal output) | 39.1 s → 38.6 s |
| Muse Glimmer 30B Q4, none → DFlash2 | 78.7 s → 51.2 s (1.54x) | 31.9 s → 34.1 s |
| Nemotron 3.5 Bolt E4B Q4, none → DFlash2 | 35.1 s → 24.3 s (1.45x) | 5.6 s → 9.1 s |

Bolt's drafter is large beside a 4B target and cuts its prefill by 40% (by
2% on the 27B, which MTP already slows by 5%), yet the loop still runs 1.45x
faster. On v0.8.0 the 27B's real evals gained about 8% per turn, with no
reproducible change in pass rate or output distribution.

On v0.9.0, through the shipped path (the Gilde entry, the installed drafter,
the daemon's own launch), ten core evals on the 27B Q4 decoded 1.18x faster
than MTP (geometric mean; 1.10 to 1.24x per scenario) at equal GPU clocks and
equal prefill. Nine passed against ten. The miss was data-wrangle, which fails
under MTP too: across every run of it on this machine, MTP passed 8 of 11 and
DFlash2 3 of 8 (Fisher p ≈ 0.14), with the same two failures each time, a
dedup count one or two short and an unsorted pair. Replayed greedily at 20K
to 23K tokens of a failing data-wrangle session, DFlash2 matched MTP's
output exactly on two contexts and left the no-speculation baseline within
four characters of MTP on the third, each time at a near-tie word choice.
The baseline repeated exactly, so the drafter changes nothing MTP's batched
verification does not.

### AMD (ROCm and Vulkan)

llama.cpp v0.9.0 (native-v0.1.61) on an AMD Radeon AI PRO R9700 (RDNA4, 32
GB), Windows, the ROCm and Vulkan builds, one slot at a 64K window with f16
KV. Seven workloads (prose, code and tool calls, greedy and sampled, and a
25.7K-token prompt), A-B-B-A with a fresh server per arm; every pair of
repeats agreed within about 1%. Decode is a geometric mean against the
configuration named.

| Model | Against | ROCm | Vulkan |
| --- | --- | --- | --- |
| Qwen 3.8 27B Q4, MTP n=3 | MTP n=4 | 1.08x | 1.19x |
| Qwen 3.8 27B Q4, DFlash2 n=3 | MTP n=3 | 1.08x | 1.02x |
| Muse Glimmer 30B Q4, DFlash2 n=3 | no speculation | about 1.54x | about 1.88x |
| Nemotron 3.5 Bolt E4B Q4, DFlash | no speculation | 1.38x, prefill -43% | 0.88x |
| Nemotron 3.5 Bolt 74B, DFlash n=7 | no speculation | 1.52x | 1.18x, prose 0.78x |
| Nemotron 3.5 Bolt 74B, DFlash n=3 | no speculation | 1.54x | 1.28x |

- **Shorter drafts win on Vulkan** for every model and both algorithms. Muse
  gains 1.30x from n=3 over n=4 there (1.12x on ROCm), and the 74B's n=3 is
  never below no speculation where n=7 loses 22% on prose. It is not
  ggml-vulkan's vector-matmul column limit, which is 8 at this revision.
- **Prefill held up.** The 27B and Muse drafters cost 0 to 1% prefill on
  both backends; upstream's halved Vulkan prefill did not reproduce. Bolt
  E4B's drafter alone cuts it by 43%.
- **Bolt E4B collapses on Vulkan as context grows**: 113 to 23 tok/s from 1K
  to 26K tokens with its drafter, against 127 to 105 without. ROCm does not.
  Its drafter is the older DFlash format with BF16 weights; the DFlash2
  drafters do not show it.
- **Drafters cost more on ROCm** than the CUDA figures: after the long
  prompt, 2,826 MiB on the 27B, 2,748 on Muse and 2,690 on Bolt E4B (Vulkan
  2,564, 2,424 and 1,935). The 74B's costs 2,829 MiB at n=7 on ROCm and
  2,138 at n=3; Vulkan 2,498 and 1,818.
- **Muse holds its gain at long context.** Against no speculation at 1K,
  14K, 43K and 86K-token prompts: Vulkan 1.98x, 1.75x, 1.90x and 1.75x;
  ROCm 1.74x, 1.49x, 1.54x and 1.38x.
- **Whole turns gain too.** On the 13-turn loop (twelve 1.5K-token
  excerpts, greedy, identical output in every arm), Muse's loop time fell
  from 70.6 s to 49.1 s on Vulkan (1.44x) and from 67.8 s to 49.9 s on ROCm
  (1.36x). Prefill rose 1% and 4%.
- **Real evals agree.** Four core scenarios on Vulkan (tictactoe,
  schema-migration, symptom-debug, conflict-synthesis), one trial each:
  Muse decoded 33 tok/s without its drafter and 64 to 79 with it (2.09x
  geometric mean), prefill within 3%. Four passed with the drafter and three
  without; the miss was a schema-migration repeat-loop abort, which the
  drafter arm hit too before recovering, so one trial says nothing about it.
- **Through the daemon,** with the desktop holding 6.5 GB of the card, Muse
  keeps its drafter at a 106K window, the 27B leaves it out (26.0 GiB needed
  against 25.5 free), and so does the 74B: the launch prices it about 2 GiB
  above what it uses, the safe direction.

## Entries with a drafter

Greedy drafting, from the Gilde versions that set `minGezelVersion: 1.26312`
(the 74B's predates the contract):

| Entries | Drafter | Backends and `nMax` | `residentBytes` |
| --- | --- | --- | --- |
| `qwen3.8-27b-q2`, `-q3`, `-q4`, `-q6`, `-q8` | `incoai/Qwen3.8-27B-DFlash2-GGUF`, Q4_K_M (1.1 GB) | CUDA 4 | 2,720 MiB |
| `muse-glimmer-30b-q4` | `incoai/Muse-Glimmer-30B-DFlash2-GGUF`, Q4_K_M (1.6 GB) | CUDA 4; ROCm, Vulkan 3 | 2,752 MiB |
| `nemotron3.5-bolt-e4b-q4` | `nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-4GB-DFlash`, BF16 (0.7 GB) | CUDA 4 | 2,032 MiB |
| `nemotron3.5-bolt-74b-iq2` | `nvidia/NVIDIA-Nemotron-3.5-Bolt-74B-A9B-24GB-LiLiCorr-GGUF` (1.0 GB) | every backend 7; Vulkan 3 | 2,832 MiB |

`qwen3.8-27b-q4` also runs MTP at n=3 on ROCm and Vulkan; its other quants
keep n=4 there until they are measured.

Meta's own Muse repository has shipped a different DFlash drafter since
October 20; it is untested here.

## Adding a drafter to an entry

1. Bench the target with and without the drafter on each backend you can
   reach, A-B-B-A, with no-speculation controls that agree within 5%. Choose
   `nMax` from the sweep; keep greedy unless probabilistic wins everywhere.
2. Measure `residentBytes` as GPU memory after a long-prompt workload with
   the drafter, minus the same for `--spec-type none`, and round up to 16 MiB.
   Measure after use, not after load: DFlash2 allocates another 150 to 270
   MiB once decoding starts.
3. In the Gilde recipe, add `llamaCpp.draftModel` with `backends` and
   `residentBytes`, and the overlay in `releasePatch.tuning.engine.llamaCpp.spec`.
   Set `versionMinGezelVersion` to the first Gezel release with this contract,
   bump `version` past the newest version in `data/`, and build with
   `--release`. Then diff the new version manifest against the previous one.
   `--release` re-pins every repository in the entry, MLX included, and a
   moved repository can change files nobody meant to update. Keep each
   unchanged payload exactly as the previous version pinned it.
4. Re-verify drafters on every native bump. v0.9.0 changed how DFlash2 reads
   target features, and an older engine may not load a newer drafter.

Evals can force a drafter on a model whose entry does not have one:
`GEZEL_EVAL_LLAMA_SPEC_TYPE=draft-dflash` with `GEZEL_EVAL_SPEC_DRAFT_PATH`,
plus `GEZEL_EVAL_SPEC_DRAFT_N_MAX` and `GEZEL_EVAL_SPEC_DRAFT_SAMPLING`.

## Not covered

- Metal is untested, so no entry turns a DFlash2 drafter on there. ROCm and
  Vulkan were measured on one RDNA4 card under Windows; other AMD
  generations, Linux, and Vulkan on Intel or NVIDIA are not. There is no
  Windows ARM64 Vulkan build to test with.
- `residentBytes` is one number for every backend and `nMax`, so it carries
  the largest measured cost. The 74B's 2,832 MiB is its ROCm n=7 figure, and
  overprices Vulkan at n=3 by about 1 GB.
- MTP's own memory is not priced: 1.3 GB on the 27B at a small window and
  2.2 GB at 244K tokens, because its head keeps a full-attention KV cache.
  The planner's headroom has absorbed it so far.
- `residentBytes` is measured with one slot, and on the hybrid 27B the
  drafter's rollback checkpoints add about 660 MiB for each further slot (Muse
  about 60, Bolt about 30). Every 27B launch logged on a 40 GB card ran one
  slot, because the adaptive window sheds slots to grow; a larger card that
  keeps several is underpriced by that much. A start that runs out of memory
  retries without the drafter, and a later crash leaves it out for the
  daemon's lifetime. Pricing it per slot is the next step.
- With every slot busy at once, a drafter gains less or loses: two 27B
  streams decode 48 tok/s together against 52 with MTP, and three Bolt
  streams 122 against 161 with no speculation. Muse still gains 1.4x at two.
  One active stream on a multi-slot engine keeps the full gain.
- Slot save and restore work with a drafter loaded (the drafter's state is
  saved with the slot), and so does a vision projector beside it.
