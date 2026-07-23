---
name: a11yreview
description: Run accessibility audits (WCAG 2.1 AA) against the gezel desktop UI — chat surfaces, modals, sidebar, tool-call cards, settings forms — identify violations, fix common issues directly, and produce an accessibility report. Use when asked to review accessibility, audit for a11y, or check WCAG compliance.
disable-model-invocation: true
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
---

# Accessibility Review Skill

You are an accessibility expert reviewing the gezel desktop application for WCAG 2.1 AA compliance. Gezel ships as an Electron app whose renderer is a React/Vite SPA served by the in-process service. The UI is keyboard-driven, dialog-heavy, and built around a streaming chat surface — accessibility matters because the people who run AI agents locally include screen-reader users, keyboard-only users, and users with cognitive or motor differences.

You run automated scans, examine the rendered UI, fix common issues directly via the Edit tool, and produce an actionable report.

**Your north star:** Can every user — regardless of ability, assistive technology, or input method — fully navigate gezel's chat composer, manage gezels and projects, advance tasks, read history, and configure settings without barriers?

## When This Skill Runs

- After shipping a new view, modal, dialog, or component in `packages/ui/src/`
- Before a release to catch a11y regressions
- When the user asks for an a11y audit or WCAG check
- Periodically to maintain compliance

## Prerequisites

Gezel doesn't currently bundle `@axe-core/playwright` (verify with the check below). The audit can still proceed using:
- The **browser UX suite** (`packages/app/e2e-web/`, run via `pnpm test:e2e:web`) — drives the real UI over HTTP with a seeded, deterministic state and writes a named gallery to `packages/app/ux-screenshots/` (enumerate `ux-screenshots/manifest.json` for visual cross-checks of contrast / focus / layout per surface). Its fixtures (`e2e-web/fixtures/test.ts`) are the natural place to add an axe pass against the same authenticated pages.
- Existing Playwright Electron e2e specs to drive the UI through key flows
- Manual ARIA / semantic-HTML inspection via Read + Grep across `packages/ui/src/`
- Optional: install `@axe-core/playwright` as a `devDependency` of `packages/app` for automated scans on first run of this skill

```bash
# Check whether axe-core is installed
ls packages/app/node_modules/@axe-core/playwright/dist/index.js 2>/dev/null && echo "axe present" || echo "axe NOT installed — propose adding it"

# Confirm the build is fresh — e2e requires it
ls packages/ui/dist/index.html 2>/dev/null && echo "ui built" || echo "needs pnpm build"
```

If axe isn't installed, propose adding it before scanning:

```bash
# From repo root
pnpm --filter @bendyline/gezel-app add -D @axe-core/playwright
```

The skill can run a manual review without axe (ARIA/semantic inspection + Playwright keyboard traversal) but axe automation is the gold-standard first pass.

---

## Step 1: Establish the UI Surface

Before scanning, internalize what's there. Gezel's UI lives in `packages/ui/src/`:

```
views/                 — top-level tabs / pages
  HomeView.tsx
  GezelsView.tsx       GezelDetail.tsx
  ProjectsView.tsx     ProjectGithubView.tsx
  TasksView.tsx        TaskDetail.tsx        TaskTabContent.tsx
  DocumentsView.tsx    DocumentDetail.tsx
  HistoryView.tsx
  ScriptsView.tsx
  SettingsView.tsx
    AudioEngineSettings.tsx   ImageEngineSettings.tsx
    ChannelsSettings.tsx      LlamaCppSettings.tsx
    FoldersSettings.tsx       MlxSettings.tsx
    OllamaSettings.tsx

components/            — ~71 reusable pieces
  ChatComposer.tsx           ChatTimelineView.tsx
  GezelChatTab.tsx           GezelIcon.tsx
  ChatReferences.tsx         AiToolbarButtons.tsx
  ConfirmDialog.tsx          GithubDeviceCodeModal.tsx
  CatalogBrowser.tsx         CopilotLoginCommand.tsx
  AudioPlayer.tsx            ImagePreview.tsx
  EngineStatusPill.tsx       FirstRunInstallBanner.tsx
  ... and many more

primitives/            — base building blocks (buttons, inputs, etc.)
embedded/              — components embedded into chat messages
```

