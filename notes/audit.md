# Accessibility Audit — staged findings (gezel/2, step: audit)

**Target:** gezel Electron renderer = React/Vite SPA in `packages/ui/src`.
**Standard:** WCAG 2.1 AA.
**Method:** static markup + CSS inspection (no axe-core in repo; no live browser this pass). Evidence via grep/read across `views/`, `components/`, `primitives/`, `styles.css` (737 KB), `theme.ts`, `index.html`.
**Checklist locked (8):** semantic structure (1.3.1/2.4.6), keyboard operability (2.1.1/2.1.2/2.4.3), focus management & visible (2.4.7), color contrast (1.4.3/1.4.11), alt text (1.1.1), form labels (3.3.2/1.3.1), ARIA correctness (4.1.2/4.1.3), motion/reflow (2.3.3/2.2.2/1.4.10).

Palette (styles.css): light — `--gezel-ink #1c1c1c`, `--gezel-ink-muted #666`, `--gezel-ink-warm-quiet/--ink-3 #8b7e6b`, `--gezel-terra/--accent #b0724c`, canvas `#eae5d6`, panel `#f3eddf`, `--surface` inset `#ddd3bd`, reading paper `#f1e9e1`. Dark — ink `#f0f0f0`, muted `#999`, terra `#c0875d`, canvas `#141517`.

---

## Findings (ranked)

### F1 — SC 1.4.3 Contrast (Minimum), AA — LIGHT THEME — Serious
Ratios computed from token hex; confirm against each element's real font-size (large-text ≥18.66px bold / 24px relaxes to 3:1).
- Body ink `#1c1c1c` on canvas → ~13:1 **PASS**.
- Muted `#666` on canvas → ~4.6:1 PASS (thin); same `#666` on `--surface` inset `#ddd3bd` → **~3.9:1 FAIL**. Impact: secondary/help copy on inset cards fails low-vision readers. Fix: darken muted to ~`#595959` or lighten inset bg.
- Tertiary `#8b7e6b` (`--ink-3`, quiet text in chat + task panels) on reading paper `#f1e9e1` → **~3.3:1 FAIL** for normal text. Fix: darken to ~`#6b6152`.
- Accent terra `#b0724c` as TEXT on light bg → ~3.1:1 — OK as UI-component/focus-ring boundary (3:1) but **FAIL (4.5)** wherever terra is a text color (links, ghost-button labels). Primary button = cream `#f3ede0` on terra `#b0724c` → **~3.3:1 FAIL** for normal ~14px label. Fix: use `--accent-hover #996142` as resting bg (~4:1), bump label to bold ≥18.66px, or darken terra.
- Dark-theme spot-checks PASS (muted `#999` on `#141517` ~6.4:1; terra `#c0875d` ~6:1).

### F2 — SC 2.4.7 Focus Visible, AA — Serious (Partial)
`styles.css:405` `:focus-visible { outline: none; }` globally strips the focus ring, then re-adds it ONLY for input/textarea/select (412–416) and a long allowlist of component classes. There is **no** generic `button`/`a`/`[role="button"]` fallback. Impact: any focusable element not in the allowlist ships with no visible keyboard focus; every new component silently regresses. Fix: low-specificity default —
`:where(a,button,[role="button"],[tabindex="0"],summary):focus-visible{outline:2px solid var(--accent);outline-offset:2px}`, keeping per-component overrides.

### F3 — SC 1.3.1 / 2.4.6 Headings, A/AA — Moderate
Only 3 `<h1>` exist app-wide (HomeView first-run, ScriptsView:105, ScriptEditorView:553). Most top-level views begin at `<h2>` with no `<h1>`: SettingsView:1148, HistoryView:125, FoldersSettings:197, ProjectOverviewView:97, BenchmarksView:205. Views under `<main className="app-main">` (App.tsx:698) expose no top-level heading; the h1→h2 level is skipped. Impact: SR users can't jump to the view title; hierarchy inconsistent. Fix: one `<h1>` per view (styled to match the header), demote section titles consistently.

