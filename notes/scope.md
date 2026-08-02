# Accessibility Audit — Scope & WCAG 2.1 AA Checklist

**Task:** gezel/2 · **Phase 1 of 3 (Scope)** · **Reviewer:** Borivoje
**Target:** WCAG 2.1 Level AA
**Subject:** Gezel desktop app renderer — the React/Vite SPA in `packages/ui/src/` (served in-process by the Electron app).
**Scan method:** Manual (source-based) ARIA/semantic inspection + keyboard/screen-reader simulation + contrast reasoning. **No axe-core is bundled** (`@axe-core/playwright` is not a dep of `packages/app`), so this is a documented manual sweep, not an automated scan.

> This is Phase 1. **No findings are recorded here** — only the surface, the flows, and the locked acceptance criteria. Findings land in `notes/audit.md` (Phase 2) and `a11y-report.md` (Phase 3).

---

## 1. Indexed review coverage (leads, not findings)

- `list_file_issues` over `packages/ui/src` returned **0 issues across 0 / 3158 reviewed files** — the background review sweep has **not run** on this workspace. There are therefore **no indexed leads** to seed the audit.
- Consequence: every finding in Phase 2 must be established by **direct inspection** of the markup/CSS. No indexed lead is treated as a confirmed finding (there are none to treat).
- No automated a11y tooling is installed. The gold-standard first pass (axe-core) is unavailable; Phase 2 relies on manual ARIA/semantic inspection, keyboard-traversal reasoning, and contrast math against `styles.css`/`theme.ts`.

---

## 2. UI surface inventory (enumerated from disk, not the skill sketch)

This is a **whole-project** review, so the complete UI surface is in scope. The real tree is materially larger than the `a11yreview` skill describes (it omits Craftbooks, Benchmarks, FileMap, Handboek, and ~half the settings panels). Enumerated surface:

### 2.1 Top-level shell
- `App.tsx` — shell + routing; owns `<header>` and `<main className="app-main">` (App.tsx:595, 698).
- `components/Sidebar.tsx` — **primary navigation** between views (leverage point — verify it is a `<nav>` landmark; none found in landmark grep).
- `main.tsx`, `index.html` (`<html lang="en">`), `styles.css` (~20.9k lines), `theme.ts`, `labels.ts`.

### 2.2 Views (`packages/ui/src/views/`)
Home (`HomeView` + `home/`: `GreetingBand`, `HomeWorkshop`, `MeesterConversation`, `NightReviewPanel`, `RailSection`, `StatusReportPanel`, `TipOfDay`, `IntroHandboekArticle`) · `GezellenView` / `GezelDetail` · `ProjectsView` / `ProjectOverviewView` / `ProjectGithubView` / `projects/NewProjectDialog` + `NewProjectDetailPane` · `TasksView` / `TaskDetail` / `TaskTabContent` / `tasks/NewTaskDialog` · `DocumentsView` / `DocumentDetail` · `HistoryView` · `ScriptsView` / `ScriptEditorView` / `CraftbookScriptEditorView` · `CraftbooksView` / `CraftbookEditor` / `CraftbookTabContent` · `BenchmarksView` · `FileMapView` · `HandboekView` (+ `handboek/`) · **`SettingsView`** and sub-panels: `AudioEngineSettings`, `ChannelsSettings`, `Ds4Settings`, `FoldersSettings`, `ImageEngineSettings`, `ImageRecognitionSettings`, `LlamaCppSettings`, `MlxSettings`, `OllamaSettings`, `SecurityComplianceSettings`, `VideoEngineSettings`.