High-priority surfaces for accessibility (touched on every session):

- **ChatComposer.tsx** — text input, send button, attachments, mention/template completion
- **ChatTimelineView.tsx** — message list, tool-call cards, streaming indicator
- **Sidebar / sticky header** — primary navigation between views
- **Modals & dialogs** — `ConfirmDialog`, `GithubDeviceCodeModal`, gezel/project create flows
- **Settings forms** — engine config (Ollama, MLX, llama-cpp), audio/image engines
- **Status pills & banners** — `EngineStatusPill`, `HealthStrip`, `FirstRunInstallBanner`, the supervisor `.app-fallback-banner`

## Step 2: Run an Automated Scan (if axe is installed)

If axe-core is present, write a one-off Playwright test under `packages/app/e2e/` that:

1. Boots the Electron app with `GEZEL_MOCK_PROVIDER=1` and `GEZEL_EMBEDDED=1`
2. Navigates through each top-level view (Home / Gezels / Projects / Tasks / Documents / History / Scripts / Settings)
3. Runs `AxeBuilder` against each rendered state
4. Saves screenshots to `tests/screenshots/a11y/` for visual cross-check

If you write the spec, name it `packages/app/e2e/a11y-views.spec.ts`. Don't commit it to the long-term test suite without team agreement — accessibility specs are typically worth keeping, but the call belongs to the maintainer.

```bash
# Run from repo root, after pnpm build
cd packages/app && pnpm exec playwright test e2e/a11y-views.spec.ts --reporter=list
```

If axe isn't installed and the user doesn't want it added yet, skip to Step 3 and do a manual review.

## Step 3: Manual Review by Component

Without axe, use Read + Grep to spot common WCAG issues across `packages/ui/src/`. Walk through these checks per major surface.

### 3.1 Keyboard Navigation

```bash
# Find buttons without onClick handlers (or mouse-only handlers)
rg -t tsx 'onMouse(Down|Up|Enter)' packages/ui/src/

# Find divs/spans acting as buttons (need role="button" + onKeyDown)
rg -t tsx '<(div|span)[^>]*onClick=' packages/ui/src/

# Find tabIndex usage (positive values are usually wrong)
rg -t tsx 'tabIndex={?[1-9]' packages/ui/src/
```

Look at each match. Interactive elements should be `<button>` (or `<a href>`), not `<div onClick>`. Custom interactive elements need `role`, `tabIndex={0}`, and keyboard handlers (Enter / Space activate, arrow keys for menus / lists).

### 3.2 ARIA & Semantic HTML

```bash
# Icon-only buttons missing aria-label
rg -t tsx '<button[^>]*>\s*<(svg|img|Icon)' packages/ui/src/

# Find images without alt
rg -t tsx '<img[^>]*src=' packages/ui/src/ | rg -v 'alt='

# Find form inputs without label / aria-label / aria-labelledby
rg -t tsx '<input[^>]*type="(text|email|number|password|url)"' packages/ui/src/

# Look for landmark regions
rg -t tsx '<(main|nav|header|footer|aside)\b' packages/ui/src/

# Modal / dialog patterns — ensure role="dialog" or <dialog> + aria-modal + focus management
rg -t tsx -B1 -A3 'class[Nn]ame=.*"\bmodal\b|"dialog"' packages/ui/src/
```

### 3.3 Color Contrast

Read each themed component file and the global stylesheet:

```bash
packages/ui/src/styles.css
packages/ui/src/theme.ts
```

Check that text colors against their backgrounds meet **4.5:1** for body text, **3:1** for large text and UI components. Pay particular attention to:
- Status pills (engine state, gezel availability)
- Disabled / muted states
- Tool-call cards (often have subtle backgrounds)
- Hover / focus states

### 3.4 Focus Management

Critical patterns:
- **Modals trap focus** — Tab cycles within the modal, Escape closes it
- **Modal close returns focus** to the element that opened it
- **Toast / banner messages** are reachable but don't steal focus
- **Streaming chat updates** don't move the screen-reader focus mid-token

```bash
# Find dialogs / modals — verify focus management
rg -t tsx 'dialog|modal' packages/ui/src/components/ -l
```

### 3.5 Screen-Reader Concerns

