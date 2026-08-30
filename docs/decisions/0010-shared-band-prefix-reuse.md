# 0010 — Shared-band prompt-prefix reuse on MLX

Status: Accepted (2026-08), shipped default-OFF behind `mlxSharedBandPrefix`

## Context

A ten-batch Pull Request Review fans out ten sessions with the same gezel, the
same project, and the same craftbook. They differ only in which 25 files each
one reviews. They should share a warm `[tools + stable system]` KV prefix and
pay one cold prefill between them.

They shared nothing. Every sibling cold-prefilled ~60K tokens, which is the
dominant cost of a fanout — and, because a turn arriving mid-wave waits for the
running wave to fully drain, it is also why a second batch appears to "hang"
behind the first for minutes.

This record exists because the surrounding area has already produced two wrong
diagnoses and one 6.6x-waste incident, and because the fix touches cache
*identity* — the kind of thing that gets re-litigated every time someone new
reads the code. The alternatives below are closed, not open.

### Measured, 2026-08-30, qwen3.8-27b-q4 / MLX

| Evidence | Result |
| --- | --- |
| Two live sibling sessions' rendered system prompts | share a literal **33,742-char (~8.4K tok)** prefix, diverging only at the task number |
| Their `prefix_cache_id`s | **4 sessions → 4 distinct ids** — sharing was arithmetically impossible |
| Engine probe: short entry, longer prompt, different `cache_id` | `mode=extension reused=7202 prefill=822` — **89.8% reuse** |
| The next engine log line, unprompted | `prefix-seeded … tokens=8008` — the full session state overwrote the 7,202-token entry that had just worked |
| A 961-token entry in production logs | `mode=fresh-untrimmable reused=0` — short, but not a *token* prefix |

Three causes, each independently sufficient:

1. **Keying** — `gezelPrefixId` hashed the whole system prompt, so the task band
   churned the id on every sibling.
2. **Clobber** — `_seed_prefix_from_session` published the donor's *full* state.
   Its docstring assumed the consumer would trim.
3. **False hits** — an entry rendered through a different chat-template branch
   shares ~3 tokens and still costs a disk load, an eviction pin, and a full
   prefill.

Cause (2) is fatal rather than merely wasteful because trimming is impossible
here: 48 of qwen3.8's 64 layers are linear-attention `ArraysCache` holding a
fixed-size recurrent state with no `trim()`. `cache_seed.seed_from_state`
therefore reuses an entry **only** on `lcp == n` (strict prefix → `extension`);
anything else is `fresh-untrimmable`, a full re-prefill. See
[kv-prompt-caching-strategy.md](../kv-prompt-caching-strategy.md) §"MLX: why
trimming can never be the answer", whose conclusion this record implements:
*"every remaining avenue must make the prompt a pure EXTENSION rather than
rewind the cache."*

> **Do not re-diagnose (2) as `BatchKVCache` lacking `trim()`.** That inspection
> was wrong and was refuted twice — it read `mlx_lm`'s copy while the sidecar
> imports `mlx_vlm`'s, which has had both methods since 0.6.6. The cause is
> linear attention, and no cache-class change will alter it.

## Decision

Key the prefix entry on the **shared band** — the leading run of the system
prompt that siblings render identically, everything before `taskContext` — and
publish that entry from a real turn's **boundary snapshot** so it stays short.

Two invariants, both enforced in code and both load-bearing:

- **A prefix entry must be a strict token prefix of its consumers' prompts.**
  `lcp == n` is the only branch that reuses anything on this model family.
- **A prefix entry may never be replaced by a longer one.** Lengthening is never
  an improvement; it converts a working entry into a full re-prefill for every
  sibling.

Mechanically:

- `buildInstructions` returns `sharedPrefix` alongside `full` on the flat path.
  It is a literal byte-prefix — the concatenation order is unchanged and `full`
  is byte-identical to before.
- `MlxCacheAdapter` hashes that band into a **separate `prefix-band-`
  namespace**, keeping the tool roster in the key (§3.7 is unchanged), and sends
  the band's character length as `stable_prefix_chars`.
- The sidecar turns that character offset into a token index
  (`cache_seed.token_boundary_for_marker`, bisecting on "first token index whose
  decode contains the band's tail" — only the engine has the tokenizer, and the
  render carries template framing plus the tool block ahead of the system
  content) and plants the existing prompt-snapshot cut there.
- **Only a session that reused nothing publishes the band.** That "pioneer"
  saves the band as its own entry and re-prefills its tail next turn; every
  sibling after it inherits and skips the band. One session pays so N−1 do not,
  which preserves the intra-session reuse that already works
  (`extension reused=91413 prefill=290`).
- **The prefix is re-checked when the wave starts, not only when the request
  arrives.** The lookup in the `chat_completions` handler runs at HTTP arrival;
  a band is published when its pioneer's turn *ends*, and static-wave admission
  puts minutes between the two. Every sibling dispatched alongside the pioneer
  — the entire fanout case — therefore resolved `fresh` before the entry
  existed. `_seed_args` retries the lookup when the sub still has no usable
  seed state.

Default OFF. The flag exists because failures in this area are *slowness, not
errors*, which is what made the previous incidents take so long to find.

## Alternatives rejected

**Port `layeredPrefixCache` to MLX.** It restructures the prompt into two
`system` messages, and the Qwen chat template raises on exactly that:

```jinja
{%- if message.role == "system" %}
    {%- if not loop.first %}
        {{- raise_exception('System message must be at the beginning.') }}
```