### 2.3 High-traffic components (`packages/ui/src/components/`, ~180 files)
Chat: `ChatComposer`, `ChatTimelineView`, `chat-bubbles`, `ChatReferences`, `ChatRecipientPicker`, `GezelChatTab`, `TerminalComposer`/`TerminalBubble`, `AiToolbarButtons`. Rosters/panels: `ProjectCrewRoster`, `CommandsPanel`, `NeedsInputPanel`, `PendingQuestionCard`, `SuggestedNightWork`, `GlobalTimeline`/`ProjectTimeline`/`GezelTimeline`. Pickers/editors: `GezelPicker`, `GezelTemplatePicker`, `ModelPicker`, `ProviderModelSelect`, `GezelJsonEditor`, `MarkdownField`, `SearchPalette`, `TitlebarSearch`. Status/banners: `EngineStatusPill`, `HealthStrip`, `FirstRunInstallBanner`, `BoekwachterPill`, `QueueMeter`, `TabErrorBoundary`, `LevelBadge`, `CapabilityPills`. Media: `AudioPlayer`, `ImagePreview`, `HtmlPreviewFrame`, `GezelIcon`, `CatalogArtwork`, `AreaIcon`.

### 2.4 Modals / dialogs (focus-management hotspots)
Primitive layer: `primitives/Dialog.tsx`, `primitives/AlertDialog.tsx` (shared modal baseline — **highest leverage**). Concrete dialogs: `ConfirmDialog`, `PromptDialog`, `GithubDeviceCodeModal`, `GrantConsentDialog`, `NewPathDialog`, `NewScriptDialog`, `ProjectAddGezelDialog`, `ProjectQuestionsDialog`, `projects/NewProjectDialog`, `tasks/NewTaskDialog`, `DocumentExport/ExportDialog`.

### 2.5 Interactive primitives (`packages/ui/src/primitives/`)
`ContextMenu`, `DropdownMenu`, `Popover`, `Select`, `Tabs`, `Tooltip`, `DropdownChevron`. **These cascade** — a keyboard/ARIA defect in a primitive is a defect everywhere it is used, so they are the top audit priority.

### 2.6 Embedded (`packages/ui/src/embedded/`)
`EmbeddedChat.tsx`, `webview-main.tsx`, `embedded.css` — chat surface embedded into a webview/tool-call card context.

### 2.7 Explicitly out of scope
- **Squisq** markdown editor (Monaco-based rich input in `ChatComposer`) — external package; a11y defects there are filed upstream, not patched here.
- Electron native chrome (BrowserWindow title bar, OS menus) — the platform's responsibility, not the renderer's.
- The non-UI packages (`core`, `mcp`, `cli` TUI, `app` main process) except the supervisor **`.app-fallback-banner`**, which must be reachable/announced.

---

## 3. User flows to audit

1. **First run / onboarding** — `FirstRunInstallBanner`, Home greeting, `MeesterConversation`, install prompts.
2. **Chat with a gezel** — `ChatComposer` (input, send, attach, @-mention & template completion) → `ChatTimelineView` streaming reply + tool-call cards → `ChatReferences` rail.
3. **Manage gezels** — `GezellenView` list → `GezelDetail`; create via `GezelTemplatePicker`; `GezelActionsMenu`.
4. **Manage projects** — `ProjectsView` → `ProjectOverviewView` / `ProjectGithubView`; create via `NewProjectDialog`; `ProjectActionsMenu`, `ProjectCrewRoster`.
5. **Tasks & supervision** — `TasksView` → `TaskDetail`; create via `NewTaskDialog`; advance steps (`TaskStepPanel`/`TaskStepTracker`); answer `PendingQuestionCard` / `NeedsInputPanel`.
6. **Craftbooks** — `CraftbooksView` → `CraftbookEditor` / script editor; `CraftbookParamForm`, `CraftbookStepPanel`.
7. **Documents** — `DocumentsView` → `DocumentDetail` (`MarkdownField`); `ExportDialog`.
8. **History** — `HistoryView` long list; `GlobalTimeline`.
9. **Scripts** — `ScriptsView` → `ScriptEditorView`; `NewScriptDialog`; `ScriptRunForm`.
10. **Settings** — `SettingsView` nav → 11 engine/security sub-panels (forms, model managers), `ConnectedAppsPanel`, `GrantConsentDialog`.
11. **Global search** — `SearchPalette` / `TitlebarSearch` (command-palette pattern; keyboard-first).
12. **Global chrome** — `Sidebar` primary nav, sticky header, all dialog/primitive/banner patterns.

---

## 4. Locked WCAG 2.1 AA acceptance-criteria checklist