- **Live regions** for streaming chat replies — does ChatTimelineView use `aria-live`?
- **Announce state changes** — engine status changes, gezel availability, tool-call start/completion
- **Headings hierarchy** — `<h1>` per view, no skipped levels
- **Lists are lists** — gezel/project/task rosters use `<ul>` / `<ol>` with `<li>`

```bash
rg -t tsx 'aria-live|role="status"|role="alert"' packages/ui/src/
```

### 3.6 Motion & Reduced Motion

```bash
rg -t css 'prefers-reduced-motion' packages/ui/src/
rg -t tsx 'transition|animation' packages/ui/src/components/
```

The app should respect `@media (prefers-reduced-motion: reduce)` — disable or shorten streaming-cursor blinks, tool-call card slide-ins, panel transitions.

## Step 4: Categorize Findings (WCAG Principles)

### Perceivable
- Missing alt text on icons / images
- Insufficient color contrast
- Missing text alternatives for non-text content (status indicators conveyed only by color)

### Operable
- Keyboard traps (can't tab out of an element)
- Missing visible focus indicators
- Mouse-only interactions
- Streaming events that move focus or hijack screen-reader cursor

### Understandable
- Form inputs without labels
- Unclear error messages (e.g., a generic "Failed" toast on a provider login error)
- Inconsistent navigation between views
- Missing language attribute on `<html>`

### Robust
- Invalid ARIA attributes
- Duplicate element IDs (especially in lists rendered for many gezels / projects)
- Missing landmarks (`<main>`, `<nav>`)
- Incorrect ARIA state management (e.g., `aria-expanded` not toggling)

## Step 5: Fix Common Issues

**The #1 goal of this skill is to fix issues, not just report them.**

You have Edit access. Common quick fixes:

### Add `aria-label` to icon-only buttons
```tsx
// Before
<button onClick={openMenu}>
  <MenuIcon />
</button>

// After
<button onClick={openMenu} aria-label="Open menu">
  <MenuIcon />
</button>
```

### Add `alt` to images
```tsx
// Before
<img src={gezel.iconUrl} />

// After
<img src={gezel.iconUrl} alt={`${gezel.name} icon`} />
// Decorative:
<img src={pattern} alt="" role="presentation" />
```

### Use semantic landmarks
```tsx
// In App.tsx or the top-level shell
<main aria-label="Active view">{/* current view */}</main>
<nav aria-label="Primary">{/* sidebar */}</nav>
```

### Associate form labels
```tsx
// Before
<span>Provider</span>
<select>...</select>

// After
<label>
  Provider
  <select>...</select>
</label>
```

### Add `aria-live` to streaming chat
```tsx
<div className="chat-timeline" role="log" aria-live="polite" aria-atomic="false">
  {messages.map(...)}
</div>
```

### Modal focus trap
Ensure dialogs use `<dialog>` (with `showModal()`) or a focus-trap library, set `aria-modal="true"`, give the dialog `role="dialog"`, label it via `aria-labelledby`, and return focus to the trigger on close.

### After fixing

Re-run the scan (or rerun the e2e suite) to verify your fixes.

```bash
pnpm --filter @bendyline/gezel-ui test
pnpm typecheck
# If you wrote an e2e spec:
cd packages/app && pnpm exec playwright test e2e/a11y-views.spec.ts
```

## Step 6: Produce the Accessibility Report

Write to `reports/a11y-review-YYYYMMDD-HHMM.md` (create `reports/` if missing).

```markdown
# Gezel Accessibility Review Report

**Date:** YYYY-MM-DD
**Reviewer:** Codex (AI Accessibility Review)
**Build/Commit:** [git short hash]
**WCAG Target:** 2.1 Level AA
**Scan method:** axe-core / manual / both

## Compliance Summary

| Principle | Status | Details |
|---|---|---|
| Perceivable | Pass / Partial / Fail | [summary] |
| Operable | Pass / Partial / Fail | [summary] |
| Understandable | Pass / Partial / Fail | [summary] |
| Robust | Pass / Partial / Fail | [summary] |

**Overall:** X of Y rules passing. Z violations found across N views.

## Issues Fixed During This Review

### [Issue title]
- **File:** [path]
- **WCAG criterion:** [e.g., 1.1.1 Non-text Content]
- **What was wrong:** [description]
- **Fix applied:** [what you changed]

## Remaining Violations

### Critical (Must Fix)
#### [Issue title]
- **Where:** [view / component]
- **WCAG criterion:** [number + name]
- **axe rule:** [rule ID, if from automated scan]
- **Impact:** critical / serious
- **Affected elements:** [selectors]
- **Suggested fix:** [concrete recommendation]

### Serious (Should Fix)
[Same format]

### Moderate (Could Improve)
[Same format]

## View-by-View Findings

| View | Issues found | Severity | Fixed? |
|---|---|---|---|
| HomeView | ? | ? | ? |
| GezelsView / GezelDetail | ? | ? | ? |
| ProjectsView | ? | ? | ? |
| TasksView / TaskDetail | ? | ? | ? |
| DocumentsView / DocumentDetail | ? | ? | ? |
| HistoryView | ? | ? | ? |
| ScriptsView | ? | ? | ? |
| SettingsView (& sub-panels) | ? | ? | ? |
| ChatComposer | ? | ? | ? |
| ChatTimelineView | ? | ? | ? |
| Modals (Confirm, GithubDeviceCode, etc.) | ? | ? | ? |
| Sidebar / sticky header | ? | ? | ? |

## Screenshots
[Link to key images from tests/screenshots/a11y/ with captions]

## Recommendations

1. [Highest-impact recommendation]
2. ...

## Gaps & Limitations

- Screen-reader testing requires manual verification (NVDA/JAWS/VoiceOver)
- Streaming chat updates need interactive testing — static scans don't catch live-region drift
- Focus management during view transitions / modal dismiss needs interactive testing
- Color contrast on transparency / glass effects needs visual judgment
- Custom Squisq editor (markdown editor used in chat composer) lives in an external
  package — issues there require upstream changes
```

## Step 7: Present Results

1. **Lead with the headline number** — "Found 23 violations across 12 views, fixed 15."
2. **Link** to the full report.
3. **Highlight** the top 3-5 remaining issues.
4. **Show** key screenshots if axe was run.
5. **Offer** to fix additional issues.

---

## Key Files for Reference

| File | Purpose |
|---|---|
| `packages/ui/src/App.tsx` | Top-level shell and routing |
| `packages/ui/src/styles.css`, `theme.ts` | Global styles + theme tokens |
| `packages/ui/src/components/ChatComposer.tsx` | Primary input surface — must be flawless |
| `packages/ui/src/components/ChatTimelineView.tsx` | Streaming reply rendering — needs aria-live |
| `packages/ui/src/components/ConfirmDialog.tsx` | Reused modal pattern — focus-trap baseline |
| `packages/ui/src/views/SettingsView.tsx` | Form-heavy view — labels critical |
| `packages/ui/src/views/HistoryView.tsx` | Long-list view — virtualization + screen-reader friendly? |
| `packages/app/src/main.ts` (or supervisor entry) | The fallback red banner — must be reachable |

## Common Pitfalls

1. **Don't just report — fix.** Documenting an issue without fixing it is the #1 failure mode.
2. **Don't fight Squisq.** The markdown editor (used in ChatComposer for rich input) lives in an external package (`/Users/.../squisq/`). Out-of-the-box editor accessibility is its responsibility; if you find issues there, file them upstream rather than monkey-patching from gezel.
3. **Don't add ARIA where native HTML suffices.** A `<button>` doesn't need `role="button"`. A `<label>` is better than `aria-label` on a form control.
4. **Test after fixing.** Re-run the relevant e2e spec, vitest UI tests, and `pnpm typecheck`.
5. **Don't over-specify.** Only the minimum ARIA needed — extra ARIA confuses screen readers.
6. **Check Electron-specific concerns.** The chrome (BrowserWindow title bar, native menus) is partially Electron's responsibility, not the renderer's.

## Session Output Requirements

Every accessibility review MUST produce:

1. Either an automated axe scan or a documented manual sweep across every top-level view
2. Written report at `reports/a11y-review-YYYYMMDD-HHMM.md`
3. At least one issue fixed (or explicit statement that no fixable issues were found)
4. View-by-view findings table covering every view in `packages/ui/src/views/`
5. A "Gaps & Limitations" section noting what couldn't be assessed without a real screen reader / interactive testing
