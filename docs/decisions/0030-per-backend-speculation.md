# 0030 — Speculation is chosen per backend, and a drafter can never cost a working model

Status: Accepted (2026-11).
Contract: [speculative-decoding.md](../speculative-decoding.md).

## Context

llama.cpp can decode with a separate DFlash2 drafter: a small GGUF trained
for one base model that proposes tokens for the target to verify. On CUDA it
decoded the Qwen 3.8 27B 15% faster than the model's own MTP head, and Muse
Glimmer 30B 1.6x faster than without speculation. Turning it on exposed four
assumptions in how a catalog entry described speculation:

1. **Speculation was per model.** `tuning.engine.llamaCpp.spec` applied on
   every backend. Upstream reports DFlash2 at about 1.1x on ROCm and below MTP
   on Vulkan, where one model lost half its prefill speed. An entry that
   turned it on for CUDA would have slowed down other machines.
2. **A sidecar went to whatever algorithm ran.** engine-flags passed the
   installed `draftModel` to any `draft-*` type. The 27B keeps MTP on every
   backend but CUDA, so a DFlash2 drafter beside it would have been loaded as
   an MTP head.
3. **A drafter was free.** The memory plan priced the target, the projector
   and the KV cache, never a drafter. A 1.1 GB DFlash2 file costs 2.6 GiB on
   the 27B once its buffers and the target's rollback checkpoints are counted.
4. **A failed start was the engine's fault.** Drafter formats change between
   engine releases (v0.9.0 changed how DFlash2 reads target features). A
   drafter the engine cannot load fails every start, and three failed starts
   quarantine the whole GPU backend.

## Decision

1. **A per-backend overlay.** `spec.byBackend.<backend>` overlays `type`,
   `nMax` and `sampling` for backends the speculation was measured on. Every
   other backend, an unknown backend, and any build that predates the field
   keep the base block. `draftModel.backends` limits the download to the same
   backends, so a Vulkan install neither fetches the drafter nor sees an
   update for it. One core module owns both reads, so the download list, the
   update check, the memory plan and the launch agree.
2. **The algorithm decides which file loads.** `llamaCppSidecarLoads` hands
   the sidecar to a drafter algorithm always, to MTP only when the target has
   no head of its own, and never across a per-backend table.
3. **A drafter is priced at its measured cost, and the target window wins.**
   `draftModel.residentBytes` carries the measured cost, with an estimate
   from the file size as the fallback. If the drafter would make the launch
   cap its target window or coarsen its KV cache, the launch leaves it out.
   Adaptive growth beyond the target pays for it, as it does for any
   resident memory.
4. **A drafter can always be dropped.** A missing drafter falls back to the
   base block or to no speculation. A start that fails with a catalog drafter
   retries without it, and the engine and drafter pair is remembered for the
   daemon's lifetime, so it never counts toward quarantine.
5. **Older builds skip the version.** An entry version that adds a drafter
   sets `minGezelVersion`, because an older build would drop the overlay and
   hand the DFlash2 file to MTP.

## Alternatives

- **A separate catalog entry per backend** (`qwen3.8-27b-q4-cuda`). Doubles
  every entry a person chooses from, and makes the choice theirs, when only
  the engine knows the backend.
- **Turning DFlash2 on everywhere and measuring later.** Rejected on
  upstream's Vulkan results, and because no Windows ARM64 Vulkan build exists
  to measure here.
- **Pricing with a flat term only.** The fixed cost depends on the target as
  much as the drafter (about 0.75 GiB on Muse, 1.5 GiB on the 27B), and a
  flat term large enough for the 27B would drop Muse's drafter, worth 1.6x, on
  machines where it fits.
- **Shrinking the context to keep the drafter.** A shorter window fails tasks
  that a 15% slower decode completes.

## Consequences

- Each drafter has to be measured per backend before an entry turns it on,
  and re-verified on every native bump.
- MTP's own memory (2.2 GiB on the 27B at 244K tokens) is still unpriced.
  Pricing it would change what fits for every MTP model and is separate work.
- Regression surface: [llama-cpp-spec.test.ts](../../packages/core/src/llama-cpp-spec.test.ts),
  [spec-draft.test.ts](../../packages/service/src/providers/llama-cpp/spec-draft.test.ts),
  [engine-flags.test.ts](../../packages/service/src/providers/llama-cpp/engine-flags.test.ts),
  [catalog-payload-identity.test.ts](../../packages/service/src/models/catalog-payload-identity.test.ts),
  and [models.test.ts](../../packages/service/src/providers/llama-cpp/models.test.ts).
