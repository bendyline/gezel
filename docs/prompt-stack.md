# The prompt stack — how gezel briefs a model, local vs. cloud

Status: written after the Craftbooks V2 round. Measured sizes below are from
that review — re-measure with `GEZEL_PROMPT_BREAKDOWN=1` (per-section token table printed by
`buildInstructions`) rather than trusting this doc or any docblock.

## The mental model

Every provider gets a real system prompt from us. There is one builder —
`buildInstructions` in [chat/manager.ts](../packages/service/src/chat/manager.ts) — and it
runs for every session on every provider. The differences between local and cloud are not
"local has no system prompt"; they are:

1. **What sits underneath ours.** Local engines render our text through the model's chat
   template and nothing else. Claude CLI and Codex CLI stack ours *on top of* their own
   shipped agent prompt. Copilot *replaces* the SDK's default system text with ours. The
   raw OpenAI/Anthropic APIs carry ours alone.
2. **Which of our layers render.** Layers self-gate on tier, role, provider, and project
   state. A meester on qwen-27b and the same meester on claude-cli get materially
   different prompt bodies from the same builder call — by design.

Two channels carry everything the model is told:

- **The system prompt** — per-session, rebuilt on about.md/tools drift, carries identity +
  context + standing conduct rules.
- **The user-message channel** — per-turn steering: preludes prepended to the user's text
  and post-turn nudges issued as synthetic continuation turns. Turn-scoped guidance goes
  here, never in the system prompt, because it must not persist past the turn and must not
  invalidate the prompt-cache prefix.

## Channel one: the system prompt, layer by layer

Order is fixed in `buildInstructions`. Conditions are the interesting part:

| # | Layer | Included when | Size (approx) |
|---|---|---|---|
| 1 | Role header (`Your role is "<role>".`; neutral gezel fallback when unset) | always | 1 line |
| 2 | Routing guardrail (`## Your job is to ROUTE, not to BUILD`) | pure-delegation roles (meester/voorman/planner); crew-density installs emit it only on `anthropic-cli`/`codex-cli` (their vendor prompts are build-biased coding agents); flat-density installs emit it for any delegation role | ~2.3K ch |
| 3 | About intro + **the gezel's `about.md`, verbatim** | always | meester template ~4.6K ch |
| 4 | `### Traits` | frontmatter traits present | varies |
| 5 | `### Lessons from past work` (distilled `memories/lessons.md`) | lessons exist | small, curated |
| 6 | Project context: intro + voorman line, `### About this project` (tier-scoped for tiny/small/medium), `### Mission objectives` (**only for the project's voorman**), `### GitHub repository`, `### Where work belongs` | project set; sub-blocks by project state | varies |
| 6b | `### Workspace map` — index-derived gestalt: deep-pass architecture note + folder purposes + entry points ([chat/workspace-gestalt.ts](../packages/service/src/chat/workspace-gestalt.ts)) | `prompt.workspace-gestalt` behavior on the profile (tier-default medium/large) AND the deep pass has produced summaries | ≤ ~300 tok |
| 7 | `### Workspace files` listing (cap 200); with `prompt.retrieval-first` on the profile (tier-default tiny/small/medium) a one-line "locate with `search`/`grep_files`" steer is appended when those tools are in the session surface | project has files | varies |
| 8 | Shared documents library listing | documents exist, not executor-trimmed | varies |
| 9 | `### Current task` + `#### Step procedure` + `#### Phase gate` | task-scoped session | varies; procedures can be large |
| 10 | `### Tasks assigned to you in this project` | not task-scoped, assignments exist | varies |
| 11 | `### Recalled from prior sessions` legacy compatibility block | only when ChatManager is embedded without the scoped SearchService wiring | ~4–7 bullets |
| 12 | Conduct core: **act-don't-narrate** (558 ch), **ask_user_question when stuck** incl. "a short message is not vague when task context is above" (1,414 ch), **markdown guidance** incl. the Squisq-dialect brief (`SQUISQ_DIALECT_BRIEF` from [prompts/squisq-dialect.ts](../packages/service/src/prompts/squisq-dialect.ts) — mermaid fences + `{[template]}` annotations; the long example-led sibling `SQUISQ_DIALECT_NOTE` goes into the transform one-shot prompt, context-gated) (~490 ch) | always, every provider | ~2.5K ch / ~620 tok total |
| 13 | Browsing guidance (Playwright present vs "not installed, don't emit fake `browser_*`") | non-delegation roles | 1–3 lines |
| 14 | `## Handling external (untrusted) content` | mail-enabled projects | ~850 ch |
| 15 | **Behavior `promptAppend` walk** (the old "local hints") | per resolved model profile — see next section | 0 to ~9.4K ch |
| 16 | `## Tools available this turn` ([chat/tools-block.ts](../packages/service/src/chat/tools-block.ts)) | tiers tiny/small/medium only; skipped for providers without an MCP bridge (copilot, the CLI providers); per-gezel `tools.md` overrides; bridge-failure notice overrides all | tiny: full descriptions; small/medium: names-only |
| 17 | File-edits-off notice / consultation-mode addendum / fresh-project addendum | lockdown / spawned consultation / ≤5 workspace files | ~1–2K ch each |
| 18 | Active-task anchor (recency anchor, deliberately **last**) | task-scoped | 1 paragraph |

### The two bands (KV-prefix caching)

On llama-cpp (default; `config.layeredPrefixCache`), the same layers are split into a
**stable** system message (identity + project + conduct + hints + tools — the cacheable
prefix) and a **volatile** context message (workspace listing, documents, task context,
assignments, recall — everything that changes between sessions/turns), so a re-prompt
doesn't invalidate the whole KV prefix. Cloud providers would silently drop the volatile
band, so the split is gated to local providers. Details:
[kv-prompt-caching-strategy.md](kv-prompt-caching-strategy.md).

### Model-profile behaviors: capability-inverse coddling

Prompt text that exists *because of model limitations* does not live in `buildInstructions`
conditionals — it lives in behaviors
([model-profile/behaviors/](../packages/service/src/model-profile/behaviors/), registry in
[model-profile/registry.ts](../packages/service/src/model-profile/registry.ts)) selected by
the model's catalog manifest, or by tier defaults
([model-profile/defaults.ts](../packages/service/src/model-profile/defaults.ts)) when the
manifest declares none. Tier boundaries
([chat/local-model-tier.ts](../packages/service/src/chat/local-model-tier.ts)): non-local
provider → `cloud`; else by parameter count — <5B `tiny`, <12B `small`, <45B `medium`,
≥45B `large` (unknown local → `tiny`).

Tier-default prompt text:

| Tier | promptAppend behaviors | Other defaults |
|---|---|---|
| tiny | `prompt.tool-cookbook-full` (~2.3K tok — tool-use rules table + "what NOT to do") | schema relaxation, missing-field defaulting, fabrication detector, continuation budget 4 |
| small | `prompt.tool-cookbook-condensed` (~690 tok — 10 anti-fabrication rules) | fabrication detector |
| medium | **none** | fabrication detector |
| large | **none** | fabrication detector |
| cloud | none | none |

**The tier table is only the floor — it applies solely to models whose manifest declares
no `behaviors` array** (third-party imports, hand-installed weights). Every bundled
catalog model declares its set explicitly, and curation routinely overrides tier
intuition: `qwen3.6-27b-q4` (medium) declares `prompt.tool-cookbook-condensed` plus ten
more; `gemma4-12b-q4` (also medium) declares the FULL cookbook plus
`prompt.terse-visible-reply` and `prompt.prefer-writefile-edits` — more standing text
than small-tier defaults would grant. Before reasoning about (or A/B-ing) what a model's
prompt contains, read its root `manifest.json`, not this table. Wild-caught: a
force-add A/B of the condensed cookbook on qwen3.6-27b ran control-vs-control for 36
trials because the manifest already declared the behavior — `GEZEL_FORCE_BEHAVIORS`
skips already-present ids (it now warns loudly, and `ab-prompt-conduct` refuses provably
inert arms up front).

Universal defaults (every profile): `tools.gezels-as-roles` and
`prompt.meester-craftbook-prelude` (self-gating — inert unless the turn matches).

The intent stays capability-inverse — **the coddling budget scales inversely with what
the model can carry** — but the dial is per-model curation in the manifest; tier defaults
are the conservative floor for models nobody has curated.

### Minimal-context mode: when the standing prompt doesn't fit at all

The whole layer stack above assumes the model can *hold* it. `talkie-1930-13b-q4` (a
2048-token period-writing model) can't: the standing prompt needed ~2,681 tokens against
its 2,048 window, so the engine rejected even "hi there" before generating a token. The
`prompt.minimal-context` behavior handles this class. It's a marker (like
`prompt.executor-context-trim`) resolved into a `minimalContext` flag in
`buildInstructions`, and it **auto-activates** when the model's catalog `contextWindow`
is at/below `MINIMAL_CONTEXT_MAX_WINDOW` (4096) — no per-manifest opt-in required, though
a manifest may declare it explicitly (talkie does).