Measured on qwen3.8-27b: **2/2 pass with the flag off, 0/2 with it on**, both
failures `TOOLS DROPPED … System message must be at the beginning.` → HTTP 500.
Every prior validation of that feature — the llama-cpp 9/9 quality A/B and
`evals/src/bin/validate-mlx-layered.ts` — ran on **Gemma**, whose template the
layout was designed for. Separately, its `gp` id would key on 22,053 chars where
33,742 are actually shared, because workspace map/files/documents are tagged
volatile yet are identical across siblings in one project.

**Make trimming work.** Permanently impossible on this model family (above).

**Warm the band synthetically instead of snapshotting a real turn.** Cheaper to
build, but it re-enters the surface that caused the 40-re-prefill oscillation:
a synthetic render takes a different template branch, and `persist: true` writes
that shape over a good entry. Snapshotting a real turn produces a genuine token
prefix by construction, so cause (3) cannot arise on this path at all.

**Reuse the existing `prefix-` namespace.** A band entry is deliberately short
and a legacy entry holds a whole session; a collision between the two shapes is
a full re-prefill rather than a miss, so the namespaces are kept disjoint.

## Qwen on llama-cpp — investigated, NOT a bug

`layeredPrefixCache` defaults **ON for llama-cpp**, gilde ships Qwen there
(`qwen3.8-27b-q2/q3/iq1-s` are GGUF-only; `qwen3.6-27b` and `qwen3.5-9b` ship
both engines), the llama-cpp session pushes the same second `system` message
(`provider.ts` constructor), and llama-server is launched with `--jinja`, so it
renders the GGUF's own template. Every precondition for the MLX failure holds.

It still does not reproduce, because **the template differs by repacker**.
Parsed from `tokenizer.chat_template` in each artifact (2026-08-30):

- `mlx-community/Qwen3.8-27B-4bit` — 8,952 chars, no merge logic:
  `{%- if message.role == "system" %}{%- if not loop.first %}{{- raise_exception(…) }}`.
  Any system message past index 0 raises.
- `unsloth/Qwen3.8-27B-GGUF` — 9,993 chars, merges the leading run:

  ```jinja
  {%- set sysns = namespace(count=0, text='') %}
  {%- for message in messages %}
      {%- if sysns.count == loop.index0 and (message.role == 'system' or message.role == 'developer') %}
          {%- set sysns.text = sysns.text + ('\n' if sysns.text else '') + sys_content %}
          {%- set sysns.count = sysns.count + 1 %}
      {%- endif %}
  {%- endfor %}
  {%- set num_sys = sysns.count %}
  ```

  The main loop then skips those (`{%- if loop.index0 >= num_sys %}`) and raises
  only for a `system` message appearing *after* the leading run.

Two leading system messages are therefore explicitly supported on the GGUF
artifact. No llama-cpp change is needed, and its ON default stands.

**The generalisable lesson, which is the reason this is recorded rather than
dropped:** a chat-template constraint belongs to the *artifact*, not the model
family, the architecture, or a sibling quant — two repacks of one base model
disagreed here. Read the artifact's own template before reasoning about prompt
shape. For a GGUF that costs a ranged fetch of the first ~12 MB and a
50-line GGUF header parse, not a weights download.

## Validation — measured end-to-end 2026-08-30

Two sibling task sessions of one gezel+project, real prompts, flag on:

```
band-boundary chars=13177 target=36576 prompt_tokens=39446
seed ad209603 mode=fresh     reused=0      prefill=39446   <- pioneer, cold
prefix-seeded prefix-band-dd0e075cb2034d8c … tokens=36576  <- publishes the band
prefix-seed   403a07c8 from prefix=…                       <- late re-check, 7ms later
seed 403a07c8 mode=extension reused=36576 prefill=2867     <- sibling: 92.7% reused
seed ad209603 mode=extension reused=36576 prefill=3094     <- pioneer turn 2
seed 403a07c8 mode=extension reused=39427 prefill=240      <- steady state
```

Three things this settles:

- **Keying works on real prompts.** Two live sessions that previously minted
  distinct ids produced the same `prefix-band-…`; on the production koray
  prompt the TS side computed `chars=33710`, within 32 characters of the 33,742
  measured independently from two other live prompts.
- **`chars` ≪ `target` is the mechanism, not a fault.** 13,177 chars of system
  text resolves to token 36,576 of 39,446 because the Qwen template renders the
  tool block *ahead* of the system message (§3.7). The reusable prefix is
  `[tools][band]` and the tool block dominates it — which is why the reuse
  fraction is so high, and the strongest argument for band keying over
  whole-prompt keying.
- **The pioneer tax is small.** The worry was that publishing shrinks the
  pioneer's own entry to the band, costing a solo session a large re-prefill
  next turn for nobody's benefit. Measured at ~2,900 extra tokens (~7% of one
  turn's prefill, once), because the band is a valid prefix of the pioneer's
  *own* next prompt and it extends from it. Not a reason to complicate the
  "any fresh session publishes" gate.

The wave-admission race was found by exactly this run, after unit tests and a
synthetic single-engine probe had both passed — the probe ran the pioneer to
completion before issuing the sibling request, which is the one ordering that
hides it. Any future change here needs a two-sessions-dispatched-together test,
not a sequential one.

## Regression surface

- `cache-adapter.test.ts` — siblings differing only in the task band share one
  id; the roster still separates ids; band and legacy namespaces are disjoint;
  omitting the band is byte-identical to today.
- `cache_seed_test.py` — the boundary helper, and the property that matters: a
  state saved *at* the boundary extends, one saved a token past it reuses
  nothing.
- The live signal is the engine log, in `~/.gezel-dev/logs/mlx-server-*.log`
  (not `service-*.log`): `[batch] seed … mode=extension reused=<band>` on a
  sibling, and `[cache] prefix-keep …` when the never-lengthen guard fires.