Each row: the numbered success criterion, the **pass condition for THIS UI**, and the **verification method** used in Phase 2. Pass = condition holds across the surfaces named; Partial/Fail is recorded per-surface in `notes/audit.md`.

| # | Success Criterion (level) | Pass condition for Gezel's UI | Verification method |
|---|---|---|---|
| 1 | **1.3.1 Info & Relationships (A)** — landmarks & heading order | Shell exposes `<header>`, `<main>`, and a `<nav>` (or `role=navigation`) for `Sidebar`; each view has exactly one `<h1>`-level heading with no skipped levels; rosters/lists (gezels, projects, tasks, history) are `<ul>/<ol>` + `<li>`, not `<div>` stacks. | Grep landmarks/headings across `views/` + `Sidebar.tsx`; read `App.tsx` shell; spot-read list renderers (`GezellenView`, `ProjectsView`, `HistoryView`). |
| 2 | **2.1.1 Keyboard (A)** — everything operable by keyboard | Every interactive control is a native `<button>`/`<a href>`/`<input>` or a custom widget with `role` + `tabIndex={0}` + key handlers (Enter/Space, arrows for menus/lists). No `<div onClick>` without keyboard support. | Grep `<div|span … onClick` without `onKeyDown`; audit primitives (`DropdownMenu`, `ContextMenu`, `Select`, `Tabs`, `Popover`) and `ChatComposer` send/attach. |
| 3 | **2.1.2 No Keyboard Trap (A)** | Focus can enter and leave every widget; modals trap focus *intentionally* and release on Escape/close; the Monaco/Squisq editor and terminal composer let Tab/Escape out. | Read `Dialog.tsx`/`AlertDialog.tsx` trap logic; reason about `ChatComposer`, `TerminalComposer`, editor panes. |
| 4 | **2.4.3 Focus Order (A)** | DOM order matches visual reading order; opening a dialog moves focus into it; closing returns focus to the trigger; streaming updates do not reorder focusable content. | Read dialog open/close focus handling; inspect `ChatTimelineView` insertion behavior. |
| 5 | **2.4.7 Focus Visible (AA)** | A visible, ≥3:1-contrast focus indicator on every focusable element; no global `outline:none` without a replacement `:focus-visible` style. | Grep `outline` / `:focus` / `:focus-visible` in `styles.css`; confirm indicators on buttons, links, inputs, menu items, pills. |
| 6 | **2.4.6 Headings & Labels (AA)** | Headings and control labels are descriptive and unique within a view; dialog titles label their dialog. | Cross-read heading text + `aria-labelledby` on dialogs. |
| 7 | **1.1.1 Non-text Content (A)** — text alternatives | Every meaningful icon-only button has `aria-label`/`title`; `<img>` has `alt` (empty `alt=""` for decorative); `GezelIcon`/`AreaIcon`/`CatalogArtwork` SVGs are labeled or `aria-hidden`. | Grep `<button>…<svg/Icon>` without `aria-label`; grep `<img` without `alt`; read icon components. |
| 8 | **1.3.1 / 4.1.2 Form labels (A)** | Every `<input>/<select>/<textarea>` in Settings, dialogs, and composers has a programmatic label (`<label htmlFor>`, wrapping `<label>`, or `aria-label`/`aria-labelledby`). | Grep inputs across the 11 settings panels + all dialogs; verify each has an associated label. |
| 9 | **4.1.2 Name/Role/Value (A)** — custom widgets | Custom widgets expose correct role + state: menus (`role=menu`/`menuitem`), tabs (`role=tab`/`tablist` + `aria-selected`), selects/comboboxes (`aria-expanded`, `aria-activedescendant`), toggles (`aria-pressed`/`aria-checked`), disclosures (`aria-expanded`). ARIA is minimal and correct (no ARIA where native suffices). | Read each `primitives/*` widget; grep `role=`/`aria-expanded`/`aria-selected`; flag invalid/missing state. |
| 10 | **4.1.3 Status Messages (AA)** | Streaming chat replies, tool-call start/finish, engine-status changes, autosave, and error toasts are announced via `aria-live`/`role=status`/`role=alert` **without moving focus**. | Existing `aria-live`/`role=alert` usages found in chat, autosave, settings; verify the **main streaming message log** and tool-call cards announce, and that live regions don't steal focus. |
| 11 | **1.4.3 Contrast Minimum (AA)** | Body text ≥ **4.5:1**; large text (≥18.66px bold / 24px) ≥ **3:1**. Suspect: muted/disabled text, status-pill text, tool-call card text on subtle backgrounds, placeholder text. | Extract color tokens from `theme.ts`/`styles.css`; compute ratios for text/background pairs on pills, muted, disabled, cards. |
| 12 | **1.4.11 Non-text Contrast (AA)** | UI component boundaries, form-field borders, focus rings, icon glyphs, and state indicators meet **3:1** against adjacent colors. | Inspect border/ring/icon colors in `styles.css`; compute against backgrounds. |
| 13 | **1.4.1 Use of Color (A)** | No information conveyed by color alone — engine/gezel status, git status, validation state, level badges also carry text/shape/icon. | Read `EngineStatusPill`, `HealthStrip`, `ProjectGitStatusBar`, `LevelBadge`, form-error styling. |
| 14 | **1.4.10 Reflow (AA)** | Content reflows to a single column at **320px CSS width** with no loss of function and no 2-D scrolling (except data tables/editors). | Read responsive rules in `styles.css` (`useCompactLayout`); reason about sidebar/rail collapse at narrow width. |
| 15 | **1.4.4 Resize Text (AA)** | Text scales to **200%** without clipping or overlap; layout uses relative units, no fixed-px text containers that clip. | Scan `styles.css` for fixed heights on text containers; check `rem`/`em` usage. |
| 16 | **1.4.13 Content on Hover/Focus (AA)** | Tooltip/popover content (`Tooltip`, `Popover`) is dismissable (Escape), hoverable, and persistent; not hover-only for essential info. | Read `primitives/Tooltip.tsx` / `Popover.tsx` for keyboard + dismiss behavior. |
| 17 | **3.3.1 Error Identification (A) / 3.3.2 Labels or Instructions (A)** | Form errors (settings, dialogs, login) are identified in text and associated with the field; required fields/instructions are stated, not implied. | Read error rendering (`role=alert` sites already found) + field/label association in settings & dialogs. |
| 18 | **2.2.2 / animation — Reduced Motion** (supports 2.3.1 / best practice) | Streaming-cursor blink, card slide-ins, panel transitions, and the growth animation respect `@media (prefers-reduced-motion: reduce)`. | `prefers-reduced-motion` blocks confirmed in `styles.css` (10) + `FileMap.tsx`; verify they cover chat/tool-call/panel animations, not just a subset. |