### F4 — SC 4.1.2 / 3.3.2 Composer input is external Squisq editor — GAP (potentially Serious)
`ChatComposer.tsx:1` imports `EditorShell` from `@bendyline/squisq-editor-react` (Tiptap). The primary compose surface is not a native textarea (`<textarea>` count in ChatComposer = 0); its accessible name / `role="textbox"` / label come from the external package, which is **not in this workspace**. Impact: if EditorShell doesn't expose a labeled textbox, SR users get an opaque compose field — the most-used control. Recommend upstream/AT verification; do not monkey-patch.

### F5 — SC 4.1.2 name via title-only — Minor
ChatComposer Stop button (`ChatComposer.tsx:973`) uses `title="Stop generating (Escape)"` with no `aria-label`; Send button (990) has visible text "Send" (good). `title` contributes to the accessible name but isn't reliably announced or keyboard-discoverable. Fix: add explicit `aria-label` to icon-only controls relying on `title` alone.

### F6 — SC 1.1.1 generated-image alt="" — Minor
`chat-bubbles.tsx:2542` renders a generated/attached chat image with empty `alt=""` (meaningful content marked decorative). Decorative alt="" is otherwise used correctly (GithubSignInChip:129 avatar, ToolsetsEditor:67 logo). Consider deriving alt from prompt/filename when available.

---

## PASS ledger (verified met)
- **SC 3.1.1** Language (A): `index.html:2 <html lang="en">`. PASS.
- **SC 1.3.1 landmarks** (A): App.tsx `<header>`(595) + `<main>`(698); Sidebar.tsx:482 `<nav aria-label="Primary navigation">`; labeled `<nav>` also in HandboekView:242, NewProjectDialog:673, NewTaskDialog:563, ProjectsView:1975. PASS (heading gap tracked in F3).
- **SC 2.1.2 / 2.4.3** (A): primitives/Dialog.tsx wraps Radix Dialog → focus trap, `aria-modal`, Esc close, focus-return, Title/Description labelling. No positive tabIndex (`tabIndex=[1-9]` = 0 matches). PASS.
- **SC 2.1.1** (A): only non-semantic click is chat-bubbles.tsx:548 rendered-markdown content container (link delegation), not a control. Reviewed OK.
- **SC 4.1.3 / 4.1.2 status** (AA): `role="alert"` on errors (ChatComposer:823, GrantConsentDialog, ConnectedAppsPanel, RemoteServersPanel, MachineHealth, TabErrorBoundary); `aria-live="polite"` on autosave/status/streaming (DocumentDetail:119, GezelDetail:237, ChatTimelineView:3611, BoekwachterPill:94 sr-only). PASS.
- **SC 2.2.2 / 2.3.3** motion (A/AA): `@media (prefers-reduced-motion: reduce)` in 10 blocks of styles.css + JS guard FileMap.tsx:182. PASS.
- **SC 3.3.2** labels (A): `<label htmlFor>` in Benchmarks, ExportDialog, MachineHealth(143/179), ToolsetConfigForm:91, GrantConsentDialog:176, FixedFunctionAboutPanel, tuning editors; dense contextual `aria-label`s on Sidebar/ChatComposer icon buttons. PASS with caveat (full engine-settings sweep pending).

---

## Gaps / limitations (carry into report)
- No axe-core in repo and no live browser this pass → automated rule coverage (duplicate ids, runtime ARIA validity, computed contrast on glass/transparency) NOT run. Recommend adding `@axe-core/playwright` to `packages/app` e2e per `.claude/skills/a11yreview` and driving each view.
- Contrast numbers hand-computed from token hex; verify against rendered font-size/weight and translucent/blur backgrounds.
- Form-label completeness only sampled; full per-input sweep of engine settings panels (Ollama/MLX/LlamaCpp/Image/Audio) still needed — some use label-wrapping (valid) which `htmlFor` grep won't show.
- Screen-reader behavior (NVDA/JAWS/VoiceOver), modal focus-return, streaming live-region drift, and reflow at 320px / 400% zoom (SC 1.4.10) require interactive testing — not done statically.

**Final report belongs at** `reports/a11y-review-YYYYMMDD-HHMM.md`.
