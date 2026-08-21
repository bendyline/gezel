# Gezel KV- & Prompt-Cache Strategy (and the turn machinery around it)

> **Status / provenance.** Snapshot of how Gezel caches prompts and KV state across its
> two local inference engines — **llama.cpp** (via `llama-server`'s slot system) and **MLX**
> (via our forked `gezel_mlx_server.py`) — and how the turn-management layer is shaped to keep
> that cache warm. Written from a read of the `cache/`, `providers/`, and `chat/`
> subsystems. File paths are relative to the repo root; `file:line` anchors are accurate as of
> this writing but drift — re-grep the named symbol if a line looks off. Cloud providers
> (Anthropic CLI, Codex CLI, OpenAI, Ollama) are out of scope except where they share the turn
> pipeline; only `llama-cpp` and `mlx` are cache-managed.

> **Reframing (Theme F — read before §0).** This doc predates profiling the
> *engine-time split* on the small/medium models that are the actual product target. That
> profiling (2,276-trial history) found the workload is **~86% decode-bound** — median
> `decode_sec / prefill_sec ≈ 6.2×`; only the big dense/MoE models (deepseek-284b, mistral-128b)
> are prefill-balanced. Prompt/KV caching optimizes **prefill**, i.e. ~14% of engine time for the
> product-target models. So §0's "prefill is the whole game" is right about the *mechanism*
> (cache reuse is real and worth keeping) but wrong about the *magnitude* for a 4–27B coding
> gezel: the dominant levers are **decode throughput** (Theme F/F2 shipped `draft-simple`
> speculative decoding for gemma4-e4b — **+23% decode on the real agentic loop**, acceptance
> ~0.54; the checked-in [decode-lever harness](../evals/src/bin/ab-decode-levers.ts)
> captures the reproducible method)
> and **doing less work** (Theme F/F3 — the fail-fast per-task budget and the coordinator tool
> diet). Caching stays load-bearing for the big prefill-balanced models and the cold first-turn
> tool block; read §0's "whole game" as "the whole game *of prefill*."

---

## Contents

0. The core bet
1. The layer map
2. Engine mechanisms compared (the heart)
3. Harnessing the prompt for cache-friendliness
4. The turn lifecycle — where the cache hooks fire
5. Turn management & serialization — keeping the cache warm
6. Policy: budgets, eviction, reconcile, pinning
7. Invalidation discipline
8. Persistence across idle-freeze and restart
9. Warm paths
10. Telemetry & operator surface
11. Configuration & environment reference
12. Known limitations, gotchas & correctness invariants
13. Key-file index

---

## 0. The core bet

Every chat turn re-sends the **whole** prompt: system instructions + tool schemas + the entire
conversation transcript so far. On a laptop-class local model the cost of that turn is dominated
by **prefill** — running attention over every token of that prompt before the first new token is
generated. On a 60-tool researcher gezel the serialized tool schemas alone can outweigh the
transcript on turn 1, and prefill on a 12B model can run into *minutes*.

Local engines keep the **KV cache** (the attention key/value tensors) resident across requests.
If turn N+1's prompt shares a prefix with turn N's, the engine can reuse the cached KV for that
prefix and prefill only the new suffix. The per-turn cost drops from **O(full prompt)** to
**O(new tokens)**. That single property is the whole game, and everything in this document
exists to maximize it. Three problems follow:

1. **Mechanism** — actually telling each engine to preserve and reuse KV. The mechanism differs
   per engine (llama.cpp slots vs. our MLX `cache_id`), so it's hidden behind an adapter
   interface. → §2, §6.
2. **Prompt harnessing** — the prefix only gets reused if it's **byte-identical** across turns
   and across sessions of the same gezel. So the prompt is deliberately ordered into a *stable
   prefix* and a *volatile tail*, and volatile content is kept out of the prefix. → §3.
3. **Turn routing** — the cache lives in one engine process; it only helps if the session's turns
   keep landing on that process, back-to-back, before it's evicted. So the queue, router, pool,
   and supervisor are all tuned for cache locality. → §5.

> The opening comment in `packages/service/src/cache/controller.ts:1-25` states the bet directly:
> *"the per-turn prefill cost drops from O(full prompt) to O(new tokens)."*

---

## 1. The layer map

Caching is split into **policy** (engine-agnostic), **mechanism** (per-engine), and
**orchestration** (the turn loop that drives both). The policy/mechanism seam is the
`EngineCacheAdapter` interface.

| Layer | Owns | Where |
|---|---|---|
| **Orchestration** — `ChatManager` | Builds the (stable) system prompt; runs the turn loop; fires `recordTurn`; routes all invalidation; fires `prewarmSession`. | `chat/manager.ts` |
| **Policy** — `SessionCacheController` | Tracks warm sessions per provider; LRU eviction against a RAM-aware budget; hit/miss stats; reconcile timer; pinning. **Engine-agnostic.** | `cache/controller.ts`, `cache/budget.ts` |
| **Boundary** — `EngineCacheAdapter` | The contract: `buildRequestExtras`, `evict`, `reportUsage`, optional `warm` (+ our `prepareForSend`/`setSessionPrefix`/`flushAll`). | `cache/adapter.ts` |
| **Mechanism** — per-engine adapters | Translate policy into engine-specific request fields and admin calls. | `providers/llama-cpp/cache-adapter.ts`, `providers/mlx/cache-adapter.ts` |
| **Engine** — the inference process | Actually holds the KV. `llama-server` (C++); our `gezel_mlx_server.py` (Python fork of `mlx_vlm.server`). | `providers/mlx/python/` + the bundled `llama-server` binary |

A single shared `SessionCacheController` is constructed at service boot (`service.ts:428-448`)
and handed to `ChatManager`. Adapters register lazily, keyed by `providerName` (`'mlx'` /
`'llama-cpp'`), the first time each local provider is built
(`ChatManager.wireLocalProviderCacheAdapter`, `chat/manager.ts:5928-5956`). LRU is **per-provider,
not global** — MLX and llama.cpp are independent processes with independent memory budgets.

### A turn, end to end

```
ChatManager.runSend                      (chat/manager.ts:3390)
  ├─ recomputeSystemMessage              → buildInstructions()  [stable prefix]  §3
  ├─ EngineRouter.bindForSession         → pick/reuse replica (session-sticky)  §5.4
  ├─ ProviderQueue.runInQueue            → lane + affinity admission            §5.1
  │    └─ provider.sendAndWaitInner
  │         ├─ adapter.prepareForSend(sessionId, systemMessage)  → slot/prefix  §2
  │         ├─ Object.assign(body, adapter.buildRequestExtras(sessionId))       §2
  │         │     llama:  { cache_prompt: true, id_slot }
  │         │     mlx:    { cache_id, prefix_cache_id }
  │         └─ POST /v1/chat/completions  (streamed, under runExclusive on MLX)  §5.2
  └─ cacheController.recordTurn({ approxPromptTokens, … })       [LRU bookkeeping] §4

           ...meanwhile, every 5 s...
  cacheController.reconcileProvider → adapter.reportUsage() → engine-truth wins   §6
```

---

## 2. Engine mechanisms compared (the heart)

Both adapters implement the same `EngineCacheAdapter` contract (`cache/adapter.ts`). The
controller never knows which engine it's talking to; it asks for request extras, eviction,
usage, and (optionally) warming. Everything below is the *mechanism* behind that contract.

### 2.1 llama.cpp — `llama-server` slots

`llama-server` holds KV per **slot**: a small fixed pool of inference contexts sized at launch
via `--parallel N`. The adapter (`providers/llama-cpp/cache-adapter.ts`) does three things:

- **`cache_prompt: true`** on every request — the master switch for prefix reuse. Without it,
  even slot pinning wouldn't preserve KV across requests.
- **`id_slot: <n>`** — explicit per-session slot pinning. The adapter keeps a
  `Map<sessionId, slotId>` and a round-robin allocator (`allocateSlot`,
  `cache-adapter.ts:316`). Without an explicit slot the server picks a free one itself and may
  clobber an unrelated session's cache; with `id_slot`, turn N+1 reuses turn N's KV **iff** both
  went to the same slot.
- **Disk save/restore** via `POST /slots/{id}?action={save|restore}` when `llama-server` is
  launched with `--slot-save-path`. On evict/recycle the slot is saved to `sess-<id>.bin`; on
  first allocation for a session it's restored from disk; on the first save for a gezel the file
  is also copied to `prefix-<hash>.bin` so a *new* session for the same gezel restores the
  warmed system-prompt prefix (`cache-adapter.ts:28-53`, `saveSlotForSession` `:424`,
  `tryRestoreForSession` `:461`).

`reportUsage()` scrapes `GET /slots` for each slot's `n_cache_tokens` and maps slots back to
sessions via the adapter's own reverse map (`cache-adapter.ts:241`).

**Launch flags** are built in `chat/manager.ts:11192-11264` (not in the provider package). The
full caching-relevant argv:

```
--jinja                                    # use the GGUF-embedded chat template
--ctx-size   <effectiveNumCtx * slots>     # TOTAL KV; llama-server splits it across slots
--parallel   <slots>                       # one KV slot per request lane (RAM-tiered default: 4 at ≥64GB)
--slot-save-path <dir>                     # enables per-slot disk save/restore (else 501)
--cache-type-k q8_0   --cache-type-v q8_0  # KV quantization (default; Gemma family forces f16 — see below)
[--mlock] [--flash-attn] [--ubatch-size N] [--mmproj …] [--reasoning-budget N]
```

- **`--ctx-size` is multiplied by the slot count on purpose** — `llama-server` divides total KV
  evenly across `--parallel`, so the multiply makes `effectiveNumCtx` land as the *per-turn*
  budget. Default per-turn context is `PREFERRED_CTX_DEFAULT = 65_536`
  (`chat/manager.ts:11039`), clamped down to the model's native context from GGUF metadata, and
  overridable via `config.llamaCppNumCtx` / env `GEZEL_LLAMA_NUM_CTX`.
- **KV quantization defaults to `q8_0` for both K and V** — ~50% KV-memory savings with
  essentially no quality impact — **except the Gemma family, which forces `f16`**: Gemma 3/4's
  large attention head dims + final logit softcap + sliding-window attention make a quantized KV
  cache corrupt the *stored prompt tokens* (recalled source came back as Korean glyphs + emoji
  under q8_0; see `chat/manager.ts` `resolveLlamaCppKvCacheType`). So the
  family default is model-conditioned, not flat. Operator-tunable via `config.llamaCppKvCacheType`
  (down to `q4_0` or out to `f16`). **It is not hardware-tiered**: `hardware-tier.ts` only selects
  *which Gemma model* to run from RAM/VRAM, never a launch flag.
- **`--cache-reuse 256` auto-enables at single-slot (`--parallel 1`); no `--n-keep`, no
  `--no-context-shift`.** b9843 rejects `--cache-reuse` under multi-slot non-unified KV, so the
  default-on prefix-reuse (KV shifting) applies only when slots resolve to 1 (evals, solo desktop);
  an explicit `config.llamaCppCacheReuse` is passed regardless (`engine-flags.ts`). At multi-slot
  the engine uses its default in-place context-shift; Gezel handles overflow at the application
  layer via reactive compaction (§7) at `MID_LOOP_COMPACT_RATIO = 0.70` of the per-slot context.

### 2.2 MLX — our `gezel_mlx_server.py` fork

Upstream `mlx_vlm.server` runs `mx.clear_cache()` in a `finally` after every stream, so every
turn re-prefills the whole context. **Our fork exists specifically to preserve the cache between
requests**, keyed by a `cache_id` (`providers/mlx/python/gezel_mlx_server.py:5-11`).

- Caches live in a module-level `_CACHE: Dict[str, CacheEntry]` keyed by `cache_id`
  (`gezel_mlx_server.py:218-228`). Each entry holds a `PromptCacheState` (the KV layers + the
  prefilled `token_ids`), an `est_bytes`, and a `last_used_ts`.
- The adapter (`providers/mlx/cache-adapter.ts:124-132`) attaches **`cache_id: sessionId`** to
  every request and, when known, **`prefix_cache_id: prefix-<hash>`**.
- **Lookup cascade** on each chat request (`gezel_mlx_server.py:780-808`): in-memory hit on
  `cache_id` → disk hit on `cache_id` → disk hit on `prefix_cache_id` (seeds the session's entry
  from the gezel's warmed prefix) → fresh `PromptCacheState`. If `cache_id` is absent it reverts
  to upstream behavior (`mx.clear_cache()`).
- **Prefix reuse / trim** is done by the vendored `mlx-vlm`, not our fork: a token-by-token
  longest-common-prefix scan (`find_prefix_length`) computes how much of the cached prompt
  matches the new one, then the KV tensors are **sliced down to that prefix length** (the cached
  state usually includes the *previous turn's generated tokens*, which the new prompt diverges
  from) and only the suffix is prefilled. So reuse = common-prefix length; re-prefill =
  everything after it.

**Launch** (`chat/manager.ts:11646-11696`) runs the venv's Python on the fork. There is **no
context/`max-kv-size` flag** — the cache grows with the request up to the model's native context
window. Gezel uses that catalog-native window for overflow checks, compaction, tool-output caps,
and user-facing pressure warnings; `mlxNumCtx` is an optional lower operator cap. Manual model
paths without catalog metadata fall back to the host's context floor — 64K, or 32K on a
memory-constrained machine (`minViableLocalContextTokens`). The cache is a non-rotating full `KVCache`
(we never pass `max_kv_size`).

```
gezel_mlx_server.py
  --model <absolute on-disk dir>     # absolute, NOT a catalog id (offline; HF never contacted)
  --host 127.0.0.1  --port <p>
  --cache-budget-mb <ram-tiered>     # in-engine in-memory KV cap; default 4096
  --persist-dir <cacheRoot>          # disk-persisted KV root
  --model-fingerprint <24-hex>       # segments disk cache by model — correctness firewall
  --disk-cache-budget-mb <n>         # disk cap; default 8192 (0 disables pruning)
  [--prefill-step-size 2048]
  [--kv-bits N --kv-quant-scheme uniform]   # opt-in only; default OFF (see §12)
env: HF_HUB_OFFLINE=1, TRANSFORMERS_OFFLINE=1, …
```

**HTTP surface** (caching-relevant):

| Route | Purpose |
|---|---|
| `POST /v1/chat/completions` (+ `/chat/completions`) | Main turn path; lookup cascade, stream, save in `finally`. Non-stream → 501. |
| `POST /v1/cache/warm` | Prefill + 1 discarded token to populate an entry; `persist=true` writes it to disk. §9 |
| `GET /v1/cache/stats` | In-memory entries only: `{cache_id, token_count, est_bytes, last_used_ts}`. |
| `DELETE /v1/cache/{cache_id}` | Drop from memory **and** disk. |
| `POST /admin/flush` | Persist every in-memory entry to disk without dropping (idle-freeze hook). |
| `GET /health` | Supervisor readiness probe. |

### 2.3 Side by side

| | **llama.cpp** | **MLX (our fork)** |
|---|---|---|
| Reuse key on the wire | `cache_prompt: true` + `id_slot: <n>` | `cache_id` (+ `prefix_cache_id`) |
| Cache unit | fixed slot pool (`--parallel N`) | unbounded dict keyed by `cache_id` |
| Concurrent turns | N slots (default 2) | 1 stream (serialized by `runExclusive`) |
| Cross-session prefix share | `prefix-<hash>.bin` restore on allocate | `prefix_cache_id` seed on miss |
| Prefix-match granularity | engine-internal (`cache_prompt`) | token-level LCP trim (`mlx-vlm`) |
| In-engine cap | KV is per-slot context size | `--cache-budget-mb`, LRU to 80% |
| Disk format | per-slot `.bin` (incl. multimodal 501 latch) | safetensors per `(fingerprint, cache_id)` |
| KV quant | `--cache-type-k/v q8_0` (default on) | `--kv-bits` opt-in, **default off** |
| Usage poll | `GET /slots` → `n_cache_tokens` | `GET /v1/cache/stats` |
| Dedicated warm endpoint | none (uses disk prefix files) | `POST /v1/cache/warm` |

Both adapters use the same byte estimate, **`ESTIMATED_BYTES_PER_TOKEN = 100 * 1024`** (100
KB/token), and the Python side mirrors it as `_BYTES_PER_TOKEN` — *keep them in sync*. It is a
flat figure tuned for sliding-window-attention models (Gemma 3/4); it drives LRU/budget
accounting only, never actual allocation.

---

## 3. Harnessing the prompt for cache-friendliness

Reuse only happens if the prefix is **stable**. This is where prompt construction and caching
meet, and it is the half of the strategy that lives in `ChatManager`, not the adapters.

### 3.1 The stable-prefix bet

Each adapter derives a **prefix id** by hashing the *verbatim* system prompt:
`prefix-${sha256(systemPrompt).slice(0,16)}` (`gezelPrefixId` / `llamaPrefixId`). The hash **is
the cache key and the invalidation signal at once**: identical stable bytes across sessions of
the same gezel → identical hash → shared warm prefix; any drift → new hash → new disk file → cold
prefill, and the old file orphans (pruned later by disk-LRU). `prepareForSend(sessionId,
systemMessage)` is called once per turn with the *exact* `buildInstructions()` output
(`providers/{llama-cpp,mlx}/provider.ts`), so the system message the model sees and the bytes
that get hashed are the same string.

### 3.2 The three-band ordering ("Phase 2.4")

`buildInstructions()` (`chat/manager.ts:9942`, assembled at `:10800`) deliberately orders the
system prompt so volatile content can't poison the stable prefix. The design note lives at
`chat/manager.ts:10652-10688`:

```
[ stable across sessions of the same gezel ]   ← hashed into the prefix id
   header + delegation guardrail
   about prose + body, traits, lessons
   project context (name, voorman, mission, github, artifact/memory prose)

[ volatile per turn / per session ]            ← late enough to leave the prefix intact
   workspace-files listing
   documents-library listing
   task context, assigned tasks, recall hits

[ late stable — high-attention zone ]          ← end-of-prompt; small models attend hardest here
   act-don't-narrate, ask-when-stuck, browsing, markdown guidance
   local hints (behavior promptAppend output), available-tools block

[ recency anchor ]
   activeTaskAnchor
```

**The load-bearing move:** the **workspace-files listing is pulled out of `projectContext`** and
rendered separately in the volatile band, "because anything embedded in projectContext is part
of the stable prefix … putting volatile bytes inside the stable prefix would invalidate the
gezel-prefix cache on every workspace mutation" (`chat/manager.ts:10366-10375`). The
action-discipline prose and tools block stay *late* despite being stable, because end-of-prompt
attention matters more for small models — and being stable, they don't churn the prefix as long
as their content is deterministic (§3.4).

### 3.3 Stable-prefix content placement

- **Lessons** and **traits** are injected into the stable prefix right after the about body.
  Lessons "change at most once per daily sweep, so prompt-cache invalidation stays bounded"
  (`memory/lessons.ts:6-8`), and are hard-truncated so a runaway reply can't bloat the prefix.
- **Indexed retrieval rides the user-message channel, not the system prompt.**
  Relevant project/shared evidence can therefore change on every substantive
  turn without invalidating the stable system-prefix cache. The older frozen
  first-turn auto-recall path remains only as compatibility when the scoped
  SearchService is not wired.
- **AGENTS.md scoping** (`chat/scope-instructions.ts`) trims a project's imported instructions
  for small tiers — but **when nothing would be dropped it returns the original unchanged** "so
  the stable-prefix cache key doesn't churn for no benefit" (`scope-instructions.ts:296-299`).
- The resolved **behavior set is fixed at session build** and threaded for the session's
  lifetime, so prefix-shaping logic can't change mid-session.

### 3.4 Shrinking & stabilizing the late band (model-profile behaviors)

Behaviors (`model-profile/behaviors/`) don't *implement* the prefix strategy — but the content
they emit lands in the late-stable band, so it must be **small and deterministic** or it
silently churns the prefix. The relevant ones:

| Behavior | What it does | Cache effect |
|---|---|---|
| `mcp.compact-tool-schemas` | Strips prose-only schema keys (`description`, `examples`, …) and clips tool descriptions to 96 chars; keeps the callable JSON shape. | **Positive** — shrinks the stable tools block; "long descriptions … cost minutes of prefill on 12B models." Pure fn of schema → deterministic. |
| `prompt.tool-cookbook-condensed` | `promptAppend` of a fixed 10-rule anti-fabrication block. | **Neutral/positive** — a constant; deterministic, never churns. |
| `turn.preamble-folding` | Drops the model's reasoning preamble on iterations that fired a tool call. | Mildly positive — keeps the *transcript tail* tight; not a prefix mechanism. |
| `provider.flatten-tool-transcript` | Flattens `assistant(tool_calls)→tool` into alternating turns from request 1 (strict-alternation templates, e.g. Mistral). | Consistency-positive — uniform transcript shape from turn 1; avoids a one-time reactive reshape. |

The takeaway for the doc: the behaviors are supporting actors that keep emitted content
deterministic; the prefix-stability *strategy* is the §3.2 ordering plus the §7 invalidation
discipline.

### 3.5 What counts as the prompt

`estimatePromptChars()` (identical in both providers) sums message content + tool-call args +
**the full serialized tool schema** (`JSON.stringify` over the OpenAI tools), because the engine
templates the function schema into the wire prompt. That estimate feeds `recordTurn`'s
`approxPromptTokens` (§4) and is why compacting the *transcript* alone doesn't shrink a
tool-heavy turn much.

### 3.6 Layered prefix caching (flag `layeredPrefixCache`)

§3.1–3.2 describe the *intent*; this is the **mechanism** that makes the stable prefix (including
the tool schemas) reusable across sessions. It is a **local-engine-only** optimization — it splits
the volatile band into a second `system` message that only the llama-cpp / mlx provider sessions
seed, so it **never applies to cloud providers** (they'd drop that band). Per-engine default when
`config.layeredPrefixCache.enabled` is unset: **ON for `llama-cpp`** (perf-proven, no regression),
**OFF for `mlx`** (cache mechanism validated end-to-end — see §coverage — but no MLX quality A/B
yet). Set `enabled: true`/`false` to
override both engines; `GEZEL_LAYERED_PREFIX_CACHE` (`1`/`0`) overrides config (the eval A/B
toggle). When off for an engine, its system message is byte-identical to the legacy single string.

**What it changes.** `buildInstructions` (`chat/manager.ts`) returns a `{ full, layers,
volatileContext }` struct instead of one string. The system message (`messages[0]`) becomes
**purely stable**: the volatile band — workspace files, documents, task context, recall, addenda,
and the recency anchor — is pulled *out* and seeded as a **separate frozen `system` message at
index 1**, right after the stable system message. The Gemma-family chat template renders the first
turn as `[system content][tool schemas][transcript]`, so making `messages[0]` volatile-free yields
a reusable wire prefix of **`[stable system + tool schemas]`**; the volatile message and transcript
come after it, where divergence is cheap.

**The layers.** The stable bands keep their *proven* late-discipline order (front-loading the
discipline/cookbook regressed small models — see the Phase-2.4 note at `manager.ts:10659`), so
there are **two cumulative, nested layers** (`SystemPromptLayers = { gezel, project }`), keyed by
`sha256(text).slice(0,16)`:

```
gezel    = [ header + delegation + about.md + traits + lessons ]          ← gezel identity
project  = gezel + [ project context + discipline + tools-block(prose) ]  ← the ENTIRE stable
           └──────────────────────────────────────────────────────┘        system message

prefix-gp-<sha(project)>     workhorse. shared across sessions of the same (model, gezel, project).
prefix-gezel-<sha(gezel)>    identity-only. would be shared across PROJECTS of a gezel.
```

There is intentionally **no model-universal layer** — that would require front-loading discipline
(the documented regression). The cumulative ordering means `gezel` is a true byte-prefix of
`project`, so the engine's longest-common-prefix reuse falls back cleanly (gp → gezel).

**What is disk-cached, and at which layer (the answer to "do we cache to disk?").** Two tiers:

| Tier | What | llama-cpp | MLX |
|---|---|---|---|
| in-engine memory | live KV, reused turn-to-turn within a session | slot KV | `_CACHE` dict |
| disk — per session | full prefilled KV (system + tools + transcript); resumes the *same* session after restart | `sess-<id>.bin` | `<cacheId>.safetensors` |
| disk — shared prefix | the cross-session win | **`prefix-gp-<hash>.bin`** | **`prefix-gp-<hash>.safetensors`** |

- **`prefix-gp` is the only shared layer actually seeded today.** It is **not** a fresh prefill of
  the system text — it is *copied from a real session's full slot save* (llama: `copyFile`
  sess→prefix on first save, `cache-adapter.ts:467`; MLX: `_seed_prefix_from_session`, once per
  process). So the **disk key is the stable system *text* hash, but the disk bytes are the full KV
  dump including the engine-templated tool schemas** — which is exactly why a sibling session reuses
  `[system + tools]` and not just the system text. A new session for the same (model, gezel,
  project) restores it, and `cache_prompt` (llama) / the LCP trim (MLX) reuses the shared head.
- **`prefix-gezel` is defined in the restore cascade but nothing seeds it yet** — a clean
  follow-up that would add cross-*project* reuse for a gezel. Currently inactive.
- Disk paths: llama `<home>/engines/llama-cpp/slots/<modelHash>[/replica-N]/`; MLX
  `<home>/engines/mlx/cache[/replica-N]/<model-fingerprint>/`. Both disk-LRU-pruned (§8,
  `llamaCppDiskCacheBudgetMb` / `mlxDiskCacheBudgetMb`, default 8 GB). MLX is fingerprint-segmented
  (load rejects a mismatch); llama models that 501 on slot-save (mmproj/multimodal) get no disk
  persistence.

**Measured result.** A cross-session A/B (same gezel+project, *different* task, shared cache root,
`--parallel 1`) on `gemma4-e4b-q8`: session B's prefill dropped **16,467 → 499 tokens (97%)** under
the flag (baseline cold-re-prefills because its whole-prompt hash differs on the inline task; the
flag's `prefix-gp` key is task-independent so B restores `[system + tools]`). Perf harness:
`evals/src/bin/ab-prefix-cache.ts`. **Quality (no regression):** a fuller anchor A/B — tictactoe,
petshop, tankcombat × 3 trials each, baseline vs treatment on `gemma4-e4b-q8` — scored **9/9 PASS in
both arms**, with input-token counts at parity (treatment adds only ~100 tokens of message framing).
Cold fresh-home trials show no duration delta (expected — they don't exercise cross-session reuse,
which is where the 97% lives).

**Engine coverage.** llama-cpp: fully wired + proven. MLX: wired + unit-tested AND now validated
end-to-end on a real MLX engine (`mlx-community/gemma-4-E4B-it-qat-4bit` via
`evals/src/bin/validate-mlx-layered.ts`) — session A seeds `prefix-gp` from its real save, session B
(different task) hits it via the `prefix_cache_ids` cascade and **reuses 18,060 `[system+tools]`
tokens** instead of cold-prefilling. The cache *mechanism* is proven on both engines; MLX is kept
**default-OFF** only pending an MLX anchor *quality* A/B (the llama 9/9 hasn't been repeated on MLX).
MLX also gets the **#1 stable-boundary keying for free** even without the layered ids, because its
adapter keys on the now-volatile-free system message.

> First-run note: MLX has no pre-built environment on a fresh machine, so the first MLX turn builds
> the `mlx-vlm`/torch venv (~10 min, ~70 packages) — which exceeds the hardcoded 300 s engine-startup
> budget, so the *first* turn after a clean install times out. The eval runner sidesteps this by
> symlinking a pre-built venv from `~/.gezel-dev`; the app's on-device bootstrap pre-provisions it.
> Subsequent runs (venv cached) start in seconds. Set `GEZEL_MLX_STARTUP_TIMEOUT_MS` (mirrors
> `GEZEL_LLAMA_STARTUP_TIMEOUT_MS`; default 300 s) to let a cold first MLX turn wait out the build.

---

## 4. The turn lifecycle — where the cache hooks fire

Within the turn loop, only three cache touchpoints fire, and they're split across layers:

1. **`prepareForSend(sessionId, systemMessage)`** — *awaited* in the provider send path before
   the request (`providers/llama-cpp/provider.ts:1420`, `providers/mlx/provider.ts:1110`). It
   registers the prefix mapping (`setSessionPrefix`) and, for llama.cpp, allocates/restores the
   slot (disk I/O); for MLX, fire-warms the gezel prefix. Doing it first ensures disk-restore
   completes before the slot is pinned.
2. **`buildRequestExtras(sessionId)`** — synchronous; its result is `Object.assign`-ed onto the
   request body. llama: `{cache_prompt: true, id_slot}`; MLX: `{cache_id, prefix_cache_id}`. If
   no adapter or no `sessionId`, llama falls back to a bare `cache_prompt: true` and MLX sends
   nothing (→ full re-prefill).
3. **`recordTurn(...)`** — fired by `ChatManager` after the assistant message is finalized
   (`chat/manager.ts:4064-4086`), local providers only:

   ```ts
   this.cacheController.recordTurn({
     providerName, sessionId, gezelId,
     approxPromptTokens: Math.ceil(promptChars / 4),   // chars/4 heuristic
     // wasHit deliberately omitted — reportUsage reconcile fills in the real picture
   });
   ```

   `recordTurn` updates LRU position and byte accounting. **`wasHit` is intentionally not passed
   per-turn** — a missing `wasHit` counts as a *miss* for hit-rate, so the manager-side hit-rate
   is a conservative floor; the authoritative token/byte truth arrives asynchronously when the
   controller polls `adapter.reportUsage()` (engine `/slots` or `/v1/cache/stats`).

This estimate-then-reconcile split is deliberate: `recordTurn` keeps a cheap running estimate
(`approxPromptTokens * 100 KB`); the 5-second reconcile loop replaces it with engine truth
(`controller.ts:320-348`).

---

## 5. Turn management — keeping the cache warm

The cache only pays off if a session's turns keep hitting the same warm engine. Gezel serializes
and routes turns through **three layers**, each guarding a different resource, all tuned for
cache locality.

### 5.1 L1 — `ProviderQueue` (the primary gate)

Each local provider owns one `ProviderQueue` (`providers/queue.ts`) — effectively per-engine. It
is a bounded-concurrency scheduler with two priority lanes (`interactive` / `background`) and
**cache-affinity scoring**, not a plain FIFO:

- `affinityScore` (`queue.ts:556`) prefers a `sessionId` match (score 2 = full-prefix warmth) >
  `gezelId` match (score 1 = system-prompt warmth) > unrelated. **This is the explicit cache-warmth
  scheduler** — same-session turns dispatch back-to-back so the engine's KV prefix stays hot.
- Interactive drains before background (capped at `interactiveConcurrency: 1`), with a
  **starvation guard** (`maxWaitMs`, 60 s) that forces an over-waiting item eligible by strict
  enqueue time.
- Per-turn/idle timeouts only start *after* the slot is acquired (the whole reason the queue
  exists); a turn aborted while still queued never reaches the engine.
- **`bypassQueue`** is the escape hatch for `ask_specialist`/`ask_gezel` sub-sessions
  (`chat/manager.ts:3888`) to avoid cross-engine ask-chain deadlocks; those turns still serialize
  at L2 (MLX) or land in the spare slot (llama).

### 5.2 L2 — `runExclusive` (MLX single-stream)

MLX has no multi-slot equivalent — one `gezel_mlx_server.py` process serves one stream at a time.
Its queue runs `concurrency: 1`, and a lower-level **promise-chain mutex**
(`acquireExclusiveEngineRequest` / `runExclusiveEngineRequest`, `providers/mlx/provider.ts:399`)
serializes *all* engine-touching work — chat streams **and** cache warms. Warming is itself a
GPU prefill; letting it run beside a live stream would starve the stream pre-first-byte, so the
adapter's `warm`/`warmPrefix` calls wrap in the injected `runExclusive`
(`cache-adapter.ts:199,249`).

### 5.3 L3 — `CapacityBroker` + `ProviderPool` (admission & eviction)

- **`CapacityBroker`** (`providers/native/capacity-broker.ts`) is admission control by
  *reservation accounting* (not RSS polling): budget = 60% of system RAM (80% on ≥96 GB),
  capped at 96 GB, overridable via `GEZEL_CAPACITY_BUDGET_GB`. Fallback resident estimates:
  MLX `1.3×` on-disk, llama `1.2×`. It answers yes/no per reservation; the pool turns "no" into
  eviction.
- **`ProviderPool`** (`providers/native/provider-pool.ts`) owns every local engine instance keyed
  by `engineKey = provider:modelId:replicaIdx`. `ensure` does spawn/adopt/reuse; `makeRoom`
  LRU-evicts idle engines to free headroom. Critically, **`evict` awaits `provider.shutdown()`
  so the disk-cache flush completes before the broker releases capacity**, and a *busy* engine is
  marked `draining` and given up to `drainWaitMs` (30 s) to finish in-flight turns rather than
  being killed mid-stream — the busy engine's KV is never sacrificed to an impatient model switch.

### 5.4 `EngineRouter` — session stickiness for KV locality

`bindForSession` (`providers/native/engine-router.ts:124`) persists an `engineKey` per session so
"KV cache lives in one process for the session's lifetime." It reuses the prior replica if still
resident, re-spawns at the same index if LRU-evicted, else picks the least-loaded replica.
Subsequent turns fast-path through an O(1) pool hit and never re-bind. Replica 0 keeps the
canonical slot/cache path; replicas 1+ get a `replica-N` subdir so concurrent clones don't
trample each other's disk caches.

### 5.5 `GpuArbiter` — LLM vs. image tenancy

`GpuArbiter` (`providers/gpu-arbiter.ts`) mediates the GPU only between the **LLM slot**
(llama.cpp) and the **image slot** (sd-cpp) — not MLX vs. llama (those compete only through the
memory broker). Policy is `coexist` (≥24 GB Apple-Silicon unified memory; both stay loaded) or
`swap` (acquiring one evicts the other, which lazy-restarts on its next turn). Long
non-preemptible work (VAE decode) takes a **lease** so a chat nudge can't evict it mid-decode.

### 5.6 How concurrency maps to slots

For llama.cpp the slot count is a **single source of truth** (`chat/manager.ts:10901`):
`config.providerConcurrency['llama-cpp'] ?? 2` drives the queue's `concurrency`, `llama-server`'s
`--parallel`, *and* the cache adapter's `slotCount` — so the queue never admits more concurrent
turns than the engine has KV slots (default 2 = 1 interactive + 1 background). MLX is always 1.

---

## 6. Policy: budgets, eviction, reconcile, pinning

The `SessionCacheController` (`cache/controller.ts`) is the engine-agnostic policy brain.

- **Budgets** are RAM-aware (`cache/budget.ts`): `<16 GB → 2 GB`, `16–32 → 4 GB`, `32–64 → 8 GB`,
  `≥64 → 16 GB`. Operator overrides via `config.cacheBudgetMb.{mlx,llama-cpp}` win. Boot-time
  `setBudget` calls before any adapter registers are stashed in `pendingBudgets` and applied on
  registration.
- **LRU eviction** uses watermarks: evict when usage ≥ budget (high = 1.0), stop at 80% (low =
  0.8). The gap prevents thrashing at the boundary. `low`-priority (pinned) entries are evicted
  last. Eviction calls `adapter.evict(sessionIds)` — which on llama saves the slot to disk
  *before* forgetting it.
- **Reconcile loop** (every 5 s, `unref`-ed) polls `adapter.reportUsage()` and *replaces* the
  controller's tracked entries with engine truth, preserving operator pins. Engines know their
  cache size more precisely than the controller's per-token estimate.
- **Pinning**: `pin(sessionId, 'low')` makes a session evict-last. Used by `prewarmSession` to
  pin the project's **voorman** session (§9).

There are effectively **two budgets per engine that must agree in spirit**: the controller's
out-of-process LRU (this section), and the engine's *own* in-process cap (`--cache-budget-mb` for
MLX; per-slot context for llama). The in-engine bound is the real OOM safety net; the controller
manages the same pool from outside and can drift between reconciles.

---

## 7. Invalidation discipline

Two controller methods do all invalidation: `invalidate(sessionId)` (one session, all providers)
and `invalidateProvider(providerName)` (whole provider). Both call `adapter.evict(...)`
best-effort.

| Event | Call site | Method |
|---|---|---|
| **Compaction** (`compactInFlight`) | `chat/manager.ts:5167` | `invalidate(record.id)` |
| **Archive** (`archiveSession`) | `chat/manager.ts:2928` | `invalidate(sessionId)` |
| **Delete** (`deleteSession`) | `chat/manager.ts:3146` | `invalidate(sessionId)` |
| **Reset / credential rotation** (`resetClient`) | `chat/manager.ts:5273` | `invalidateProvider(name)` |
| **Operator evict** `/api/cache/evict` | `chat/manager.ts:1187` | `invalidate(sessionId)` |
| **Operator clear** `/api/cache/clear` | `chat/manager.ts:1196` | `invalidateProvider(...)` |

**Why compaction *must* invalidate:** compaction rewrites the *middle* of the transcript
(collapsing N old turns into one synthetic summary), so the cached KV — which encodes the old,
longer sequence — diverges from the new prompt at the first compacted message. The reused prefix
would be wrong; dropping it forces a clean re-prefill against the shorter list
(`chat/manager.ts:5163-5167`). Note this invalidates the per-*session* `cache_id`, not the gezel
*prefix* hash — compaction touches `record.messages`, never the system prefix.

**Model switch** has no dedicated invalidate at the manager level: a provider rebuild goes through
`resetClient → invalidateProvider`, and a system-prompt change (which a tier swap can cause)
naturally rotates the prefix hash so the adapter seeds a new prefix and orphans the old — no
explicit call needed. The disk cache is segmented by model fingerprint so stale KV can never load
against new weights regardless.

> **MLX nuance:** MLX uses a more conservative compaction threshold (`chat/manager.ts:5024`), with
> a rationale comment rooted in *upstream* `mlx_vlm.server` behavior ("re-prefills from scratch").
> Our fork *does* preserve KV across requests via `cache_id`, but full-prefix reuse can still fall
> back to cold prefill on rotating-cache / mRoPE edge cases, so the conservative threshold is kept.

---

## 8. Persistence across idle-freeze and restart

KV state survives process death so a returning user doesn't pay cold prefill.

- **Disk format.** llama writes per-slot `.bin` files under a per-model fingerprinted
  `--slot-save-path` (`sess-<id>.bin`, plus `prefix-<hash>.bin` seeded from the first save). MLX
  writes **safetensors per `(model_fingerprint, cache_id)`** (`cache_persist.py`), atomically
  (`os.replace`), with a `SCHEMA_VERSION` and the fingerprint baked into metadata.
- **Fingerprint = correctness firewall.** On load, a fingerprint mismatch is a *hard reject*:
  an old cache against upgraded weights "produces garbage generation." `--persist-dir` without
  `--model-fingerprint` is refused outright. This is the single most important persistence
  invariant.
- **Two-stage idle freeze** (`providers/native/supervisor.ts`): the supervisor fires an
  `onFreeze` hook at **half** the idle budget that flushes the cache to disk *while the engine is
  still healthy* — `getCacheAdapter().flushAll()` (`POST /admin/flush` for MLX;
  `saveSlotForSession` per slot for llama). Full SIGTERM fires at the full idle budget (default
  **30 min**). So a SIGKILL in the freeze→stop window doesn't lose warm state. MLX cold start is
  1–3 min, so this matters more there.
- **Shutdown ordering (llama):** `flushAll()` runs *before* `supervisor.stop()` — once
  `llama-server` exits, the slot-save endpoint is gone (`providers/llama-cpp/provider.ts:650`).
- **In-engine LRU + disk pruning (MLX):** the fork evicts in-memory entries to 80% of
  `--cache-budget-mb` (never evicting the only entry), saving each to disk first; a separate
  disk-LRU prunes to `--disk-cache-budget-mb` (default 8 GB; 0 disables).

---

## 9. Warm paths

- **`prewarmSession(sessionId)`** (`chat/manager.ts:1219-1259`) — fire-and-forget on session open
  / cross-gezel handoff / consultation. It pins the **voorman** session against eviction, then
  calls `adapter.warm(sessionId, history)` with the persisted user/assistant messages (the shape
  the engine sees on a real send, minus the next user message). "By the time the send acquires the
  queue slot, the target engine likely has the cache warm — turning a cold-start handoff into a
  near-instant one."
- **Prefix warm (MLX)** — `prepareForSend` fire-warms the gezel prefix on every send (idempotent
  via `warmedPrefixes`): `POST /v1/cache/warm` with the system message and **`persist: true`**, so
  sibling sessions of the same gezel — even after a restart — inherit the warmed system prefix
  instead of cold-prefilling it. A system-only warm produces a true prefix of the first real turn.
- **llama "warm" is a near-no-op by design** — `llama-server` has no warm endpoint, and the
  `n_predict:0` trick would claim a slot exclusively and risk starving real sessions; llama relies
  on the disk `prefix-<hash>.bin` files instead.

---

## 10. Telemetry & operator surface

- **`/api/cache`** (`http/routes/cache.ts`): `GET /stats` → `ProviderCacheStats[]`; `POST /evict`
  `{sessionId}`; `POST /clear` `{provider}`; `POST /warm` `{sessionId}` (202, fire-and-forget).
- **Stats** per provider: `totalBytes`, `budgetBytes`, `warmSessionCount`, `hits`, `misses`,
  `recentHitRate` (over the last 50 turns), and per-session `{tokenCount, bytes, lastUsedAt,
  evictionPriority}`. These back the **EngineStatusPill** popover and the queue meter.
- Engine-truth hit signals surface in logs: `llama-server` `/slots` `n_cache_tokens`, and the MLX
  fork's `[cache] hit cache_id=… prior_tokens=N` / `disk-hit` / `prefix-hit` / `miss` / `saved`
  / `warmed` lines (the `hit`/`warmed` lines are parsed into engine-pill phases).

---

## 11. Configuration & environment reference

| Knob | Default | Effect |
|---|---|---|
| `config.cacheBudgetMb.{mlx,llama-cpp}` | RAM-tiered (§6) | Controller LRU budget per engine. |
| `config.providerConcurrency['llama-cpp']` | 2 | Slots = queue concurrency = `--parallel` = adapter `slotCount`. |
| `config.providerConcurrency['mlx']` | 1 | MLX queue concurrency (single-stream). |
| `config.llamaCppKvCacheType` | `q8_0` | `--cache-type-k/v` (`f16`, `q8_0`, `q4_0`). |
| `config.llamaCppNumCtx` / `GEZEL_LLAMA_NUM_CTX` | 65536 | Per-slot context (clamped to model native). |
| `config.llamaCppMlock` / `…FlashAttn` / `…UbatchSize` | off / off / unset | Optional launch flags. |
| `config.mlxNumCtx` | 32768 | TS-side compaction threshold only (not sent to engine). |
| `config.mlxKvBits` | **0 (off)** | `--kv-bits`; see §12 caveat. |
| `config.mlxPrefillStepSize` | 2048 | `--prefill-step-size` (peak-memory vs. speed). |
| `config.mlxDiskCacheBudgetMb` | 8192 | `--disk-cache-budget-mb` (0 disables disk pruning). |
| `config.localEngineIdleTimeoutMs` | 30 min | Idle SIGTERM; freeze fires at half. |
| `GEZEL_LLAMA_STARTUP_TIMEOUT_MS` / `GEZEL_MLX_STARTUP_TIMEOUT_MS` | 180 s / 300 s | Engine cold-start ceiling. Lift MLX's for a cold first turn that must build the `mlx-vlm`/torch venv (§3.6). |
| `config.layeredPrefixCache.enabled` / `GEZEL_LAYERED_PREFIX_CACHE` | llama-cpp **on**, mlx **off**, cloud **n/a** | Volatile-out restructure + layered `prefix-gp`/`prefix-gezel` keys (§3.6). Local-engine only. `enabled` overrides both engines; env (`1`/`0`) overrides config. |
| `GEZEL_CAPACITY_BUDGET_GB` | auto (60%/80%, cap 96) | Hard memory budget for engine residency. |
| `GEZEL_FORCE_BEHAVIORS` / `GEZEL_REMOVE_BEHAVIORS` | — | A/B inject/remove model-profile behaviors. |

---

## 12. Known limitations, gotchas & correctness invariants

1. **`cache_id` / `id_slot` must be present or caching is a no-op.** A missing adapter or
   `sessionId` makes MLX revert to upstream clear-every-turn behavior and llama lose per-session
   slot isolation. Historically the source of full-re-prefill regressions on pool replicas.
2. **MLX KV quantization is wired TS-side but unconfirmed end-to-end.** `--kv-bits` /
   `--kv-quant-scheme` are built in `chat/manager.ts` but are **not in the Python `argparse`** —
   default is **off** because 4-bit crashed on long prompts (`RotatingKVCache Quantization NYI`).
   Don't claim KV-quant works on MLX without verifying the fork actually consumes the flags.
3. **Empty-generation turns must not overwrite cache.** The MLX fork skips saving a 0-token state
   in its `finally`; saving it would clobber a good entry and force a full re-prefill next turn.
4. **Multimodal slot save returns 501.** mmproj-backed llama models (e.g. nemotron-nano-30b)
   reject `/slots ?action=save|restore`; the adapter latches `slotActionsUnsupported` permanently
   on the first 501 to stop log spam. In-session `cache_prompt` reuse still works; only disk
   persistence is disabled.
5. **Prefix sharing is hash-of-system-prompt.** Any change to a gezel's about, project context,
   or tools block rotates the prefix id; old files orphan and rely on disk-LRU — they are *not*
   actively migrated. Keep volatile bytes out of the prefix (§3.2) or you churn it every turn.
6. **`100 KB/token` lives in two places.** TS `ESTIMATED_BYTES_PER_TOKEN` and Python
   `_BYTES_PER_TOKEN` must stay in sync; both are fallbacks/estimates for accounting, not
   allocation.
7. **`registerAdapter` is keyed by `providerName`.** Pool replicas all register under the same
   name, so the controller's `reportUsage`/eviction tracks only the most-recently-registered
   adapter, while each provider still holds its own per-replica adapter. Per-replica usage isn't
   fully reconciled.
8. **slot-count is read twice from config** (`--parallel` and adapter `slotCount`), not threaded
   from one variable. They agree today; if a default ever drifts, the adapter could allocate
   `id_slot` values outside the server's real slot pool.
9. **Eviction drain is bounded to 30 s and can fail a model switch** ("model is busy") rather than
   kill a live turn. Deliberate — protects in-flight KV at the cost of an occasional user retry.
10. **The orphan reaper used to drop live KV.** A model switch's new supervisor once SIGKILL'd a
    sibling engine mid-turn (surfaced as a bare "terminated"); the `liveEnginePids` registry now
    skips engines a live supervisor owns. Only owner-less orphans are reaped.

---

## 12b. Open findings — measured 2026-08-18 (qwen3.8-27b-q4, M4 Max)

Two prompt-cache defects surfaced while investigating why MLX runs ~3x
slower than llama-cpp at equal task success (13/15 vs 13/15 on the
productivity set, 10/10 vs 10/10 on tictactoe/tankcombat). One is measured
and open; the other is llama-cpp's and is still unexamined. Note that
llama-cpp wins the wall-clock race while *also* running with no prompt
cache, so cache reuse cannot be the whole story on either side.

> **Read this first (2026-08-18): the cache was never the main cause.**
> Decomposing wall-clock into its terms showed prefill time is a *wash*
> between the engines — MLX prefills 2x the tokens at 2x the speed (477 vs
> 224 tok/s), for 55s vs 55s on tictactoe. The gap is decode VOLUME:
>
> | | tictactoe | tankcombat |
> |---|---|---|
> | wall-clock ratio (MLX/llama) | 3.17x | 3.35x |
> | decode tokens (MLX/llama) | 2.45x | 2.31x |
> | residual engine slowness | **1.29x** | **1.45x** |
>
> ~70-75% of the "3x slowdown" was MLX generating 2.4x more tokens for the
> same task, not running slower. Those tokens were **reasoning**, emitted on
> turns that had explicitly asked for thinking to be OFF — see
> "the root cause" below. Fixing the cache would have recovered a term that
> was already even. This is why four successive cache-shaped hypotheses all
> measured as inert.

### The root cause: `chat_template_kwargs` never reached the MLX template

`MLX_TUNING_MAP` routes `reasoning.enableThinking` and
`reasoning.templateKwargs` through `chat_template_kwargs`, and
`applyConstrainedTurnShape` additionally writes `enable_thinking: false` plus
a `reasoning_effort` downgrade for immediate-write turns. The MLX provider
sent all of it. The sidecar's `ChatRequest` never declared the field —
pydantic drops unknown keys silently — and `_build_prompt` then passed a
hardcoded `enable_thinking=True` to `apply_chat_template`.

So no reasoning setting of any kind could reach an MLX chat template. The
logs stated the contradiction plainly and it went unread for weeks: the
provider logged "thinking disabled" on 22 turns while the sidecar logged
`[think-budget] armed budget=4096 opens_in_think=True` on 41 of 49 — that
flag is derived from the rendered prompt literally ending in `<think>`.

Verified against qwen3.8-27b-q4's own template (tokenizer only, no weights):

```
enable_thinking=True   -> ...assistant\n<think>\n            (must reason)
enable_thinking=False  -> ...assistant\n<think>\n\n</think>\n (pre-closed)
```

Fixed by declaring the field and threading it through, defaulting to
`enable_thinking: True` so ordinary turns are unaffected. Two hazards the fix
had to handle, both discovered by probing the template rather than assuming:

  * Qwen 3.8's jinja `raise_exception`s on any `reasoning_effort` outside
    {xhigh, medium, low} — and a `TemplateError` is neither `TypeError` nor
    `ValueError`, so the pre-existing ladder would have let a bad catalog
    value kill every turn. The ladder now drops the depth dials one rung
    before the switch, and each rung catches `Exception`.
  * `xhigh` is the template's DEFAULT effort. Leaving the dial alone means
    reasoning at the model's most expensive setting.

Guarded by `providers/mlx/reasoning-template-kwargs-wiring.test.ts`.

Measured, paired arms on qwen3.8-27b-q4 (tictactoe n=10, tankcombat n=5;
llama-cpp n=5 as the reference target):

| | mlx before | mlx after | llama-cpp |
|---|---|---|---|
| tictactoe wall | 673s | **321s** (−52%) | 213s |
| tictactoe decode tokens | 5,262 | **1,524** (−71%) | 2,145 |
| tankcombat wall | 911s | **352s** (−61%) | 272s |
| tankcombat decode tokens | 7,816 | **1,947** (−75%) | 3,389 |
| pass | 10/10 | 14/15 | 10/10 |

The wall-clock gap closed from 3.2x/3.4x to ~1.5x/1.3x — which lands on the
1.29-1.45x residual the decomposition had already attributed to genuine
engine difference, so the remaining gap is the one term that was never a bug.
MLX now emits FEWER tokens than llama-cpp. The single failure is a
`model-stuck` repair loop; 14/15 vs 10/10 is Fisher p=1.0, and llama-cpp
suppresses reasoning on the identical turns while scoring 10/10, so there is
no evidence suppression harms repair.

Cache reuse improved but did NOT resolve: hit rate 26.6%→34.7% (tictactoe)
and 20.2%→26.5% (tankcombat), **median cached tokens still 0**. Reasoning
tokens were one contributor to prompt divergence, not the whole of it. The
re-prefill defect above remains open and independent.

### MLX: every turn re-prefills — CAUSE FOUND 2026-08-19

**The prefix cache is not a prefix of anything real.** `POST /v1/cache/warm`
renders its prompt with `_build_prompt(warm_messages)` — no tools — and
`CacheWarmRequest` has no `tools` field to pass, so it *structurally* cannot
render the tool-aware prompt. `_build_prompt` only takes the tokenizer's
tool-aware branch when `bool(tools) or bool(chat_template_override)`, so the
warm path renders through an entirely different branch than every real turn.

Qwen 3.8 puts the tool block at the TOP of the system message, so the two
prompts diverge at token 3 — `<|im_start|>system\n` and nothing more:

```
cached='<|im_start|>system\nYour role is "Meester".\n\n---\n\n## Your job is to ROUTE…'
prompt='<|im_start|>system\n# Tools\n\nYou have access to the following functions:…'
```

Measured: 6/6 untrimmable turns at `lcp=3` against caches of 2,311-3,347
tokens. So **every `prefix-hit` is a false hit** — it pays a disk load, an
eviction pin, and a misleading log line, then re-prefills from zero anyway.
This is why cache SIZE looked 52% recoverable while nothing was recoverable:
2,437 tokens were available and 3 matched.

Fixing it is not just "pass tools to the warm call". The prefix cache id must
then incorporate the tool roster, because a prefix warmed with roster A is a
false hit for a session with roster B — the same defect one layer down, and
harder to see. Roles carry different rosters, so this is the common case, not
an edge case.

Two hypotheses were tested and killed on the way, both worth not re-running:

  * **Snapshot boundary cut too far forward.** No: 6/6 diverged EARLY
    (lcp/cached = 0.00), 0/6 near the boundary. The boundary logic is fine.
  * **Fall back to the prefix cache when the session state is untrimmable.**
    No: the prefix shares the same 3 tokens, so the fallback recovers
    nothing. This one was derived from cache sizes and looked like a 52% win.

`ArraysCache` (below) remains true and remains the reason none of this can be
solved by trimming — but it is not the lever.

### Attempted fix — MEASURED AS A REGRESSION, gated off (2026-08-19)

Three changes were built against the false-prefix cause above, behind
`GEZEL_MLX_STABLE_PREFIX` (default OFF):

1. **Relocate the reasoning preamble** below the tool + about block, via a
   verified transform of the model's own template (`template_stability.py`)
   — anchored edit, adopted only if the patched render has the same token
   multiset AND actually buys prefix, else the original is kept.
2. **Warm with tools**, and key the prefix id by tool roster.
3. **Snapshot at the reasoning-stable boundary**, on both the session and
   warm paths, so the saved entry stops carrying a per-turn-volatile tail.

They work as designed. Divergence moved from token 3 to 6,830 of a
6,857-token cache, and a turn reused 6,980 tokens against 165 prefilled.
They still made the target metric WORSE, monotonically:

| arm | reuse % | prefill/trial | wall (median) | pass |
|---|---|---|---|---|
| off (baseline) | **34%** | **37,486** | 376s | 4/5 |
| +relocate +warm | 26% | 49,875 | 307s | 4/5 |
| +boundary (session) | 22% | 48,632 | 277s | 4/5 |
| +boundary (session+warm) | 14% | 43,586 | 292s | 1/1 |

Why: truncating saves at the stable boundary wins more matches but shrinks
what each match is worth, and warming with tools adds ~5-6K tokens of warm
prefill to the denominator. The wall-clock column looks better but the trial
spread is 255-793s against 260-759s at n=5 — **not established**, and driven
by decode, not prefill.

Two cautions for whoever picks this up:

  * **Fewer decode tokens after relocation is not self-evidently good.**
    Burying the reasoning-effort instruction after the about text may simply
    make the model obey it less. Any retry needs a QUALITY arm, not a speed
    arm.
  * **Prefill is ~20% of MLX wall-clock** (and the Theme F reframing above
    puts caching at ~14% of engine time for product-target models), so even
    a total success here is single-digit percent. Size the effort to that.

### MLX: why trimming can never be the answer

Measured over 10 trials on qwen3.8-27b-q4: 86 reuse events, **median 0
cached tokens**, 230,572 tokens re-prefilled, a 23.5% hit rate, roughly 16
minutes of avoidable prefill. The logs say it plainly — `[cache] prefix-hit
... prior_tokens=2527` immediately followed by `WARNING full prefill: ...
had divergent untrimmable state without a reusable prompt snapshot`. So
`cache_seed.trim_layers` is refusing and `seed_from_state` falls through to
`fresh-untrimmable`.

**CONFIRMED 2026-08-19.** `qwen3_5/language.py` builds the cache as
`[ArraysCache(size=2) if l.is_linear else KVCache() for l in self.layers]`,
and qwen3.8 is 48 `linear_attention` + 16 `full_attention` layers.
`ArraysCache.is_trimmable()` is `False` and it has **no `trim()` at all** —
correctly, because a linear-attention layer holds a fixed-size RECURRENT
state summarising every token it has seen; you cannot subtract the last N
tokens from it. `trim_layers` is all-or-nothing, so 48 honest refusals veto
the trim. **Trimming is therefore permanently off the table for this model
family** — every remaining avenue must make the prompt a pure EXTENSION
rather than rewind the cache.

An earlier diagnosis — that `mlx-vlm`'s `BatchKVCache` lacks
`is_trimmable()`/`trim()` — was **wrong**: that inspection read `mlx_lm`'s
copy while the sidecar imports `mlx_vlm`'s, which has had both since 0.6.6.
It was refuted twice: the class has the methods, and 0.6.14's rewritten
batched cache changed nothing. Both were aimed at the 16 full-attention
layers that were never the problem.

The end-of-prompt snapshot fallback does not rescue it. That path assumes
"the next turn's prompt re-templates the same history, so the snapshot is a
pure extension" — but our LCP is *partial*, not total, so the snapshot is as
unusable as the post-turn cache. It was also designed for windowed
(`RotatingKVCache`) models; qwen3.8 declares no sliding window yet still
runs with `prompt_snapshot=y`.

#### mlx-vlm 0.6.14 was tried and reverted

0.6.14 rewrites `BatchKVCache` (adding `finalize`/`state`/`filter`/`extend`/
`pad`/`extract`/`merge`). Under the retracted diagnosis it was the fix. A
paired A/B, 5 trials per scenario per arm, says otherwise:

| | 0.6.14 | 0.6.6 |
|---|---|---|
| tictactoe | 5/5 · 603 s to 1st artifact · 15.9 min | 5/5 · 484 s · **8.4 min** |
| tankcombat | 5/5 · 920 s · 23.3 min | 5/5 · 754 s · **12.7 min** |
| cache hit rate | 20.8% | 23.5% |
| median cached tokens | **0** | **0** |
| probe throughput | 40.7 gen tok/s | **55.8 gen tok/s** |

Task success is identical (10/10 both arms); duration is ~85% worse and the
cache did not improve. The pin stays at 0.6.6. Do not re-bump without a
hypothesis that survives this measurement.

### llama-cpp: `cache_reuse` — ANSWERED 2026-08-19

Every llama-server launch logs:

```
srv load_model: cache_reuse is not supported by this context, it will be disabled
srv load_model: initializing, n_slots = 1, n_ctx_slot = 262144, kv_unified = 'false'
```

Both of the earlier guesses about this were wrong, and are corrected here:

  * **"`--cache-reuse` is absent from the argv."** No — it is passed. The
    warning is only emitted when the flag WAS requested; that line is the
    engine declining it, not us omitting it.
  * **"Why is `kv_unified='false'` at a single slot? Unified KV is normally
    the single-slot case."** False premise. A dense control reports
    `kv_unified='false'` at `--parallel 1` too. It is normal at every slot
    count and was never the discriminator.

Measured by launching the bundled 0.1.36 engine (upstream `f8def7f`)
directly, one model at a time:

| context | `--cache-reuse` |
|---|---|
| dense (granite-vision 4b) | accepted |
| hybrid recurrent (qwen3.5/3.6/3.8) | declined — "not supported" |
| gemma windowed (SWA) | declined — "not supported" |
| gemma + `--swa-full` | accepted |
| dense, `--parallel 1` and `--parallel 4` | accepted both, no warning, no error |

So the discriminator is **whether the context's cache can be partially
rewound** — the same constraint that makes MLX's `ArraysCache` untrimmable,
one layer down and in a different engine. On qwen3.5+ the feature is
genuinely unavailable on both engines; that is a model-family property, not
an engine defect.

**But `cache_reuse` turns out to be a non-lever, so none of this is worth
chasing further.** Measured directly against gemma4-e4b:

  * *Basic prefix reuse does not depend on it.* Two turns sharing a 2,822-token
    prefix: the second prefilled **7 tokens** whether `cache_reuse` was
    enabled (`--swa-full`) or disabled (windowed). Cross-request extension
    comes from `cache_prompt` + slot KV retention and works either way. The
    "not supported" warning is therefore much narrower than it reads.
  * *It does not rescue a mid-prompt divergence either.* Prompt shaped
    `[shared][divergence][long shared tail]`, second turn re-prefilled
    **2,014 of 2,320 tokens with `--cache-reuse 256` AND with
    `--cache-reuse 0`** — byte-identical outcomes.

Combined with the catalog composition — **every** installed model is HYBRID
(qwen3.5+, can never use it) or SWA (gemma4, only with `--swa-full`), and not
one is plain dense — the practical value of this flag on this product is
approximately zero. The `engine-flags.ts` relaxation below is kept because the
rationale it replaced was factually wrong and would be re-derived otherwise,
NOT because it buys measurable performance. Do not spend an A/B arm on it.

Two consequences were acted on:

1. **The `slots === 1` suppression in `engine-flags.ts` was stale.** It
   withheld the auto-on default whenever slots !== 1, citing a b9843
   rejection that the current engine does not reproduce. Since the engine
   declines the flag itself exactly when it cannot honour it, withholding it
   only cost reuse on multi-slot dense engines. Now passed at any slot count.
   (Blast radius is modest here: all 55 observed launches on this box
   auto-sized to `slots: 1` under the KV memory ceiling.)
2. **`--swa-full` silently decides whether Gemma gets prefix reuse at all.**
   The flag is auto-enabled for Gemma only when weights + full KV fit fast
   memory (`swaFullAutoFits`). On a machine where they do not, Gemma launches
   windowed and *also* loses `cache_reuse`. A memory decision is therefore
   doubling as a cache-reuse decision, which is worth knowing when a
   smaller-RAM machine shows unexpectedly poor prefill reuse.

Still open: whether the qwen preamble-above-tools problem (see the MLX
section) is worth fixing on llama-cpp too. It is the same template property
and hits both engines, but llama-server takes its template from the GGUF and
would need `--chat-template-file`. llama-cpp already achieves 43% prompt-token
reuse on qwen3.8 (one turn at 92%), so any gain there sits on top of a
working baseline — unlike MLX, where reuse was ~0.

## 13. Key-file index

**Policy / contract**
- `packages/service/src/cache/controller.ts` — `SessionCacheController` (LRU, budgets, reconcile, pin, stats).
- `packages/service/src/cache/adapter.ts` — `EngineCacheAdapter` interface (the policy/mechanism seam).
- `packages/service/src/cache/budget.ts` — RAM-aware default budget tiers.
- `packages/service/src/http/routes/cache.ts` — `/api/cache/{stats,evict,clear,warm}`.

**Mechanism (per engine)**
- `packages/service/src/providers/llama-cpp/cache-adapter.ts` — slots, `cache_prompt`+`id_slot`, disk save/restore, 501 latch.
- `packages/service/src/providers/mlx/cache-adapter.ts` — `cache_id`/`prefix_cache_id`, warm/prefix-warm, `flushAll`.
- `packages/service/src/providers/mlx/python/gezel_mlx_server.py` — the cache-preserving fork; lookup cascade, warm, in-engine LRU.
- `packages/service/src/providers/mlx/python/cache_persist.py` — safetensors disk persistence + fingerprint firewall.

**Orchestration / prompt harnessing**
- `packages/service/src/chat/manager.ts` — `buildInstructions` (3-band ordering ~`:10652`), `recordTurn` (`:4064`), invalidation routing, `prewarmSession`, launch-flag assembly (llama ~`:11192`, MLX ~`:11646`), slot SoT (`:10901`).
- `packages/service/src/chat/scope-instructions.ts`, `chat/tools-block.ts` — stable-prefix content builders (no-churn slicing).
- `packages/service/src/model-profile/behaviors/` — late-band content shapers (compact-tool-schemas, cookbook-condensed, preamble-folding, flatten-tool-transcript).

**Turn management / serialization**
- `packages/service/src/providers/queue.ts` — lanes + cache-affinity scheduler, `runInQueue`.
- `packages/service/src/providers/mlx/provider.ts` — `runExclusive` single-stream mutex; `providers/llama-cpp/provider.ts` — slot/lane wiring, shutdown flush.
- `packages/service/src/providers/native/{capacity-broker,provider-pool,engine-router,engine-key,supervisor,port}.ts` — admission, pooling, session-sticky routing, two-stage idle-freeze, orphan reaper.
- `packages/service/src/providers/gpu-arbiter.ts` — LLM↔image GPU tenancy.
