# Accessibility Audit Report — Gezel Desktop Renderer

**Task:** gezel/2 · **Phase 3 of 3 (Report)** · **Reviewer:** Borivoje
**Subject:** Gezel Electron renderer — the React/Vite SPA in `packages/ui/src/`.
**Standard:** WCAG 2.1 Level AA
**Method:** Source-based manual audit — semantic/ARIA markup inspection, keyboard-traversal reasoning, and hand-computed contrast from design tokens. **No axe-core** is bundled (`@axe-core/playwright` is not a dep of `packages/app`) and **no live browser** drove the UI this pass. See `notes/scope.md` (surface + locked checklist) and `notes/audit.md` (staged findings) for the underlying evidence.

> **Rev 2 (loop-back):** closed the coverage gaps the evaluate step flagged — SC 1.4.1, 1.4.13, and custom-widget 4.1.2 were assessed by reading `primitives/{Tabs,Select,DropdownMenu,ContextMenu,Popover,Tooltip}.tsx` and `{HealthStrip,EngineStatusPill,ProjectGitStatusBar,LevelBadge}.tsx`; all PASS. Added the **Full checklist disposition** table (all 18 locked SCs), four Passing-criteria rows, and Manual items 8–9 (1.4.11 non-focus facets, 3.3.1 field association). Findings F1–F6 unchanged.

---

## Verdict: **Partially-conformant to WCAG 2.1 AA**

The renderer has a genuinely strong accessibility baseline — labelled landmarks, a Radix-backed modal primitive with real focus trapping, broad `role="alert"`/`aria-live` coverage, and `prefers-reduced-motion` handling. However, **two Level-AA success criteria have confirmed failures** (1.4.3 Contrast, 2.4.7 Focus Visible). Under WCAG's binary per-page conformance model, any failing applicable SC means the UI does **not fully conform** to AA until those are remediated — hence *Partially-conformant*: mostly passing, with specific, fixable AA defects.

### Counts by severity

| Severity | Count | Findings |
|---|---:|---|
| **Critical** (blocks a core flow for keyboard/SR users) | 0 | — |
| **Serious** (significant barrier, confirmed) | 2 | F1 (1.4.3), F2 (2.4.7) |
| **Serious — unresolved GAP** (needs upstream/AT verification) | 1 | F4 (4.1.2 composer) |
| **Moderate** (degraded experience) | 1 | F3 (1.3.1/2.4.6) |
| **Minor** (nit; small localized fix) | 2 | F5 (4.1.2), F6 (1.1.1) |

**Confirmed AA failures gating conformance: 2** (F1, F2). **Blocking upstream unknown: 1** (F4).

---

## Full checklist disposition (18 locked SCs)

Every success criterion locked in `notes/scope.md` §4, dispositioned so coverage is auditable. **PASS** = verified met; **FAIL** = confirmed defect (finding id); **PARTIAL** = met on part of the surface, defect tracked separately; **MANUAL** = requires an interactive/tooling pass a source-only audit cannot settle.