When active, `buildInstructions` early-returns a stripped prompt — **header + the gezel's
about.md (capped to ~900 chars) + one short "you have no tools, just converse" line** —
and drops every other layer (guardrail, project context, workspace/documents, task blocks,
recall, the full conduct core, the tools block). The floor falls from ~2.7K tokens to
~350, leaving the window for the conversation. This is deliberately lossy: a model in this
mode does conversation and short writing, not tool-driven or project work — pair it with
the `just-chat` project type, which hides the work-oriented tabs to match. Tests:
[chat/manager-minimal-context.test.ts](../packages/service/src/chat/manager-minimal-context.test.ts).

## Channel two: the user-message channel

- **Indexed context** (`resolveTurnProjectRetrieval`): a scoped, diversified
  evidence block from the active project, current gezel memory, and shared
  library. Off/Lean/Balanced/Deep plus a context-window ceiling bound its size.
  This changes with the turn without rebuilding the system prompt; see
  [Project retrieval and indexed context](project-retrieval.md).
- **Preludes** (`resolveUserPromptPrelude` — first non-null wins, prepended to the user's
  text): `prompt.meester-build-prelude` (meester + build-shaped request → one
  `start_project` kickoff; staffing is runtime-selected) and
  `prompt.meester-craftbook-prelude` (meester + procedure/recurrence-shaped
  request → suggest-then-invoke or craftbook_write authoring steer).
- **Nudges** (synthetic continuation turns after stall detection): `CONTINUATION_NUDGE`
  (described-but-stopped), `CLOSING_SUMMARY_NUDGE` (tool ran, no closing words),
  `VOORMAN_IDLE_NUDGE` / `VOORMAN_NOT_DONE_NUDGE`, plus gate-rejection and
  deliverable-edit re-prompts from the task system.
- **Post-turn detectors** (fabrication detectors, tool-error auto-acknowledge, inline-JS
  validation) also re-prompt on this channel.

Rule of thumb: if the guidance depends on *this turn's* content or state, it goes on the
user channel. The system prompt is for standing facts and standing conduct.

## Delivery per provider

| Provider | Mechanism | Vendor baseline under ours | Re-send cadence | Drift pickup |
|---|---|---|---|---|
| llama-cpp / mlx / ollama (+ds4 via delegation) | `system`-role message at `messages[0]`, rendered by the model's chat template | none (template only) | every turn | rebuild on drift + live `setSystemMessage` refresh |
| anthropic (API) | `system` field, `cache_control: ephemeral` | none | every turn | rebuild on drift |
| openai (Responses API) | `instructions` field, **re-sent on every request** | none | every turn | rebuild on drift |
| copilot (SDK) | session config `systemMessage: { mode: 'replace' }` | SDK default text **replaced**; SDK harness still owns tools/permissions | applied at create and on every resume | rebuild on drift |
| anthropic-cli (Claude Code) | `--append-system-prompt-file` | full Claude Code agent prompt, ours **appended** | per spawn | rebuild on drift |
| codex-cli | `instructions` key in per-session `config.toml` (AGENTS.md auto-discovery disabled via `project_doc_max_bytes = 0`) | Codex base agent prompt, ours layered on | per session | rebuild on drift |

Incident worth remembering (found and fixed during this review): the
OpenAI provider originally sent `instructions` only when there was no
`previous_response_id`, on the assumption the server carried them forward. The Responses
API explicitly does **not** carry instructions across `previous_response_id` — so every
OpenAI session ran turns 2+ with *no system prompt at all* (no about.md, no project
context), and about.md edits never reached the model. The fix is to re-send
`instructions` on every request ([providers/openai.ts](../packages/service/src/providers/openai.ts));
`previous_response_id` carries only the conversation items. When wiring any provider with
server-side session state, verify which parts of the request are actually persisted.

## Worked example: the same meester, five providers

What a meester session in a project actually receives:

| | qwen3.6-27b (local, medium) | gemma4-12b (local, medium) | claude-cli | copilot | gpt via API |
|---|---|---|---|---|---|
| Vendor rules of the road | — | — | Claude Code's full prompt | — (replaced) | — |
| about.md + project context | yes | yes | yes | yes | yes |
| Conduct core (~450 tok) | yes | yes | yes (duplicates vendor's, harmlessly) | yes | yes |
| Routing guardrail | flat installs only | flat installs only | yes | flat installs only | flat installs only |
| Cookbook rules (manifest-declared) | condensed (~690 tok) | full (~2.3K tok) + terse-reply + edit-by-line | — | — | — |
| Tools block | names-only | names-only | — (native tools) | — (native tools) | — (cloud tier) |
| Two-band cache split | yes | yes | — | — | — |

Two things this table makes visible:

1. **Copilot is closer to local than to claude-cli.** Because we `replace` the SDK's
   system text, a Copilot session's only textual rules are our conduct core + about.md.
   That has worked (Copilot models are frontier-class), but it is a deliberate posture,
   not an accident — we chose character control over the SDK's default text.
2. **The thinnest-briefed models are manifest-less imports, not bundled mediums.** A
   third-party 27B with no catalog manifest runs on bare tier defaults — a fabrication
   detector and nothing else — while the bundled qwen3.6-27b carries a curated
   11-behavior set. The live empirical questions are therefore (a) whether each declared
   standing block still earns its tokens on the model it's declared for (removal A/Bs),
   and (b) whether manifest-less medium/large imports deserve a richer tier floor. The
   Craftbooks V2 rounds showed medium-tier failures are dominated by execution
   follow-through stalls — the class the nudges catch post-hoc — so removal verdicts
   must watch the stall metrics, not just pass rate.

## Principles (the strategy, memorialized)

1. **about.md is character, not rules and not tool listings.** Role, expertise, working
   style, preferences. Standing conduct that applies to every gezel goes in the conduct
   core; model-specific compensation goes in behaviors; the tool surface is injected at
   build time from the post-allowlist bridge (the McKinley Park incident is why: an
   about.md that names tools drifts, and the model fabricates calls to tools that don't
   exist).
2. **One builder, self-gating layers.** Never fork "the local prompt" from "the cloud
   prompt" wholesale. A layer that should differ gates itself on tier/provider/role inside
   the one pipeline, so every session shape stays inspectable in one place.
3. **Capability-inverse budgets.** Prompt text compounds — guardrail + about + project +
   tools can pass 2K tokens before the user's first word, and verbosity costs attention at
   depth, most where models are smallest. Every added block needs an answer to: "is this
   for the model, or for a future engineer reading the prompt?" Imperative beats
   explanatory ("Do X." not "Because models sometimes…, you should X."). Measure with
   `GEZEL_PROMPT_BREAKDOWN=1`; docblock size claims go stale.
4. **Don't duplicate the vendor prompt; override it where our role model differs.** On
   claude-cli/codex-cli we accept their rules of the road and add only what they get
   wrong for us — chiefly that their build-biased coding instincts fight delegation roles
   (hence the routing guardrail's provider gate).
5. **Turn-scoped steering rides the user channel.** Preludes and nudges never contaminate
   the system prompt or the cache prefix, and they land where small models weight hardest
   — the last message.
6. **Prompt text lives in exactly two homes.** Standing/universal text: `buildInstructions`
   in [chat/manager.ts](../packages/service/src/chat/manager.ts). Model-conditional text:
   a behavior in [model-profile/behaviors/](../packages/service/src/model-profile/behaviors/).
   Nothing model-conditional hides in manager conditionals; nothing universal hides in a
   behavior. (`chat/local-model-tuning.ts`, the pre-behaviors home of this text, no longer
   exists.)
7. **Every prompt change is A/B-able without a rebuild.** `GEZEL_FORCE_BEHAVIORS` /
   `GEZEL_REMOVE_BEHAVIORS` (applied in
   [model-profile/runtime.ts](../packages/service/src/model-profile/runtime.ts)) toggle any
   behavior per daemon; the eval harness exposes them per trial (`forceBehaviors` /
   `removeBehaviors`). New standing text should ship as a behavior first so it can be
   measured before it becomes default.

## The about.md layer — audit

The 12 bundled gezel templates split cleanly: the four smallest (copywriter 806 ch,
planner 860, boekwachter 1,319, designer 2,561) follow the style guide; the six largest
and highest-traffic (developer **10,924 ch**, voorman 8,489, researcher 4,785, reviewer
4,682, meester 4,633, builder 4,527) all violate it — every one enumerates tool names,
and every one duplicates runtime-injected blocks. Worst offenses, verified line-level:

- **developer** (instantiated in 11 of 18 eval scenarios) carries a near-verbatim copy of
  the runtime ask-when-stuck block, three anti-fabrication cookbook rules, the
  act-don't-narrate "trust your schema" line, a paragraph *describing the runtime's own
  ramble cap*, and a frontier-level ES-module essay — a 7B pays for the same rules twice.
- The **"HTML asset paths" block is triplicated verbatim** across developer, builder, and
  designer — copy-paste drift waiting to happen; it belongs in the runtime
  "Where work belongs" family (it's workspace mechanics, not character).
- The historical **meester about duplicated the build-prelude** (project-vs-job
  selection guidance was delivered twice on every build-shaped turn), and its docblock
  claims "no tool enumeration" while the body names ~9 tools.
- **researcher ships eval-scenario references** ("the squisq-review scenario asks for…")
  — overfit fixture knowledge inside a generic persona.
- The **bespoke about generator** ([about/generator.ts](../packages/service/src/about/generator.ts))
  is the compliance model: 200–400 words, structure-directed, and it explicitly forbids
  tool names for exactly the drift reason. Generated abouts are better-shaped than the
  shipped templates for the same roles. (Gap: the 200–400 words is prompt-side only —
  nothing caps an over-long generation.)

Template diet direction: shrink the six offenders to generator shape — character,
expertise, working-style *intent* — and let operational mechanics live in the runtime
layers that already carry them. `developer` 1.4.0 is the pilot (see A/B stage 4 below).

## Tool-surface budget — the real first-prompt cost

For local engines the tool schemas are rendered into the prompt by the chat template, so
they compete with text for context and prefill. Measured accounting:

- The frozen cross-platform bridge inventory currently contains **161 ordinary tools**,
  with feature-, compatibility-, and session-context tools tracked separately. Actual
  sessions see their role kit, not that whole inventory. `mcp.compact-tool-schemas`
  strips description prose from local-model schemas while preserving their callable
  structure.
- The standard Voorman kit is **77 tools** after consolidating four duplicate entry
  points: `craftbook_create` / `craftbook_replace` fold into `craftbook_write`,
  `list_project_local_gezels` folds into the sectioned `list_project_gezels`, and
  `create_gezel_from_gilde` folds into `create_gezel({ templateId })`. The old handlers
  remain available only with `GEZEL_MCP_LEGACY_TOOLS=1` for compatibility. The
  structurally large `craftbook_update_step` schema is additionally loaded only in an
  explicit Craftbook editor session; ordinary sessions keep the focused
  `set_step_deliverable`. Together those changes remove about **64.2K compact schema
  characters** from an ordinary coordinator surface without removing a capability.
- The default **Meester roster is 40 tools** (56 with the `delegate_*`/`consult_*` pairs),
  which is below her own diet cap — so a stock Meester is never trimmed, and a
  "tool cap trimmed this session" warning again means an installed toolset pushed her
  over. Getting there meant deleting from the roster rather than capping: tools that sat
  permanently below the cut are not worth their schema every turn only to be dropped every
  turn. Stripped by name in `MEESTER_STRIPPED_TOOLS`
  ([role-tool-filter.ts](../packages/service/src/chat/role-tool-filter.ts)) —
  the `*_suggested_work` toggles, the craftbook step-surgery tail (restored in an explicit
  Craftbook-editor session), and `write_document`/`delete_document` — plus dropping the
  `doc-intel` and `entity-intel` groups from the role. `export_ai_app`/`import_ai_app` left
  the shared `team-management` group entirely for an opt-in `ai-apps` group, so no default
  role carries .gezapp packaging. The freed budget
  curated the typed-project front door (`list_project_types`, `start_project_from_type`)
  into the priority list, which the diet had been trimming away on exactly the medium local
  models it targets.
- Per-role count-caps ([session-tool-surface.ts](../packages/service/src/chat/session-tool-surface.ts)):
  tiny uses a broad cap (implementation 75, everything else 15). Small caps only
  coordinator roles, and does so **at the full curated orchestration-list length**
  (Meester 42, Voorman 38); implementation and custom roles remain uncapped. Medium and
  large are uncapped when their admitted context is at least 49,152 tokens. If RAM-aware
  admission clamps a coordinator below that floor, the same full-list diet activates
  automatically; it also remains available behind `GEZEL_MEESTER_TOOL_DIET=1`. This
  replaced the unsafe old hand-tuned table (Meester 13,
  Voorman 22/80, unknown 30/40 across small/medium), which evicted load-bearing tools —
  the imara office-hours kickoff looped `list_projects` (priority rank 6, kept) because
  `read_task_notes` (rank 26) was trimmed out from under the "resume via read_task_notes"
  prompt. Two safeguards keep the current caps from re-creating that class:
  1. **Load-bearing floor** (`LOAD_BEARING_TOOL_CAP_ALWAYS_KEEP`): `read_task_notes`,
     `write_task_note`, `advance_task_step`, `set_task_status`, `write_file`,
     `message_gezel`, and `ask_user_question` survive the cap unconditionally when
     present — a session is never trimmed below the ability to finish its step, hand off,
     or ask for the human decision the standing prompt requires. Rides alongside the
     existing `validate` + `delegate_*`/`consult_*` exemptions.
  2. **Step-completion grant**: a session actively executing a craftbook step
     (`taskRef` + `stepId`) is granted the task-progression tools regardless of role, and
     those tools are restored after message-driven file clamps, so a `write_file`-shaped
     seed cannot hide the `write_task_note` action its procedure requires first. A
     coordinator assigned a step (whose default kit is `tasks-readonly`) can still record
     notes and hand off.
  3. **No incidental survivors.** Slots left over once a role's curated list is
     exhausted — and every slot for a role that has no curated list, i.e. any custom role
     at tiny — are filled from `GENERIC_TOOL_CAP_FALLBACK` (a read → search → artifact →
     recall ladder) and then alphabetically. Previously they were filled in `Set`
     iteration order, so which tools a trimmed session kept depended on which toolset
     group the resolver happened to visit first, and reordering a group could silently
     take a tool away. Everything the trim keeps is now a ranked decision; what it
     deliberately drops (and why) is recorded inline next to each curated list.
- **The trim is not a user-facing event.** `buildToolCapWarning` reaches the chat
  transcript only under `config.debugMode`; ordinary installs get the unconditional
  `tool-cap:` `log.warn` and nothing in the UI. The trim is the tier policy working as
  designed, the dropped tool names mean nothing to someone who never chose tools by
  name, and both remedies the text suggests (larger model, fewer toolsets) are settings
  changes nobody should be asked to make mid-sentence. Same reasoning gates the
  heavy-roster advisory in `refreshLiveToolSurface`.
- **Measured decomposition (instrumented tictactoe kickoff, qwen-27b):**
  system text ~3,629 tok (localHints 1,344 — cookbook + private-reasoning, both since
  proven removable at this tier; meester persona 1,158; askWhenStuck 354; the rest
  ≤230 each) vs **wire tool schemas 51,146 ch ≈ 12.8K tok for only 17 tools** — after
  the orchestration clamp (146 inventory → 67 role surface → 29 capped → 17 clamped)
  and WITH `mcp.compact-tool-schemas` applied. What survives compaction is structural:
  the orchestration tools (create_task, craftbook_write, start_project…) average ~3K ch
  of nested blueprint schemas, enums, and anyOf chains each. **Schema structure, not
  prose, is the dominant local prompt cost (≈3.5× all standing text).** The static
  ~225 ch/tool estimate above badly undercounts the heavy tail — size the wire, not the
  average. Diagnostics: `GEZEL_PROMPT_BREAKDOWN=1` (per-section text table, passed
  through by the eval harness) + the `wire tools= schemaChars=` debug line in the
  llama-cpp provider.

## Prompt/tool contract matrix

The prompt stack has an executable contract, not just prose review. Run
`pnpm test:extended` (or its focused alias, `pnpm lint:prompts`) to render the bundled
matrix and compare every rendered instruction against the post-role, post-security,
post-tier-cap, post-message-clamp built-in tool roster for that turn. The static
tool-name scan and this exhaustive rendered matrix run in the dedicated
`model-tool-contracts` quality job and as part of root `pnpm validate` / `pnpm all`.
They remain outside the faster standalone `pnpm test` and `pnpm lint` commands.

The matrix calls the production `buildInstructions`, `resolveProfile`, and
`resolveSessionToolSurface` functions. It materializes the roster from a live in-memory
MCP `tools/list`, then applies the same platform, contextual-gate, role, and dynamic
project-script projection as production. As of 2026-08-10 it covers:

- 31 standard, non-fixed-function role templates;
- 36 tool-capable bundled chat models exposed through 81 model/backend profiles;
- 16 representative session shapes: generic project chat, existing-file review,
  super-lockdown file request, assigned-task overview, fresh build, task-scoped build,
  file consultation, delegation task, plus the Meester crew-build and three craftbook
  prelude branches (library lookup, authoring, data transform) and explicit craftbook,
  mail, and generic-connector gated surfaces, applied only where the role can
  legitimately perform that shape;
- two tool-surface strategies: the default production caps plus the env-gated coordinator
  diet for medium/large coordinator roles;
- **24,082 concrete prompt/tool comparisons**, collapsing to **6,994 distinct rendered
  prompts** and **134 distinct resolved tool rosters**;
- **170 live MCP input schemas** plus **40 model-facing MCP source strings** containing
  tool-call examples.

Tiny, small, and medium tier coverage is a build invariant: the matrix throws before
reporting if any of those tiers has no cases. The resolver is called with each manifest's
real parameter size, so the production tier cap/filter path is what the comparison sees.
It also requires at least one **actual cap trim** in each of those tiers. The current sweep
contains 3,402 tiny cases (2,954 trimmed), 3,402 small cases (1,162 trimmed), and 10,106
medium cases (2,573 trimmed, through the explicit coordinator-diet strategy), plus 7,172
large cases (1,826 trimmed through that strategy). This distinguishes merely classifying a model from
actually exercising its count-cap branch. Small's coordinator cap and medium's optional
diet retain every curated orchestration tool; role/security gates, schema compaction, and
message/step clamps still apply afterward.

`--json` emits every row, including role, model, provider, tier, resolved behavior IDs,
scenario, security posture, tool names, prompt/tool fingerprints, and findings. The
human report deduplicates equivalent findings and shows their occurrence count.

CI-blocking errors are intentionally high-confidence: a hard first/next/must action for
an unavailable tool, a false denial of a capability that is present, or an imperative
tool reference inside a standard role `about.md` (role identity must not be a stale tool
manual). Broader imperative references are warnings so new rules can be tightened with
evidence instead of freezing the build on a lexical false positive.

At runtime, debug mode (or `GEZEL_PROMPT_LINT=1`) runs the same check on the actual
session prompt and again at the send seam for turn-scoped preludes, task-budget warnings,
and continuation/corrective nudges. This catches user-authored `about.md` / `tools.md`,
live bridge failures, and `GEZEL_FORCE_BEHAVIORS` / `GEZEL_REMOVE_BEHAVIORS` combinations
outside the bundled matrix. Diagnostics are logged as `[prompt-tool-contract]` and never
strand a user turn.
Model-behavior appendices (cookbooks and family hints) are additionally filtered during
assembly: directive lines naming unavailable tools are omitted. Standing identity,
project, and task layers are never silently rewritten; their findings remain visible to
the runtime linter.

The build checker is also **JSON-Schema aware**. A lint-only MCP entry point performs an
in-memory `tools/list` round trip and returns the exact input schemas providers receive;
the matrix validates literal call examples in rendered prompts, registered tool
descriptions, and model-facing MCP source strings. It fails on positional calls, missing
or unknown properties, concrete type mismatches, and invalid enum/const values.
Identifiers and angle placeholders remain symbolic wildcards, so
`write_file({ path, content })` and `<full contents>` can document shape without inventing
fixture values; their surrounding object and required keys are still checked.

The static matrix models bundled local model/backend profiles, not every third-party MCP
server. Dynamic arguments returned from live data are validated by MCP when called, and
the runtime name/capability seam remains the backstop for cloud sessions, user-authored
prompts, installed toolsets, and OS-specific availability.

## Engine conditionalization — verdict

No standing prompt text is conditioned on the local engine today, and that is correct.
Engine differences are handled as *mechanics* behaviors (system-message merging for
Qwen templates, MLX grammar/template fixes, Ollama num-predict) that don't change prose.
The only engine-specific text is the llama-cpp provider's turn-scoped repair/edit-mode
suffixes on the user channel — appropriate placement. The productive conditioning axes
are the ones already in use — **model** (manifest behaviors) and **role/context**
(delegation guardrail, executor-context-trim, where-work-belongs variants) — plus the
tier floor. Recommendation: no engine-conditional prose; invest in per-model manifest
curation and role/context gating instead.

## Open questions and the running A/B

The harness is `ab-prompt-conduct` (same shape as `ab-grammar` / `ab-craftbook-format`):
control arm on the resolved profile vs treatment arm with `GEZEL_FORCE_BEHAVIORS` /
`GEZEL_REMOVE_BEHAVIORS`, over the named common-task scenarios, diffing pass rate,
stall-nudge firings (`response looks stalled (` in daemon logs), post-turn detector hits
(`post-turn detector fired id=`), stall-class failures, and wall-clock.

**Round 1 (qwen3.6-27b-q4, 18 scenarios × 2 arms × 1 trial) was accidentally
control-vs-control** — it force-added a behavior the manifest already declares (the
tier-table caveat above was learned here). Two products anyway:

- **The noise floor.** Same config twice: pass rate identical (16/18 both arms; the two
  failures were the same two scenarios chat-stalling in both arms, consistent with the
  open turn-management stall regression), stall nudges 7 vs 3, wall-clock 126 vs 132
  min. Nudge-count swings under ~2× at n=1/cell are noise; read pass-rate deltas only
  after checking failure classes.
- **Hardening.** The bin refuses provably inert treatments by reading the model's root
  manifest (`assertTreatmentNotVacuous`); `applyBehaviorEnvOverrides` warns loudly on
  force-of-present and remove-of-absent no-ops.

**Round 2 + confirmation (removal direction).** Control vs
`GEZEL_REMOVE_BEHAVIORS=prompt.tool-cookbook-condensed` on qwen3.6-27b-q4; non-vacuity
proven by first-prompt size (removal arm 705 tokens smaller). Wide pass (18 scenarios ×
1 trial): removal 16/18 vs control 15/18. Targeted confirmation (4 flip-prone scenarios
× 2 trials): removal 8/8 vs control 5/8. Cumulative across all rounds: cookbook-present
52/62 (84%), cookbook-absent 24/26 (92%); stall-class failures 10 vs 2; fabrication
detectors fired zero times in any arm; no visible `tool_call` envelope leakage in any
persisted session (the regression the behavior's docblock predicts for Qwen 27B). The
"Rule #11 prevents re-write thrash" hypothesis died in confirmation — the re-emit
`model-stuck` failure occurred WITH the cookbook present, not without it.

**Verdict: on qwen3.6-27b the condensed cookbook is free to remove** — it prevents
nothing these 18 scenarios can measure and costs ~700 tokens of prefill every turn.
Manifest edit (drop it from `qwen3.6-27b-q4`/`-q8`) is a product decision; the block
stays correct for small-tier models until they get their own removal round. Note the
dominant reliability tax on this model is not prompt content at all: the recurring
zero-turn chat-stalls track the open turn-management stall regression.

### Grand A/B — staged rounds

One lever per run, each with its own paired control (18 named scenarios × 1 trial unless
noted); read nudge deltas against the noise floor above.

1. **Lean standing text, qwen-27b** — remove cookbook-condensed + private-reasoning
   (~1.35K tok/turn). RESULT: control 17/18, treatment 16/18, nudges 8→12 (redline
   1→6). Initially read as private-reasoning being load-bearing — refuted by stage 2b.
   2b (remove private-reasoning ONLY): 16/18 vs 16/18, nudges 5/5, no redline spike —
   the stage-1 dip was noise. Net across five qwen-27b rounds: every control-config run
   averages 16/18 and every removal treatment (cookbook, private-reasoning, both) lands
   exactly on that mean. **At 27B these two standing blocks have no measurable function
   on common tasks; both are safe to drop from the qwen3.6-27b manifests.**
2. **Small-tier cookbook, gemma4-e4b** — remove cookbook-condensed where it's a
   small-model default. RESULT: control 15/18, treatment 14/18; fabrication detectors
   15→22 (+47%, codebase-evolution 3→9) — the first round in the series where detectors
   fire at all (zero in every 27B round). The same block that is dead weight at 27B is
   measurably preventive at 8B. **Verdict: keep the cookbook on small tier.**
3. **Worker-context diet, qwen-27b** — force `prompt.executor-context-trim` (project
   about 6000→3500 ch, docs listing dropped for executors). RESULT: 16/18 vs 15/18,
   nudges 8/9 — null. No efficacy win at 27B; the trim's value remains purely
   token/context savings.
4. **Template diet** — `developer` 1.4.0 (3,395 ch vs 1.3.0's 10,924; runtime-duplicated
   rules and tool enumerations removed). RESULT (accidental natural experiment: catalog
   version resolution is a live disk scan, so 1.4.0 went live mid-stage-1 rather than at
   build-index time — session `aboutSnapshot`s prove the boundary): 72 lean-template
   trials across stages 1–3 scored 64/72 (88.9%) vs the fat-template baseline 47/54
   (87.0%). **A 69% template cut (~1.9K tok per worker turn) with zero regression.**
   Caveat: cross-run comparison, not paired — but control-config runs have been stable
   at 15–17/18 throughout. Lesson recorded: catalog data edits are live immediately;
   never assume build-index gates them.
5. **Tiny-tier cookbook, qwen3.5-4b** — remove cookbook-condensed (the bundled 4B
   declares condensed, not full — full is only the manifest-less tier floor). Expected
   to HURT as the method's positive control. RESULT: control 9/18, treatment 11/18,
   six cells flipped both ways — **the positive control did not fire.** At a ~50% base
   rate every cell is a coin flip, so pass-rate at n=1/cell saturates in noise at tiny
   tier. Bound honestly: the series' only affirmative evidence FOR a cookbook is
   gemma4-e4b's detector-count signal (stage 2, the high-power metric). Keep the block
   at tiny/small as cheap insurance backed by that signal; treat any future tiny-tier
   prompt claims as unmeasurable without count metrics or n≥3.
