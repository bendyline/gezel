---
name: uxreview
description: Evaluate the gezel desktop UI's user experience — visual design, information architecture, interaction patterns across the chat surface, gezel/project/task management, and settings. Captures screenshots from existing Playwright Electron specs, reviews them, and produces an opinionated report with prioritized findings.
disable-model-invocation: true
---

# UX Review Skill

You are a world-class UX reviewer obsessed with making gezel the most usable, delightful, and trustworthy desktop home for a team of AI agents. You evaluate the live application by capturing screenshots, examining them visually, and producing an actionable report with prioritized findings.

**Your north star:** Would a discerning user — someone who's used Cursor, Codex, ChatGPT, and the polished AI tools shipping right now — open gezel and feel like *this* is the calm, well-organized, file-on-disk-friendly place to put a real team of agents to work? Would they recommend it to a colleague?

## When This Skill Runs

This is NOT a content / pipeline / agent-behavior skill. It evaluates the **application itself** — the UI, the layout, the visual design, the feel. Run it:

- After shipping a new view, modal, or component in `packages/ui/src/`
- Before a release to catch regressions
- When the user asks for a UX audit or quality check
- Periodically to maintain a high bar

## Prerequisites

- Build is current (`pnpm build`) so the e2e suite can launch the Electron app
- Playwright is installed (it's a `devDependency` of `packages/app`)
- A `~/.gezel-dev` (or `--gezel-home=…`) sandbox is fine — don't pollute the user's real `~/.gezel`

```bash
# Verify build is fresh
ls packages/ui/dist/index.html 2>/dev/null && echo "ui built" || echo "needs pnpm build"
ls packages/app/node_modules/playwright 2>/dev/null && echo "playwright present" || echo "needs pnpm install"
```

If build is stale, run `pnpm build` first.

---

## Step 1: Capture Screenshots

### Primary path — the browser UX gallery (`pnpm test:e2e:web`)

The preferred source is the **browser UX suite** (`packages/app/e2e-web/`). It drives the real UI over HTTP (the `gezel start --web` "full mode") with a mock provider + a deterministic seeded world (frozen clock, masked volatile regions), and writes a **predictable, named screenshot gallery** to `packages/app/ux-screenshots/`.

```bash
pnpm test:e2e:web          # builds, runs the browser suite, regenerates the gallery
```

After it runs, discover frames from the manifest instead of guessing paths:

- `packages/app/ux-screenshots/manifest.json` — every frame keyed by a stable `area/name` (e.g. `chat/composer`, `settings/provider-ollama`). Each entry has `relativePath`, `description`, `scope` (`page`|`element`), `theme`, `viewport`, and `masked` regions.
- `packages/app/ux-screenshots/INDEX.md` — the same gallery grouped by area with embedded images, for quick human/AI browsing.

Enumerate `manifest.json` → `shots`, pick ≥1 frame per `area` (both `theme`s where present, plus all `dialogs/*`), resolve `relativePath` against `ux-screenshots/`, and read the PNG. Masked regions are intentional redactions of volatile content — never report them as bugs.

### Fallback path — the Electron specs

If the web suite can't run (no Chromium, headless CI without it), fall back to the Electron specs in `packages/app/e2e/`. **Do NOT write new specs.** Run the existing ones — they exercise the major surfaces and produce screenshots / traces under `packages/app/test-results/` and (where helpers explicitly save them) `tests/screenshots/`.

### Specs and what they cover

| Spec | What it Covers | Surfaces |
|---|---|---|
| `app.spec.ts` | Boot, BrowserWindow, basic navigation | Top-level shell, sidebar, sticky header |
| `meester.spec.ts` | Meester chat surface, tool calls, streaming reply | ChatComposer, ChatTimelineView, tool-call cards |
| `sessions.spec.ts` | Session lifecycle, resume, archived sessions | GezelChatTab, session list |
| `sticky-header.spec.ts` | Header scroll behavior | Top chrome, header collapse |
| `supervisor-spawn.spec.ts` | Packaged-mode spawn flow | First-run banner, supervisor health, fallback red banner |
| `tabs.spec.ts` | Tab navigation across views | Home / Gezels / Projects / Tasks / Documents / History / Settings |

### Run commands

```bash
# All specs (this is what `pnpm test:e2e` does — it builds first)
pnpm test:e2e

# Single spec without rebuilding (faster iteration)
cd packages/app && pnpm exec playwright test e2e/meester.spec.ts --reporter=list

# With a UI-mode browser (interactive — only if you need to manually navigate)
cd packages/app && pnpm exec playwright test --ui
```

### What Playwright produces

- `packages/app/test-results/` — failure artifacts (screenshots, videos, traces) for any test that failed or has `trace: 'on-first-retry'` in the config
- Test-spec-saved screenshots — wherever helpers explicitly call `page.screenshot({ path: ... })`. Look in the helpers and specs to find these.

### After tests complete

1. **Don't get stuck on test failures.** Some may fail — record those in the report. Use whatever screenshots / traces were produced.
2. **List artifacts.** `ls packages/app/test-results/` and any `tests/screenshots/` path the helpers reference.
3. **Prioritize strategically.** You don't need to examine every screenshot. Aim for 15-20 covering:
   - One representative per major view (Home, Gezels, Projects, Tasks, Documents, History, Scripts, Settings)
   - Chat composer + active streaming state
   - At least one modal / dialog
   - First-run banner / install state if it appears
   - Any failure screenshots that look UX-related (broken layout, weird empty state)

## Step 2: Visual Inspection

**Read each selected screenshot using the Read tool.** Look at each carefully before forming opinions. Use whichever lenses fit each screenshot.

### What you CAN assess from screenshots

#### Visual Hierarchy & Layout
- Is the most important content the most prominent?
- Clear hierarchy — heading > subheading > body > metadata?
- Whitespace intentional — neither cramped nor sparse?
- Elements aligned to a grid? Icons consistently sized?

#### Typography & Readability
- Body text comfortable to read (size, line-height, measure)?
- Code / monospace blocks distinguishable from prose?
- Truncation handled gracefully — no orphans or awkward breaks?
- Italic/bold/code markers in chat replies render cleanly?

#### Color & Visual Identity
- Palette cohesive? Accent colors guiding attention without overwhelming?
- Sufficient contrast (WCAG AA)?
- Status indicators (engine running / not, gezel available / busy) distinguishable *not by color alone*?
- Light vs dark theme parity (if both exist)?

#### Information Density
- Lists of gezels / projects / tasks: are they scannable, or a wall of cards?
- Settings panels: progressive disclosure or "show every checkbox"?
- Chat timeline: are tool-call cards visually distinct from messages without dominating?

#### Navigation & Wayfinding
- Can a new user figure out where they are?
- Active tab / view clearly indicated?
- Breadcrumbs (e.g., Project > Task > Step) when deep?
- Clickable elements obviously clickable (affordance)?

#### Empty States
- "No projects yet" / "No tasks yet" / "No history yet" — friendly + actionable?
- First-run experience: greeting? Clear next step?

#### Streaming Chat
- Streaming cursor / typing indicator visible without flickering?
- Tool-call cards render before / during / after execution distinguishable?
- Long messages with code blocks scroll cleanly?
- Error / warning banners on assistant messages legible?

#### Forms & Settings
- Labels above inputs vs placeholder-only?
- Required vs optional clearly marked?
- Help text where ambiguous (provider config has lots of fiddly fields)?

#### Modals & Dialogs
- Backdrop dimming present? Modal sized for content, not min-or-max-extreme?
- Confirm / cancel button hierarchy unambiguous (primary action visually dominant)?
- Modal closes cleanly, returns user to a sensible place?

#### Multi-Provider Surfaces
- Engine settings (Ollama / MLX / llama-cpp / Copilot / OpenAI) feel cohesive — same pattern, not five different layouts?
- Status pills (`EngineStatusPill`, `HealthStrip`) consistent?

#### Trust & Polish
- Does the experience feel *cared for* vs. thrown together?
- Misalignments, mismatched padding, broken icons?
- "I would happily ship this to a friend" or "I'd apologize first"?

### What you CANNOT fully assess from screenshots

Note these as "unable to evaluate from static images" rather than guessing:
- **Interaction quality** — hover/focus states, scroll inertia, transition smoothness
- **Streaming jitter** — does the chat reply land smoothly or jitter?
- **Performance** — load times, layout shift, perceived responsiveness
- **Audio behavior** — narration timing, mic input feedback (if any)
- **Keyboard navigation order** — covered by `a11yreview` skill, not here
- **Cross-platform parity** — Windows vs macOS chrome differences

---

## Step 3: Document Findings

### High-level picture

Your opinionated take is the most important outcome. Write 3-5 paragraphs honestly:

- What's the gestalt of the UX?
- What did you find delightful?
- What annoyed you most?
- What surprised you?
- If you were showing this to a friend who builds dev tools for a living, what would you apologize for? What would you be proud of?
- The single most impactful thing to fix?

### Tier 1: Showstoppers (Must Fix)

Issues that actively harm the experience or would cause users to bounce:
- Broken layouts, overlapping elements, unreadable text
- Non-functional interactions (dead clicks, broken navigation)
- Jarring visual bugs (FOUC, layout shift on hover)
- Empty states that look like errors
- The supervisor red banner being unreachable / unclear
- Provider login flows that fail silently

### Tier 2: Polish Issues (Should Fix)

Issues a discerning user notices:
- Inconsistent spacing or alignment
- Missing hover/focus states
- Awkward text truncation
- Suboptimal image sizing or icon weight
- Engine settings that look 3 different ways across providers
- Modal hierarchy ambiguous (which button is primary?)

### Tier 3: Delight Opportunities (Could Enhance)

Ideas to elevate good → great:
- Micro-interactions on tool-call card render
- Better loading / streaming-start states
- Empty-state illustrations or copy with personality
- Onboarding moments (first gezel created, first task completed)
- Subtle animation on session resume

---

## Step 4: Produce the UX Review Report

Write to `reports/ux-review-report-YYYYMMDD-HHMM.md` (create `reports/` if missing).

The report should feel like a thoughtful design critique, not a checklist. Lead with your honest impression, then support with specific findings.

```markdown
# Gezel UX Review Report

**Date:** YYYY-MM-DD
**Reviewer:** Codex (AI UX Review)
**Build/Commit:** [git short hash]
**Screenshots reviewed:** [count] from packages/app/test-results/ and tests/screenshots/

## The Big Picture

[3-5 paragraphs of honest, opinionated assessment. How did this experience make you
feel? What delighted you? What frustrated you? What felt unfinished? If you were
showing this to a friend, what would you apologize for? What would you be proud of?
What's the single most impactful thing to fix?]

## What's Working Well

[3-5 specific things to protect and build on. Reference screenshots.]

## Showstoppers (Tier 1 — Must Fix)

### [Issue title]
- **Where:** [view / component]
- **Screenshot:** [filename]
- **What's wrong:** [description]
- **Why it matters:** [user impact]
- **Suggested fix:** [concrete recommendation]

## Polish Issues (Tier 2 — Should Fix)

### [Issue title]
- **Where:** [view / component]
- **Screenshot:** [filename]
- **What's wrong:** [description]
- **Suggested fix:** [concrete recommendation]

## Delight Opportunities (Tier 3 — Could Enhance)

### [Opportunity title]
- **Where:** [view / component]
- **Idea:** [description]
- **Why it would help:** [expected impact]

## View-by-View Notes

| View / Surface | Impression | Key Issues |
|---|---|---|
| Home | ... | ... |
| Gezels (list + detail) | ... | ... |
| Projects (list + detail + GitHub) | ... | ... |
| Tasks (list + detail + steps) | ... | ... |
| Documents | ... | ... |
| History | ... | ... |
| Scripts | ... | ... |
| Settings (Audio / Image / Channels / Folders / Llama-cpp / MLX / Ollama) | ... | ... |
| Chat composer | ... | ... |
| Chat timeline (streaming, tool calls) | ... | ... |
| Modals & dialogs | ... | ... |
| Sticky header / sidebar | ... | ... |
| First-run / supervisor banners | ... | ... |

## Notable Screenshots

[Link to 5-10 key screenshots illustrating the most important findings — both positive
and negative. Include a one-line caption explaining what each shows.]

## Gaps & Limitations

[What couldn't you assess from screenshots? Which views were missing? What would you
want to test interactively?]
```

---

## Step 5: Present Results

1. **Lead with your honest take** — 2-3 sentences on the overall state.
2. **Link** to the full report.
3. **Highlight** the top 3-5 findings (with screenshot references).
4. **Recommend** which Tier 1 issues to fix first.
5. **Offer** to help fix specific issues.

---

## Review Principles

### What great looks like

Benchmarks for what gezel's UX should aspire to:

- **Linear** — calm density, opinionated information architecture, every interaction feels intentional
- **Cursor / Codex / Zed** — chat surface that feels native to the developer's workflow rather than a bolt-on
- **Things 3** — calm hierarchy across many objects (tasks, projects, areas)
- **Notion** — empty states that teach without overwhelming

### Common anti-patterns

| Anti-pattern | What it Looks Like | Why It's Bad |
|---|---|---|
| **Information overload** | Every status pill, badge, and counter shown on every row | Overwhelms; nothing stands out |
| **Ghost town** | Empty Home, sparse sidebar, no featured state | Feels unfinished |
| **Settings sprawl** | Provider config pages each follow a different pattern | Feels amateur |
| **Tool-call wall** | Tool-call cards visually as loud as user/assistant messages | Chat reads as a log file, not a conversation |
| **Inconsistent density** | Cramped here, vast whitespace there | Unpolished |
| **Mystery icons** | Icon-only buttons in primary nav with no label | Users don't know what's clickable |
| **Modal-as-everything** | A modal for every action, including ones that should be inline | Aggressive, breaks flow |
| **Banner stack** | Multiple banners (first-run, supervisor health, engine warning) stacking up | Feels broken |
| **Streaming flicker** | Layout shift as tokens stream in | Jarring; reads as buggy |

### The "First 5 Seconds" test

For each entry surface (Home, Gezel chat, Project detail, Settings):

1. What does the user see first? Compelling or confusing?
2. What should they do next? Is the call to action obvious?
3. What's the emotional tone? Inviting? Overwhelming? Empty?
4. Would they stay or bounce?

### The "Show a Friend" test

Imagine showing gezel to a friend who builds developer tools:

1. Would you feel **proud** or **apologetic**?
2. What would you **preemptively explain** because the UI doesn't?
3. What would they **try to do** that wouldn't work as expected?

### The "Local-First Trust" test

Gezel is a local-first app — users can `cat` and `grep` their data. Does the UI reinforce that trust?

1. Are file paths shown when relevant (e.g., a gezel's about.md location)?
2. Are operations on disk surfaced (e.g., when a session is persisted)?
3. Does the supervisor mode (embedded vs adopted vs spawned) leak into the UI in a way that builds trust without overwhelming?

---

## Focused Reviews

If the user asks for a focused review, scope screenshots and evaluation to that area:

| Focus area | Specs to run | What to evaluate |
|---|---|---|
| "Review the chat surface" | `meester.spec.ts`, `sessions.spec.ts` | Composer; timeline; tool-call cards; streaming polish |
| "Review settings" | `tabs.spec.ts` (Settings tab) | Cross-provider parity; form quality; help text |
| "Review the supervisor / first-run" | `supervisor-spawn.spec.ts` | First-run banner; install progress; fallback red banner |
| "Review the task surface" | `tabs.spec.ts` (Tasks) | List density; detail layout; step UI; assignment flow |
| "Review the gezel detail" | `tabs.spec.ts` (Gezels) | About panel; toolset list; chat-tab integration |
| "Review history" | `tabs.spec.ts` (History) | Filter bar; row density; expand interaction |
| "Review modals" | All specs (modals appear across) | Confirm / dialog patterns; focus return; primary-action hierarchy |

---

## Session Output Requirements

Every UX review MUST produce:

1. Screenshots collected from existing Playwright runs in `packages/app/test-results/` and any `tests/screenshots/` paths the specs use
2. Written report at `reports/ux-review-report-YYYYMMDD-HHMM.md`
3. An honest "Big Picture" narrative assessment
4. At least one Tier 1 finding (or explicit statement that none exist)
5. At least three specific, actionable recommendations with screenshot references
6. A "Gaps & Limitations" section noting what couldn't be assessed from static images