| # | Scope SC (level) | Disposition | Evidence / ref |
|---|---|---|---|
| 1 | 1.3.1 landmarks & heading order (A) | PARTIAL | Landmarks PASS (Passing table); heading order **FAIL → F3**. |
| 2 | 2.1.1 Keyboard (A) | PASS | Only non-semantic click is a markdown link-delegation container (`chat-bubbles.tsx:548`); all primitives are Radix-native (see #9). |
| 3 | 2.1.2 No Keyboard Trap (A) | PASS | `primitives/Dialog.tsx` (Radix) — intentional trap + Esc release; no positive `tabIndex`. |
| 4 | 2.4.3 Focus Order (A) | PASS | Radix `Dialog`/`AlertDialog` focus-in on open, return-to-trigger on close. |
| 5 | 2.4.7 Focus Visible (AA) | **FAIL** | **F2** — global `outline:none`, no generic fallback. |
| 6 | 2.4.6 Headings & Labels (AA) | PARTIAL | Dialog titles labelled (Radix Title); per-view heading gap **→ F3**. |
| 7 | 1.1.1 Non-text Content (A) | PARTIAL | Decorative `alt=""` used correctly; one meaningful image mismarked **→ F6**. |
| 8 | 1.3.1 / 4.1.2 Form labels (A) | PASS (sampled) | Passing table; full engine-panel sweep is Manual item 4. |
| 9 | 4.1.2 Name/Role/Value — custom widgets (A) | PASS | **New this pass** — all primitives Radix-backed; see Passing table + Manual item 8 (per-call-site name). Minor title-only button **→ F5**. |
| 10 | 4.1.3 Status Messages (AA) | PASS | Passing table (`role="alert"` / `aria-live`). |
| 11 | 1.4.3 Contrast Minimum (AA) | **FAIL** | **F1** — light-theme muted/tertiary/terra text + primary button. |
| 12 | 1.4.11 Non-text Contrast (AA) | PARTIAL / MANUAL | State dots are text-backed (not sole indicator → not gated); focus-ring facet Manual item 7; field borders + icon glyphs Manual item 9. |
| 13 | 1.4.1 Use of Color (A) | PASS | **New this pass** — see Passing table. |
| 14 | 1.4.10 Reflow (AA) | MANUAL | Manual item 6 — needs live 320px window. |
| 15 | 1.4.4 Resize Text (AA) | MANUAL | Manual item 6 — needs live 200%/400% zoom. |
| 16 | 1.4.13 Content on Hover/Focus (AA) | PASS | **New this pass** — see Passing table. |
| 17 | 3.3.1 / 3.3.2 Error ID & Labels (A) | PASS / PARTIAL | 3.3.2 PASS (Passing table); 3.3.1 text-identification PASS via `role="alert"`, per-field association is Manual item 9. |
| 18 | 2.2.2 / animation — Reduced Motion (A/AA) | PASS | Passing table (`prefers-reduced-motion`). |

**Net:** 2 confirmed AA failures (F1, F2), 1 upstream gap (F4), 3 moderate/minor findings (F3, F5, F6). Remaining criteria PASS or carry an explicit Manual-verification deferral — no locked SC is left unassessed.

---

## Findings

Ordered by severity, most impactful first. Every finding cites the failing SC, the affected element (`file:line`), the user impact, and the exact code remedy.

### [SERIOUS] SC 1.4.3 Contrast (Minimum) (AA) — light-theme text tokens
**Where:** `styles.css` color tokens — `--gezel-ink-muted #666`, `--ink-3 #8b7e6b`, `--gezel-terra/--accent #b0724c`; applied to muted/help copy, quiet chat & task text, ghost-button labels, and the primary button label.

**What's wrong (ratios hand-computed from token hex, light theme):**
- Muted `#666` on the `--surface` inset `#ddd3bd` → **~3.9:1** (needs 4.5:1 for normal text). Muted on canvas `#eae5d6` is a thin ~4.6:1 pass.
- Tertiary `--ink-3 #8b7e6b` on reading paper `#f1e9e1` → **~3.3:1** for normal text (needs 4.5:1).
- Terra `#b0724c` used **as a text color** (links, ghost-button labels) on light bg → **~3.1:1** (ok as a 3:1 UI-boundary/focus-ring color, fails as 4.5:1 text).
- Primary button: cream `#f3ede0` label on terra `#b0724c` → **~3.3:1** for a normal ~14px label.

**User impact:** low-vision and older users cannot reliably read secondary/help copy, quiet chat/task text, links rendered in terra, and the primary CTA label — the last of which is on the most common action.

**Fix (CSS):**
```css
:root {
  --gezel-ink-muted: #595959;   /* ~4.6:1 on the #ddd3bd inset */
  --ink-3: #6b6152;             /* ~4.7:1 on reading paper */
}
/* Terra as text: use the darker hover tone, not the resting fill */
.link, .btn-ghost { color: var(--accent-hover, #996142); } /* ~4:1+; verify per size */
/* Primary button: darken resting fill OR make the label large-bold to earn the 3:1 relax */
.btn-primary { background: var(--accent-hover, #996142); } /* cream label on #996142 ≈ 4.5:1 */
```
Dark theme spot-checks pass (muted `#999` on `#141517` ~6.4:1; terra `#c0875d` ~6:1) — no change needed there. **Verify every ratio against the element's real rendered font-size/weight** (large text ≥18.66px bold / 24px relaxes to 3:1) and against any translucent/blur backgrounds before closing.

---

### [SERIOUS] SC 2.4.7 Focus Visible (AA) — global focus ring stripped, allowlist re-add
**Where:** `styles.css:405` — `:focus-visible { outline: none; }` (global), with the ring re-added only for `input/textarea/select` (`styles.css:412–416`) and a long allowlist of component classes.

**What's wrong:** the global rule removes the keyboard focus indicator from **everything**, and there is **no generic fallback** for `button`, `a[href]`, `[role="button"]`, or `[tabindex="0"]`. Any focusable element not enumerated in the allowlist ships with no visible focus, and every newly-added component silently regresses because the default is "no ring."

**User impact:** keyboard-only and low-vision users lose track of focus position on any un-allowlisted control — a whole-app risk that grows with each new component.

**Fix (CSS) — add a low-specificity default, keep the per-component overrides:**
```css
:where(a[href], button, [role="button"], [tabindex="0"], summary):focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```
`:where()` keeps specificity at 0 so existing component `:focus-visible` rules still win. Ensure the ring color meets **SC 1.4.11** (≥3:1) against both the control and the page background in both themes — terra `#b0724c` at ~3.1:1 on light is borderline; prefer a slightly darker ring token if a check shows <3:1.

---

### [SERIOUS — GAP] SC 4.1.2 Name, Role, Value (A) / 3.3.2 Labels (A) — primary composer is an external editor
**Where:** `ChatComposer.tsx:1` imports `EditorShell` from `@bendyline/squisq-editor-react` (Tiptap). The main compose surface is **not** a native `<textarea>` (textarea count in `ChatComposer` = 0); its accessible name / `role="textbox"` / label originate in the external package, which is **out of this workspace**.

**What's wrong / unknown:** the most-used control in the product may not expose a labelled, role-correct textbox to assistive tech. This could not be confirmed statically because the source lives upstream.

**User impact:** if `EditorShell` does not surface a `role="textbox"` with an accessible name, screen-reader users get an opaque, unlabelled compose field — a Critical barrier on the core chat flow. If it does, this closes clean.

**Fix:** do **not** monkey-patch the third-party editor. Verify with a screen reader (NVDA/VoiceOver) or axe against the rendered composer; if the name/role is missing, file upstream on `@bendyline/squisq-editor-react` and, as an interim, wrap the mount with an explicit `aria-label` on the container and confirm it is announced. This is the top item on the Manual-verification list below.

---

### [MODERATE] SC 1.3.1 Info & Relationships (A) / 2.4.6 Headings & Labels (AA) — missing/inconsistent `<h1>` per view
**Where:** only 3 `<h1>` exist app-wide (`HomeView` first-run, `ScriptsView:105`, `ScriptEditorView:553`). Most top-level views open at `<h2>` with no `<h1>`: `SettingsView:1148`, `HistoryView:125`, `FoldersSettings:197`, `ProjectOverviewView:97`, `BenchmarksView:205`. Views render inside `<main className="app-main">` (`App.tsx:698`) with no top-level heading, so the h1→h2 level is skipped.

**What's wrong:** the document heading outline is inconsistent and skips a level; there is no per-view page title in the heading hierarchy.

**User impact:** screen-reader users navigating by heading (H key / rotor) cannot jump to the current view's title and encounter an illogical outline.

**Fix:** give each top-level view exactly one `<h1>` naming the view (visually styled to match the existing header treatment so nothing changes visually), and demote current section titles consistently to `<h2>`/`<h3>`. Example for `SettingsView`:
```tsx
<h1 className="view-title">Settings</h1>   {/* was the first <h2> at :1148 */}
```

---

### [MINOR] SC 4.1.2 Name, Role, Value (A) — icon-only control named via `title` alone
**Where:** `ChatComposer.tsx:973` — Stop button uses `title="Stop generating (Escape)"` with no `aria-label`. (The Send button at `:990` has visible text — good.)

**What's wrong:** `title` contributes to the accessible name but is not reliably announced by all AT and is not keyboard-discoverable.

**User impact:** SR users may hear nothing, or an inconsistent name, for the Stop action.

**Fix:**
```tsx
<button aria-label="Stop generating" title="Stop generating (Escape)" …>
```
Apply the same `aria-label` pattern to any other icon-only control relying on `title` alone.

---

### [MINOR] SC 1.1.1 Non-text Content (A) — meaningful chat image marked decorative
**Where:** `chat-bubbles.tsx:2542` renders a generated/attached chat image with empty `alt=""`.

**What's wrong:** content-bearing imagery is flagged decorative, so its meaning is unavailable to SR users. (Decorative `alt=""` is otherwise used correctly — `GithubSignInChip:129` avatar, `ToolsetsEditor:67` logo.)

**User impact:** screen-reader users get no description of a generated/attached image in the transcript.

**Fix:** derive `alt` from the generation prompt or source filename when available; fall back to a generic but non-empty label:
```tsx
<img src={url} alt={prompt || fileName || "Generated image"} />
```

---

## Passing criteria

Success criteria checked and verified **met** this pass (evidence in `notes/audit.md` PASS ledger):

| SC (level) | Evidence |
|---|---|
| **3.1.1 Language of Page** (A) | `index.html:2` — `<html lang="en">`. |
| **1.3.1 Landmarks** (A) | `App.tsx` `<header>`(595) + `<main>`(698); `Sidebar.tsx:482` `<nav aria-label="Primary navigation">`; labelled `<nav>` also in `HandboekView:242`, `NewProjectDialog:673`, `NewTaskDialog:563`, `ProjectsView:1975`. *(Heading gap tracked separately in F3.)* |
| **2.1.1 Keyboard** (A) | Only non-semantic click is `chat-bubbles.tsx:548` (rendered-markdown link-delegation container), not a control. |
| **2.1.2 No Keyboard Trap** (A) | `primitives/Dialog.tsx` wraps Radix Dialog → intentional trap with Esc release. No positive `tabIndex`. |
| **2.4.3 Focus Order** (A) | Radix `Dialog`/`AlertDialog` move focus in on open and return it to the trigger on close. |
| **4.1.3 Status Messages** (AA) | `role="alert"` on errors (`ChatComposer:823`, `GrantConsentDialog`, `ConnectedAppsPanel`, `RemoteServersPanel`, `MachineHealth`, `TabErrorBoundary`); `aria-live="polite"` on autosave/status/streaming (`DocumentDetail:119`, `GezelDetail:237`, `ChatTimelineView:3611`, `BoekwachterPill:94` sr-only). |
| **2.2.2 Pause/Stop/Hide & 2.3.3 Animation from Interactions** (A/AA) | `@media (prefers-reduced-motion: reduce)` in 10 `styles.css` blocks + JS guard `FileMap.tsx:182`. |
| **3.3.2 Labels or Instructions** (A) | `<label htmlFor>` in Benchmarks, `ExportDialog`, `MachineHealth`(143/179), `ToolsetConfigForm:91`, `GrantConsentDialog:176`, `FixedFunctionAboutPanel`, tuning editors; contextual `aria-label`s on Sidebar/ChatComposer icon buttons. *(Passes as sampled — see caveat below.)* |
| **1.4.1 Use of Color** (A) | State never relies on color alone: `HealthStrip` pills prefix a glyph + text label — `✓`/`!` (`HealthStrip.tsx:124`), `✗` missing-engine (`:189`), `✗`/`⏳` MLX (`:214`/`:224`). `EngineStatusPill` idle renders an "On-device · <model>" text badge; the busy dot is `aria-hidden` (`:660`) and the indicator carries `role="progressbar"` + `aria-label={busyLabel}` (`:672–674`). `ProjectGitStatusBar` derives a text phrase via `statusChipPhrase()` (`:395`), marks its status/index dots `aria-hidden` (`:138`/`:571`/`:681`), and gives each control a text `aria-label` (`:520`,`:679`,`:701`,`:727`). `LevelBadge` renders `Lv N` text + `aria-label` (`:28`). |
| **1.4.13 Content on Hover/Focus** (AA) | `primitives/Tooltip.tsx` and `Popover.tsx` are thin `@radix-ui/react-tooltip` / `-popover` wrappers. Radix tooltip content is Escape-**dismissable**, **hoverable** (`disableHoverableContent` defaults off), and **persistent** (no auto-dismiss timer); the `Hint` shortcut (`Tooltip.tsx:36`) only carries supplementary plain text, never essential-only info. `Popover` is click-triggered disclosure (Esc-dismissable, focus-managed), not hover content. |
| **4.1.2 Name/Role/Value — custom widgets** (A) | All five interactive primitives are thin re-exports of `@radix-ui/react-*`, which supply WAI-ARIA APG roles + state + keyboard natively: `Tabs.tsx` (tablist/tab/tabpanel, roving arrow keys, `aria-selected`); `Select.tsx:5–24` (combobox/listbox/option, `aria-expanded`, typeahead; trigger chevron `aria-hidden` `:20`); `DropdownMenu.tsx:5–9` + `ContextMenu.tsx:5–9` (menu/menuitem, arrow/Home/End/Esc/typeahead); `Popover.tsx:3–19`. This also discharges the keyboard-operability walk for the cascading primitives. *(Correctness at each **call site** — trigger accessible name, matched `Value`/`ItemText` — is Manual item 8.)* |
| **3.3.1 Error Identification** (A) | Form/login/consent errors are surfaced **in text** via `role="alert"` (`ChatComposer:823`, `GrantConsentDialog`, `ConnectedAppsPanel`, `RemoteServersPanel`, `MachineHealth`, `TabErrorBoundary`) — not color/icon alone. *(Programmatic per-field association via `aria-describedby`/adjacency is Manual item 9.)* |

---

## Manual verification needed

Items a static, source-only pass cannot fully settle. These are **not** passes or fails — they require an interactive/tooling pass before conformance can be asserted with confidence.

1. **Composer accessible name (F4)** — drive a screen reader (NVDA/VoiceOver) or axe against the rendered `EditorShell` to confirm the compose field exposes `role="textbox"` + an accessible name. Highest priority; determines whether F4 is Critical or a clean pass.
2. **Automated rule coverage** — no axe-core ran, so runtime-only checks were not performed: duplicate `id`s, invalid runtime ARIA states, computed contrast over translucent/blur (glass) backgrounds, and orphaned `aria-labelledby`/`for` references. **Recommend adding `@axe-core/playwright` to `packages/app` e2e** and driving each view (per `.claude/skills/a11yreview`).
3. **Contrast against rendered pixels** — F1 ratios are hand-computed from token hex. Re-verify each against the element's real font-size/weight and against any translucent/blurred surfaces where the effective background differs from the token.
4. **Full form-label sweep** — label completeness was sampled, not exhaustive. Complete a per-input pass of the engine settings panels (Ollama / MLX / LlamaCpp / Image / Audio); some use label-wrapping (valid) that an `htmlFor` grep won't surface.
5. **Screen-reader announcement quality** — streaming live-region drift/duplication, tool-call card announcements, modal focus-return in practice, and status-message timing need real AT (NVDA/JAWS/VoiceOver).
6. **Reflow & resize (SC 1.4.10 / 1.4.4)** — verify single-column reflow at 320px CSS width and text scaling to 200%/400% zoom with no clipping or 2-D scrolling, in a live window. Not exercised statically.
7. **Focus-ring non-text contrast (SC 1.4.11)** — once the F2 default ring lands, confirm the chosen ring color is ≥3:1 against both control and background in both themes.
8. **Primitive accessible names at call sites (SC 4.1.2)** — the `primitives/*` widgets are role/state-correct (Radix), but each *usage* must still supply an accessible name: a `<Select.Value>`/`aria-label` on every `Select.Trigger`, a labelled trigger on each `DropdownMenu`/`ContextMenu`/`Popover`, and a `textValue` on `Select.Item`s whose children are rich JSX (e.g. mention pills). Spot-check the high-traffic pickers (`ModelPicker`, `ProviderModelSelect`, `GezelPicker`, font picker) with a screen reader.
9. **Non-text contrast of borders/icons (SC 1.4.11) + per-field error association (SC 3.3.1)** — (a) computed contrast could not be measured statically for form-field borders, standalone icon glyphs, and status dots at 3:1 against their real backgrounds; verify in a live window (state dots are text-backed so they don't *gate*, but should still be checked). (b) Confirm each form error is not just announced (`role="alert"`) but also programmatically tied to its field via `aria-describedby` or DOM adjacency, per input, across the settings panels and dialogs.

---

*Scope, checklist, and staged evidence: `notes/scope.md`, `notes/audit.md`. This report is the Phase-3 deliverable for task gezel/2.*