### Severity rubric for Phase 2/3
- **Critical** — blocks a core flow for a keyboard-only or screen-reader user (e.g. unreachable send button, unlabeled required field, focus trap with no escape).
- **Serious** — significant barrier with a workaround (e.g. missing live region on streaming, contrast fail on primary text, missing landmark).
- **Moderate** — degraded experience (e.g. non-descriptive label, hover-only tooltip, minor contrast on secondary text).

---

## 5. Phase-1 exit criteria (self-check)

- [x] Complete UI surface enumerated from disk (views, components, primitives, dialogs, embedded, shell) — §2.
- [x] Indexed review coverage recorded (0/3158 → no leads; manual audit; no axe-core) — §1.
- [x] User flows to audit listed — §3.
- [x] WCAG 2.1 AA checklist locked with a **per-UI pass condition + verification method** for every criterion, covering 1.3.1, 2.1.1/2.1.2, 2.4.3/2.4.6/2.4.7, 1.1.1, form labels, 4.1.2, 4.1.3, 1.4.1/1.4.3/1.4.4/1.4.10/1.4.11/1.4.13, 3.3.1/3.3.2, reduced motion — §4.
- [x] No findings asserted in this phase.

**Handoff to Phase 2 (Audit):** work the checklist top-down, prioritizing the `primitives/*` widgets and the shared `Dialog`/`AlertDialog` baseline (their defects cascade), then the chat surface, then the 11 settings forms. Record each finding in `notes/audit.md` keyed to its SC number, affected element (file:line), and observed behavior.
