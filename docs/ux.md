# Gezel UX

This document captures the UX philosophy of Gezel — what the app should feel
like, how that translates into concrete patterns, and how new surfaces should
be built so they land inside the same world as the rest. It complements
[CLAUDE.md](../CLAUDE.md), which describes the runtime and code layering.

The aesthetic is aspirational; today the app is functional and utilitarian.
Read this as the direction we're heading, not a description of what's already
on screen. Every new surface should nudge us toward it.

## Feel

Three words that should describe any screen:

1. **Organic** — human, warm, a little imperfect. Not factory-flat. Gentle
   curves, generous whitespace, colors pulled from wood/parchment/ink rather
   than from a corporate palette. Transitions fade and settle rather than
   pop.
2. **Classic** — the app should read like a well-made tool you'd keep for
   years, not a product surfacing the month's design trend. Typography,
   proportion, and materials over novelty and chrome. Nothing that would
   look dated in 2031.
3. **Historic** — Gezel is a guild. The vocabulary (gezel, meester, voorman)
   is Dutch apprenticeship terminology; the visuals should echo the world
   those words come from. A guild hall, an apprentice's bench, a master's
   ledger — not a SaaS dashboard.

What this *doesn't* mean: kitsch, pastiche, or literal skeuomorphism. The one place a
*vaguely* skeuomorphic cue is welcome is physicality on things you press:
gezels are workers at craft tables, so controls may read as tools set into
the bench — keys resting in trays, expressed through light and depth
(gradients, bevels, inset shadows), never through textures or ornament. See
[Controls: keys in trays](#controls-keys-in-trays) below. Beyond that, the
cues stay subtle — color temperature, border weights, corner radii, the
pacing of a transition. If a first-time user can't quite put a finger on
*why* the app feels different, we've done it right.

## What that translates into

- **Color** lives in
  [styles/foundation.css](../packages/ui/src/styles/foundation.css).
  The `--gezel-*` foundation palette is the authored source for paper, ink,
  sage, and terracotta tones; theme-resolving semantic aliases (`--bg`,
  `--surface`, `--panel`, `--border`, `--text`, `--text-muted`, `--accent`,
  `--success`, `--warning`, `--danger`) are what component rules consume.
  Scoped surfaces may derive a nearby tone with `color-mix()` but must not
  start a parallel palette. Hardcoded colors are reserved for domain visuals
  whose color carries data or content (diffs, terminal ANSI, Village artwork,
  poppetjes), not app chrome.
- **Motion** is slow-ish and soft: ~120–160ms ease-out for overlay and
  dialog in/out. Nothing snaps or bounces. See the `gz-overlay` /
  `gz-dialog` keyframes for the canonical cadence; match it elsewhere.
- **Corners** are mostly-square with small rounding, drawn from the shared
  radius tokens: `--radius-sm` (4px) for badges and chips, `--radius-md`
  (6px) for keys, buttons, and inputs, `--radius-lg` (10px) for trays and
  small surfaces; panels and dialogs may go a step larger. Never perfectly
  square; never capsule-shaped for anything interactive. Fully-rounded
  (`999px` / `50%`) is reserved for true circles — dots, avatars, scrollbar
  thumbs, switch knobs — plus one flat exception: **non-interactive status
  badges** (`.home-status-pill` and its variants) are true capsules. They
  are read-only annotations, not controls, and the capsule silhouette is
  what keeps them from being mistaken for buttons. There are no pill
  buttons — a capsule-shaped *control* is a bug, not a variant; if a
  capsule needs a click handler, it's a key or a small-radius chip
  (`.license-button` is the reference: shares the badge recipe but keeps
  the small radius because it's a link).
- **Typography** is a two-font system — **Hanken Grotesk** (sans) for all
  UI chrome and **PT Serif** (serif) for the editorial register. Both are
  bundled woff2 (no CDN). The rules and the shared size scale live in
  [Typography](#typography) below; read it before styling any text.
- **Density** is moderate. We're not Linear-tight and not Notion-loose.
  Line-height is comfortable; gaps between related controls are ~0.5rem.
- **No emojis in committed UI** (repeating the rule from CLAUDE.md). The
  ⭐ Meester badge is the single sanctioned exception.

## Controls: keys in trays

The standard treatment for **radio-like choice controls** — any row of
mutually exclusive options (engagement mode, tempo, provider, type pickers,
filter chips). The metaphor follows the app's framing of gezels as workers
at craft tables: a group of options is a shallow **tray** routed into the
bench, each option is a raised, mostly-square **key**, and the chosen key
sits **pressed and latched**. The 3D is expressed through light and depth
only — gradients a few percent apart, a 1px top highlight, an inset recess —
never through textures.

Implementation lives in exactly two places:

- **Tokens** in
  [styles/foundation.css](../packages/ui/src/styles/foundation.css), in
  `:root` and the three theme-override blocks:
  `--tray-bg/-border/-shadow`, `--key-bg/-bg-hover/-border/-shadow`, and
  `--key-pressed-bg/-border/-ink/-shadow`.
- **The "Keys in trays" block** in
  [styles/controls-handbook-and-admin.css](../packages/ui/src/styles/controls-handbook-and-admin.css)
  — the single CSS recipe. `.gz-tray` is the group; `.gz-key` is the option
  (`.gz-key--stacked` for label + hint); the latched state is
  `.gz-key-active` or `aria-checked="true"`.

Canonical markup (the AI engagement switch in SettingsView is the reference
implementation):

```tsx
<div className="gz-tray" role="radiogroup" aria-label="AI engagement">
  <button
    type="button"
    role="radio"
    aria-checked={selected}
    className={`gz-key${selected ? ' gz-key-active' : ''}`}
  >
    Proactive
  </button>
  …
</div>
```

Rules:

- **Keys are `--radius-md`; trays are `--radius-lg`** so their corners stay
  parallel. Don't restyle keys per-surface — if a surface needs something
  the recipe lacks, extend the recipe (and this section) instead.
- **Bare keys (no tray) are fine for inline choices** floating inside
  content — chat answer chips, catalog filter rows. Standing controls in
  settings and dialog forms get the tray.
- **Selected = pressed in, not popped out.** The latched key translates down
  1px, takes the accent fill, and carries an inset shadow. Hover lightens
  the raised face; mousedown previews the pressed depth.
- **Derived states may sit latched but inert.** When a group can enter a
  state the user doesn't pick directly (the security posture's "Custom",
  reached by editing individual capability switches), render it as a
  `gz-key gz-key-active gz-key-state` button with `disabled` +
  `aria-checked="true"` — the `.gz-key-state` extension keeps the pressed
  treatment at full strength while the key refuses interaction.
- **Only a spectrum's extremes may recolor the latch.** The pressed face
  defaults to the accent. When a group is a spectrum with meaningful ends,
  the end keys may override it — the AI engagement "Off" latches
  danger-red (hard stop), the security posture latches sealed-green
  on Super Lockdown and open-amber on Unrestricted. Middle options keep
  the accent; never give every key its own color.
- **State groups are the exception: they latch in the state's own color.**
  A tray that sets an entity's **lifecycle state** rather than a preference —
  the task status keys (active / paused / complete / canceled) — may give
  every key its own latch, because the color is data the app already shows
  elsewhere (the task list's status dots) and only one key is ever latched,
  so the tray still reads as a single color. Each key also carries the glyph
  its state is already understood by: play, pause, check, circle-slash. This
  holds only for states the app colors elsewhere; a preference group with no
  meaningful ends stays on the accent.
- **Icon-only keys are sanctioned for tight panel headers and toolbars**
  where 2–5 modes must fit beside a title — use `gz-key gz-key--icon`
  (near-square padding, no label gap) inside the usual `role="radiogroup"`
  tray, and give every key both `title` and `aria-label` since there is no
  visible text. The file-panel view switch (`FileViewModeKeys`) is the
  reference implementation. This is still a keys case, not Tabs: the same
  content is being re-presented (sorted, flattened), not swapped for a
  different panel.
- **A tray may also hold actions, not just modes** — the same icon keys in a
  `role="toolbar"` (or `role="presentation"` when the group needs no name)
  instead of a radiogroup, with nothing latched. Reach for it when a compact
  row of verbs repeats down a list and the words would out-shout the content
  they act on: the Boekwachter issue rows are the reference, where *Mark
  read · Not an issue · Mark resolved · Fix* sat as four text links beside
  every issue and left the message wrapping four words to a line. Three rules
  travel with it. Put the tray on its own row under the content rather than
  in a second column — a side rail of controls is what squeezed the text in
  the first place. **Name the group after the row's subject**
  (`aria-label="Actions for BW-8"`) so the keys can keep short labels instead
  of a screen reader hearing "Mark resolved" once per row with nothing to
  tell them apart. And when one action is more consequential than its
  neighbours (Fix creates a task), give it the accent ink — never a second
  latched-looking fill.
- **Native `<input type="radio">` stays native** in dense config forms
  (folder scopes, engine settings) — the round dot is a true circle and
  keeps its shape. Reach for keys when the choice is prominent enough to
  deserve a control with physical presence.
- **Legacy aliases:** `.provider-pill`, `.gz-type-chip`,
  `.pending-question-choice`, and `.catalog-category` (plus their wrappers)
  are aliased into the recipe pending markup migration. When touching one of
  those surfaces, move it to the `gz-*` classes and delete its alias.
- **A tray whose latched choice explains itself gets the described-tray
  connection.** When a paragraph under the tray describes the *currently
  latched* option (the security posture, AI engagement, tempo), a bare muted
  `<p>` floats between the tray and whatever follows, attached to neither —
  "A posture for trusted work" never visibly belonged to the Lockdown key.
  Add `gz-tray--described` to the tray and `gz-tray-description` to the
  paragraph: the panel takes the tray's own recessed surface, a short slot
  in the panel's material (panel fill, panel-border side walls) rises
  through the tray's bottom edge to meet the latched key, and the
  copy leads with the latched option's name —
  `<strong>{label}</strong> — description`. The description is a readout of
  the tray, so it sits directly beneath with the recipe's 0.5rem gap; don't
  wedge other content between them. The Security & Compliance posture
  switch (first run + Settings) is the reference implementation.
  label on top, a smaller muted hint beneath, left-aligned, wrapping
  allowed. Put the two lines in `.gz-key-label` and `.gz-key-hint` — the
  recipe styles both, so a new surface never needs its own pair (the
  night-shift menu's `app-engagement-menu-label`/`-hint` predates them and
  is the case that motivated generalizing). The hint is `--text-xs` in
  `--text-muted` and must never compete with the label; on a latched key it
  inherits the pressed ink and separates by opacity instead, because muted
  grey on the accent fill loses contrast. `.pending-question-choice-described`
  (Claude CLI AskUserQuestion options) is the other example.
  The ds4 Settings "Memory use" tray is the reference for a stacked
  two-option preference.
- **No new fully-rounded controls.** If you're reaching for
  `border-radius: 999px` on anything with a text label, it should almost
  certainly be a key or a small-radius chip instead.

## Controls: budget sliders

The standard treatment for **continuous "how much may gezel take" ranges** —
memory budgets, cache budgets, per-model context size. One CSS recipe
(`.gz-budget-slider` in
[styles/village-and-overview.css](../packages/ui/src/styles/village-and-overview.css)), one
interaction contract, shared by every user (`EngineMemoryBudgetPanel`,
`CacheControlsPanel`, `ModelContextSliderPanel`). Don't restyle a slider
per-surface; if a surface needs something the recipe lacks, extend the recipe
(and this section) instead.

The contract:

- **"Automatic" is a visible position, not a hidden default.** A `▲ Auto ·
  <value>` tick sits under the track at the auto-derived value, so an
  override always shows how far it drifts from what gezel would pick for
  this machine. Dragging within one step of the tick snaps back to
  Automatic.
- **Draft, then Save.** The slider holds a draft (`null` = following
  automatic); nothing persists until an explicit **Save**, and an active
  override always offers **Back to automatic** as a first-class button —
  never make users hunt for the escape hatch.
- **Show the consequence while dragging.** The head row updates live with
  what the position costs (`~X GB in memory`, a value tag flipping
  Automatic → Custom → a warning tone when past what's recommended or
  fits).
- **Warn above the safe zone, don't block.** Positions past what the
  machine can comfortably back stay reachable — flagged with an `<output>`
  line explaining what actually happens (clamping, swapping) — because the
  honest failure mode is visible degradation, not a wall.
- The native range input keeps `accent-color: var(--accent)`; the thumb is
  a sanctioned true circle (see the keys-in-trays rules above). The
  machine-health temperature control's key-shaped thumb is the one
  deliberate variant.

## Typography

Two typefaces, both bundled as woff2 (see
[assets/fonts/fonts.css](../packages/ui/src/assets/fonts/fonts.css)) — no
web-font CDN, no runtime fetch. They are exposed as CSS variables in
[styles/foundation.css](../packages/ui/src/styles/foundation.css) `:root`
and you should always
reference the variable, never the family name:

| Token             | Family             | Role                                                        |
| ----------------- | ------------------ | ----------------------------------------------------------- |
| `--font-ui`       | Hanken Grotesk     | The default for **everything**: chrome, controls, body, links |
| `--font-display`  | PT Serif           | The editorial register: headings + long-form prose only     |

**The one rule that keeps a surface consistent:**

> **Headings carry the serif (`--font-display`); all other text — body,
> labels, helper text, buttons, inputs, and links — is sans (`--font-ui`).**

This is already wired globally: `h1`–`h6` opt into the serif, and a small
set of long-form surfaces (chat message bodies, the Home intro card) opt in
explicitly. Everything else inherits the sans by default. So in practice you
almost never set `font-family` yourself. The two things to actively watch:

- **Links stay sans even inside a heading.** A link styled with
  `font: inherit` (e.g. `.home-link`) placed inside an `<h3>`/`<h4>` will
  inherit the serif — that's a bug. Force `font-family: var(--font-ui)` on
  the link (the settings surface does this: `.settings-panel a`).
- **Weights: PT Serif ships only 400 and 700.** Don't ask for 500/600 on a
  serif heading — it rounds up to the 700 face and reads as a synthesized
  weight. Leave headings at their natural bold, or set 400 for a lighter
  editorial look. Hanken Grotesk has 400/500/600/700, so sans text can use
  the full range.

### The size scale

Dense UI chrome (settings, dialogs, panels) is where sizes sprawl. Use the
shared `--text-*` scale instead of ad-hoc `rem`/`px` values or leaning on
browser UA defaults (a bare `<button>` renders ~13.3px and a bare `<h3>`
~18.7px, neither matching the body — that mismatch is most of what makes a
panel look "off"):

| Token        | Size            | Use                                            |
| ------------ | --------------- | ---------------------------------------------- |
| `--text-2xs` | 0.72rem (~11.5px) | Badges, pills, uppercase eyebrow labels      |
| `--text-xs`  | 0.8rem (~12.8px)  | Helper / caption text                        |
| `--text-sm`  | 0.85rem (~13.6px) | Dense controls, secondary body copy          |
| `--text-md`  | 0.9rem (~14.4px)  | Default UI body                              |
| `--text-lg`  | 1rem (16px)       | Emphasized body, dialog/panel sub-headings   |
| `--text-xl`  | 1.1rem (~17.6px)  | Panel & dialog section headings              |

Long-form editorial surfaces (chat, Home intro, markdown prose) are the
deliberate exception — they set their own comfortable reading size (1rem+)
and don't draw from this scale.

**Reference implementation:** the `.settings-panel` typography block in
[styles/settings-and-status.css](../packages/ui/src/styles/settings-and-status.css)
is the canonical application —
one scoped block that pins the panel's headings, body, controls, and links
to the rules above so no single tab mixes a dozen font/size combos. New
dialog and panel surfaces should follow the same shape: a small scoped
block, sizes from the scale, `font-family` left to the global default except
where a link needs forcing back to sans.

## Foundation

The UI is React + Vite with **plain CSS + CSS variables** — no Tailwind, no
CSS-in-JS. All complex interactive controls (dialog, select, tabs, popover,
tooltip, dropdown, alert-dialog) come from **Radix UI Primitives**,
re-exported from [packages/ui/src/primitives/](../packages/ui/src/primitives/)
with our `gz-*` classes pre-wired. **Never import `@radix-ui/react-*`
directly outside the primitives layer** — always import from
`../primitives/index.js` (or the barrel export). This keeps every surface
one edit away from a global animation or surface tweak.

What lives where:

| Layer                               | Where                                                     |
| ----------------------------------- | --------------------------------------------------------- |
| Design tokens (colors, space, etc.) | [styles/foundation.css](../packages/ui/src/styles/foundation.css) `:root` |
| Overlay, dialog, tabs, select CSS   | [`styles/` ownership map](../packages/ui/src/styles/README.md) `gz-*` blocks |
| Headless primitives (JSX)           | [primitives/](../packages/ui/src/primitives/)             |
| Shared behavior components          | [components/](../packages/ui/src/components/)             |
| Top-level views                     | [views/](../packages/ui/src/views/)                       |

## Patterns

**Dialog vs AlertDialog.** Use `AlertDialog` only for confirmations that
interrupt a destructive or significant action (delete a gezel, discard
changes). Everything else — create forms, rename prompts, icon iteration,
template pickers — is a plain `Dialog`. AlertDialogs block the user until
they respond; Dialogs are dismissable with Escape/backdrop-click.

**Select vs keys vs tab bar.** If the content panel below changes based on
the choice, use **Tabs**. If it's one of many equivalent values (a long
model list), use **Select**. If there are roughly 2–5 mutually exclusive
options and the choices themselves carry the meaning (Copilot / OpenAI /
Ollama, engagement modes, tempo, a task's status), use **keys in a tray** — see
[Controls: keys in trays](#controls-keys-in-trays). The Home + Settings
provider switches are this pattern.

**Connected tabs, for a switch that fronts the surface below it.** The
default tab bar (`gz-tabs-trigger`) marks the current tab with an accent
underline and is right for a row of peer destinations. When the choice
instead swaps the *surface directly beneath the tab* — the project
composer's `@ Chat` / `> Terminal` switch, which replaces the whole compose
stack under it — use the connected treatment: top-rounded corners only, the
tab hanging off the bottom edge of its host row onto a seam, and the
selected tab erasing the pixel of seam it stands on so tab and panel read as
one surface. Selection is carried by that break plus a 2px accent bar on the
tab's top edge; a latched key fill defeats the whole effect, because the
panel the tab merges into is not tinted. Unselected tabs stay recessed
(`--tray-bg`) and keep all four edges. The seam is not optional — fill alone
cannot join anything when the tab's own row and the band below share a
background, which is how the first attempt read as a chip parked in the
address line. Reach for this only when the tab genuinely sits on the seam of
what it switches; a tab floating above unrelated content has nothing to
connect to and should be an underline tab or keys instead.

**Split buttons.** Use a split button when one creation action is the clear,
frequent default and two or three closely-related variants should remain
available without crowding the toolbar. The wide left key performs the default
immediately; the narrow attached right key opens a `DropdownMenu`. Join the
halves on one straight seam and keep `--radius-md` only on the outside corners.
Menu items should name the variant and may carry one short hint line. The Tasks
screen's New task / scheduled / Night Shift control is the reference.

**A menu never runs off the window.** Radix flips a panel to the other side
when it doesn't fit, but a list taller than *either* side — the chat rail's
References menu grows with every file a gezel touches — still spills past the
edge, because Radix measures the room and leaves the clamping to CSS. The
shared `.app-nav-menu` panel takes
`max-height: calc(var(--radix-popper-available-height, 100vh) - 0.75rem)` and
scrolls; a menu that opts out of that class owes itself the same pair. Vertical
scrollers keep the native bar, so nothing else is needed.

**Resizable splits.** A two-pane split that a user might want to rebalance
gets a grip, not a fixed track: a full-height `role="separator"` element with
`.chat-rail-grip` between the panes, whose twin rails only appear on hover or
focus. The drag persists to `localStorage` (globally, not per project) and the
grip answers Arrow / Shift+Arrow / Home / End so it works without a mouse. Store
a **fraction** when the split is about balance (the chat rail, the project
output pane) and **pixels** when the useful size is set by content rather than
by window width — a file tree is sized by how long filenames are. Pixel splits
also get a **collapsed rail**: dragging past the point where the pane stops
being readable snaps it to a ~2rem strip carrying a chevron and the pane's name
set in `writing-mode: vertical-rl`, which is also the way back. Collapse is a
snap, never a sliver — never leave a pane too narrow to read. The Workspace /
Artifacts file tree is the reference.

**One file browser, everywhere.** Any surface that browses a tree of files —
the project Workspace, the project Artifacts drawer, the shared Documents
library — renders
[`FileBrowserPane`](../packages/ui/src/components/file-browser/FileBrowserPane.tsx)
against a `FileBrowserSource`. That is the whole panel: the resizable +
collapsible tree, the view-mode keys, the show-hidden key, the create keys,
per-row rename/delete, OS drag-and-drop import, the truncation notice, and the
media/binary previews. Do not hand-roll a second file pane; add to this one.

The source adapter is what varies, and capabilities are declared by presence:
an adapter with no `mkdir` gets no New folder key, one with `canWrite: false`
(a workspace whose write policy says no) gets no mutations at all, and one with
no `reveal` gets no Open button. Anything genuinely specific to a surface
arrives as a slot — `headerExtra`, `notices`, `trailingForEntry`,
`detailForEntry`, `customList`, `extraPane` — which is how the Workspace hangs its index state,
issue badges, triage lists, and Boekwachter pane off the shared panel without
forking it. **Every file editor autosaves** through
`useSerializedAutosave` with the dirty state in the status bar; a Save button
in a file pane is a bug, because a mutation elsewhere in the panel flushes the
lane rather than racing it.

**A search result is a card: the document, then why it surfaced.** Matched
prose does not fit on the name's line, and the row's trailing slot never
shrinks — put a sentence there and it claims the full width, leaving the
result unattributable to any file. So a result row stacks: the file name (with
its muted parent folder) on top, the snippet clamped to two lines beneath,
the whole card one click target. That is `detailForEntry` on the shared flat
list; `trailingForEntry` stays what it is for — short, fixed-width status.
A snippet is a signpost to the document, never a substitute for opening it,
so it clamps rather than growing the row.

**A search result also says how it was found.** Our search is hybrid: some
hits contain the words the user typed, others are only the nearest thing the
embedder had. Those two claims are not the same promise, and the reader
cannot tell them apart from the snippet — a semantic hit's excerpt is
usually the file's *generated summary*, so an unrelated document arrives
wearing a confident description of itself. Any surface listing mixed-arm
results marks the semantic ones with a small uppercase `related` badge
(`--text-2xs`, `--radius-sm`, `--border` — the neutral badge recipe shared
with chat's `automatic`), and never marks a keyword hit. Presenting the two
identically is how document search came to read as "it just lists my
library". The floor that keeps genuinely-unrelated neighbours out of the
list in the first place is a service concern — `VECTOR_ARM_MIN_SIMILARITY`
in [index-store.ts](../packages/service/src/index-store/index-store.ts).

The rule generalises past file panes: **any long-form prose editor autosaves**,
wherever it lives. A gezel's `about.md`, a project's about/mission, a document,
a memory, and a task's description are all the same shape — a body of text the
reader edits in place — and the panel hosting one can unmount on a tab switch
or a selection change without warning. The task description was the last
holdout and the one that proved the point: it carried a Save button, its
comment claimed a blur flush that did not exist, and any edit not explicitly
committed was discarded silently. An explicit button stays correct only where
the action publishes a discrete thing rather than saving a document — posting a
note, recording an outcome.

**The pane's own edges are the only edges.** One rounded border belongs to the
panel as a whole (`.project-files-layout`, or the app frame when a view is
full-bleed); whatever fills the viewer pane runs flush to it and draws no border
or radius of its own. A second rounded box a hairline inside the first reads as
a rendering fault, and its left edge doubles the seam the tree's `border-right`
already draws — the editor should butt straight against the tree. Card-shaped
hosts are the contrast that makes the rule clear: a project's about/mission
field or a gezel's `about.md` is a bordered card sitting *in* a form, and keeps
its border.

**Embedded Squisq surfaces get a palette bridge.** Squisq ships cool greys and
a blue primary; anything of its chrome mounted inside gezel is repainted onto
the gezel tokens rather than left in the vendor palette — the editor shell's
status bar and outline rail, the schema form, and the folder landing page a
file pane shows when a folder is selected (`.squisq-folder-view`, bridged in
[styles/file-browser.css](../packages/ui/src/styles/file-browser.css)). That
page's *New document* / *New folder* actions are ordinary keys, not a
full-width primary slab. Squisq's stylesheet is bundled after ours, so a bridge
rule wins by out-specifying the vendor rule (matching its `[data-theme]`), not
by source order.

**Forms.** Raw `<input>`, `<textarea>`, `<fieldset>` are fine — Radix
doesn't ship form primitives and we don't need them. Schema-driven Squisq
forms use the shared `GezelJsonEditor` wrapper. It keeps Squisq's built-in
`gezellig` editorial theme, bridges its form tokens to the live Gezel palette,
and aliases segmented choices into the keys-in-trays recipe across project,
task, script, and settings surfaces. For autosave, debounce via
`saveTimer = setTimeout(...)`; see
DocumentsView or GezelsView for the established pattern. Don't reach for
react-hook-form unless a specific form has real validation needs.

**Creation flows.** New-entity dialogs (new gezel, new document, new task)
close immediately on submit and show their result asynchronously. Never
block the user waiting for an LLM round-trip to decorate the new entity
(icon generation, about.md drafting) — kick it off in the background.

**Gallery dialogs.** When a creation flow starts from a catalog of
starting points (project types, craftbooks), use the shared gallery-dialog
layout: header with title + search, a category rail on the left, and a card
gallery filling the rest. The CSS skeleton is the `gz-npd-*`
block in [styles/project-surfaces.css](../packages/ui/src/styles/project-surfaces.css)
(named for the New Project dialog, its first tenant); New Task reuses it with a `gz-ntd`
modifier for task-only pieces. New gallery surfaces should reuse the
skeleton the same way — extend it rather than fork it. Lead the gallery
with the curated, context-relevant subset (e.g. craftbooks recommended
for the project's type) and keep the full catalog one rail-click away.

**A gallery dialog is a two-step wizard.** Both tenants are: New Task and
New Project (`gz-npd-step-pick` / `gz-npd-step-configure` in
[styles/project-surfaces.css](../packages/ui/src/styles/project-surfaces.css)).
The old third column — a 19rem pane holding the selection's hero and its
whole form — could not carry what these choices actually are. A craftbook is
a page: a paragraph of description, four to a dozen named steps with their
own one-liners, and a parameter form. A project type is a crew, a toolset, a
set of scheduled routines and a stack of craftbooks — the reason a person
picks it over a blank workspace. Clamped into the pane, the description lost
its tail to a five-line clamp and the params stacked below the fold.

Step 1 is the catalog alone: rail + gallery across the full dialog. New
Task also puts the *project* picker in that header, because that choice
decides which craftbooks are applicable and recommended. Choosing a card —
the blank card included — advances to step 2: what the starting point is and
what it brings on the left, the properties form on the right, and one back
key returning to the gallery with the choice still lit. Three rules keep it
from reading as two different dialogs: the dialog keeps its size and its
footer bar across both steps so the frame never jumps, the selection
survives going back, and nothing is created until the second screen (the
picker's footnote says so, and Enter in the search field must not submit the
form).

**Step 2 goes to one centered column when there is nothing to read.** Two
columns are for a selection whose brief earns one — a craftbook's steps, a
project type's crew and tooling. A built-in project kind's brief is a
sentence and two lines (`data-lean`), and New Task's blank card has none at
all (`data-blank`); a full-width column beside either leaves two-thirds of
the dialog standing empty. Both stack into one centered column instead, at
the same dialog size.

**Shelve a big catalog by subject, not by lifecycle.** A rail whose shelves
answer "where in a project's life does this fit?" collapses on a large
catalog — New Task's 255 craftbooks landed in two piles, the larger one
("General work", 195 books) holding recipes about media, household admin,
and marketing alongside the code work the person actually came for. Shelves
come from `CRAFTBOOK_CATEGORY_META`, grouped by family with the uppercase
eyebrow (`.gz-npd-rail-group`) between groups; a shelf with no matching book
is not drawn, so the same rail reads as a codebase's rail on a codebase and a
household rail on a household project. The eyebrow is suppressed where the
rail turns into a horizontal scroller — a stacked heading has no row to head.

**Questions with an attached document.** When a pending question carries a
document — a night-shift report, a draft plan — the document is not a
ten-line teaser stacked above the answer keys. `PendingQuestionCard` lifts
it into its own right-hand column (`.pending-question-split*` in
[styles/project-surfaces.css](../packages/ui/src/styles/project-surfaces.css)):
the card and its actions on
the left, the whole document as a portrait page on the right, scrolling in
place. `.pending-question-splitwrap` is a named `question-card` query
container, so the same card falls back to one column in a narrow chat
bubble and the panel keeps its own scroll there. Two rules travel with the
pattern: the document's own `#`/`##` headings are pulled back to panel
scale (a report title must not out-shout the question it belongs to), and
an *answered* card — which collapses to one line — stays single-column,
because a full-height panel beside one sentence reads as broken.

**A question drawer answers, so the answer keys stay on screen.** The Updates
drawer hangs from the header and stops short of the window's bottom edge; what
it holds is a control surface, not a page. When the question is longer than the
room available, the *body* is what gives — it shrinks and scrolls inside itself
while the task strip, answer keys, note field, and Submit row keep their size
(`.app-questions-overlay` in
[styles/app-shell.css](../packages/ui/src/styles/app-shell.css) is a flex
column with `min-height: 0` down every level to the body). A long question that
pushes Submit under the bottom edge reads as a broken dialog, not as a
scrollable one, because nothing on screen says there is more below. The
drawer's own scrollbar remains as the fallback for a very short window.

**One submit key per composer, and it is a glyph.** Chat's Send and the
terminal's Fire are the same act — *this draft goes now* — so they share one
recipe (`.chat-send-btn` / `.terminal-fire-btn` in
[styles/shared-content.css](../packages/ui/src/styles/shared-content.css)): the
terracotta bevel, near-square, carrying the up-arrow `SubmitArrow` primitive
instead of a word. Two words that mean the same thing drift apart; one mark
does not. They also sit in the same place — their own row between the context
strip and the typing surface — so flipping compose mode never moves the primary
key out from under the cursor. Being glyph-only, each carries `title` and
`aria-label`, and Send's label (not a hidden `aria-busy` alone) is what
announces the pending turn now that "Sending…" is no longer on its face.

**The draft can take the window.** An icon key immediately left of Send
toggles the composer between its three-line strip and the top ~80% of the
chat column, because a brief or a PRD is unreadable through a slot and
scrolling it inside the slot loses the shape of the thing being written.
It is a size change, not a mode: the To line, the toolbar, and every key
stay exactly where they were, the transcript keeps the remaining fifth
rather than disappearing, and the draft, its attachments, and its autosave
are untouched by the flip — so the toggle is never a decision, only a
preference for the next minute. Expanded, the editor *fills* its frame
instead of growing with the text; an empty box that filled as you typed
would put the caret somewhere different on every keystroke. The glyph is
chevrons pushing apart, closing back together once expanded, and carries
`title` + `aria-label` + `aria-pressed` like every other icon key.

**Mid-turn composer actions.** While a gezel is working, the composer keeps
accepting text. With an empty draft the toolbar shows only the quiet
secondary `■ Stop`. The moment there's a draft, two actions join it:
**Nudge** (primary — reuses the Send recipe so terracotta stays on the one
primary) queues the text for delivery when the turn ends, and **Interrupt**
(secondary) stops the turn and sends immediately. Enter mid-turn means
Nudge, Escape means Stop. Queued nudges render in the timeline as the
existing dashed ghost bubbles ("⋯ nudge") with Edit / Discard / Cancel
current turn actions — editing swaps the preview for an inline textarea in
the same dashed not-yet-sent vocabulary and never opens a dialog. A user
message that was delivered from the queue carries a small uppercase
`nudged` badge (`--text-2xs`, `--radius-sm`) after "You". Stop never
discards queued nudges; each ghost keeps its own Discard so the user
decides.

**Only the person's own words are attributed to them.** Task dispatch
seeds, step handoffs, and page reactions travel as `role: 'user'` messages
because that is the role a provider accepts mid-conversation — but the user
never typed them, and a transcript that opens with "YOU · call
`advance_task_step` to hand off" reads as a bug and quietly undoes the
warm-companion framing. Any such turn carries `origin: 'system'`
([`ChatMessage`](../packages/core/src/schemas/gezel.ts)), and every surface
that names an author must honour it: the bubble reads **System** with a
small uppercase `automatic` badge (the neutral sibling of `nudged` — same
`--text-2xs` / `--radius-sm` recipe, `--border` instead of terracotta) and
drops to the panel tone, because the terracotta fill *is* the signal that
words came from the user. The rule travels to every author label, not just
the bubble: the sticky scroll header renders the same verdict, and a new
one must too. Cross-gezel messages are a separate case already answered by
`from` — they keep the "Aldric → Maya" handoff bubble.

**Hand-offs are a card, not a paragraph.** The dispatch seed that opens a
task thread is addressed to the model: it names the sender, the step and the
task ref in its first sentence and then spends four more on tool-calling
procedure ("call `advance_task_step` when the step is done"). Rendered
verbatim that reads as machinery talking, and the sticky header clamped it
mid-word. Any turn
[`parseTaskHandoffNote`](../packages/core/src/task-handoff-note.ts)
recognises renders instead as a small letter card, centred and dashed in the
handoff accent so it reads as a transition between crew members rather than a
message in either column: a kind eyebrow (Hand-off / New task / Next step /
Resumed), **one sentence** — "Liesel passed the review step to Koray." — one
action (the task chip), and the seed itself behind a closed "Full note"
expando. The sticky header carries the same sentence and the same eyebrow.
The rule generalises: when the machinery has to say something to a model in
the transcript, the reader gets the fact and the instructions go to
provenance. Keep the wrapper's `msg-user` class — the timeline pairs a reply
with the turn it answers by that class.

**Accepted work leaves a trace before it speaks.** A task the user just
started can sit on the TaskRunner's queue for minutes while the machine
finishes other turns. During that window the task strip gains a pill reading
"No chat yet" and the transcript below is *unchanged* — so the honest reading
of the screen is "my request was dropped", and the user starts it again. Any
work the daemon has accepted but not yet begun gets a receipt in the final
lane of the transcript
([`QueuedTaskBubble`](../packages/ui/src/components/QueuedTaskBubble.tsx)):
the handoff card's centred dashed shape, at reduced opacity because it
annotates a thing that has not happened, with the state as its eyebrow (In
the queue / Starting / Scheduled / On hold), the task named, and one sentence
saying what it is waiting on. Two rules keep it from lying. It appears only
for work a runtime queue is actually holding — never inferred from "assigned
and idle", because a card promising an imminent start buys a genuinely stuck
task another hour of the user's patience. And it disappears the instant that
task streams a turn: the live bubble is its representation, and a "waiting"
card beside it contradicts what the reader can see. Batches collapse past a
few cards into one counted line rather than burying the conversation.

**Waiting is not wedged, and silence alone cannot tell them apart.** A turn
that has produced no tokens may be parked behind another gezel — Gezel's
provider queue and, separately, the engine's own physical slot, which on a
single-slot launch serialises every session on the machine. Both look
identical from the transcript: no badge, no output. Two rules follow. The
queued state is **re-asserted for the length of the wait** and expires on
freshness ([`queueNoticeIsFresh`](../packages/ui/src/components/chat-live-slot.ts)),
never torn down by whatever unrelated liveness event happens to arrive next
— a heartbeat means the daemon is holding the turn, which is equally true
while it waits, and clearing on it dropped the badge minutes into a wait. And
the silence banner may only say a turn "looks stalled … may have wedged
mid-turn" once it has actually streamed something: *mid*-turn presumes a turn
in progress. With no output the honest copy names the ordinary causes —
waiting behind another gezel, loading the model, reading a long prompt — and
offers waiting as a real option beside stopping. The old copy sent users to
cancel and retry turns that were queued and would have run on their own,
which on a one-slot engine put them back at the end of the same queue.

**A craftbook run gets a receipt card, not just a pill.** When a tool call
starts a craftbook (`invoke_craftbook`) or moves a task a step
(`advance_task_step`), the transcript renders an inline card under the tool
row ([`ToolCraftbookCard`](../packages/ui/src/components/ToolCraftbookCard.tsx),
`msg-tool-card-*` block in [styles/chat.css](../packages/ui/src/styles/chat.css)):
the craftbook's workshop-mark artwork in a small `--radius-md` tile, an
uppercase eyebrow (Craftbook started / Step complete), **one sentence**, the
compact step tracker, and the task chip. The generic pill row stays — it is
the factual record with duration and provenance — and on completed bubbles
the card is promoted above the collapsed "N steps" disclosure exactly like
generated media, while the plain row stays inside the collapse. Two rules
keep the card honest. Everything on it is a **snapshot of the moment the
tool returned** (the service stamps the step statuses into the event) — it
never pretends to be live, and the task chip opens the live view: the chat
rail's Task pane where the surface has one, the full task tab otherwise.
And the one live element, the External-services nudge on start cards
("works better with External services — it still runs without it"), reflects
the *current* security policy: it hides the moment the capability is on,
and its action **deep-links to Settings → Security & Compliance** — a
security switch is never flipped from inside chat.

**Machine syntax never reaches a summary line.** A message body is not
prose. It is markdown; it may carry reasoning the bubble hides; and when the
salvage layer fails to promote a call it is literal tool-call markup.
Rendered straight into a one-line summary, that produced a hand-off card
reading `Sumarni, Si… · <toolcall <function=search…` — angle-bracket
protocol syntax in a headline, and the sharpest break of plain shop talk on
the surface. Every glanceable line built from a message body goes through
[`humanMessagePreview`](../packages/ui/src/components/message-preview.ts),
which keeps prose when there is any and otherwise **translates rather than
hides**: a tool call becomes "Searching across files…", hidden reasoning
becomes "Thinking…". Translation is the point — scrubbing to an empty line
is just as clean and tells the reader nothing about a thread that did, in
fact, do something. Reach for
[`toolActivityPhrase`](../packages/ui/src/components/tool-display.ts)
wherever a tool has to stand in for a message: a chat row may *label* a tool
("Search across files") because a timestamp and an avatar frame it, but a
summary line has no such frame and reads the same label as an instruction to
the reader. And while a turn is open, the running tool outranks the stored
preview — mid-turn that text is still the message which *started* the turn,
so a pill reading "Working" beside the user's own question answers nothing
they are waiting on. All of this is display-only: the stored transcript
keeps what the model actually emitted, so the model can still see its own
mistake.

**Transformation dialog.** AI edits to user text never land silently. The
editor toolbar's single transform button opens the transformation dialog
(`TransformDialog`, `gz-transform-*` block in
[styles/catalog-and-primitives.css](../packages/ui/src/styles/catalog-and-primitives.css)):
an instruction
field, a "Transform with {Klerk}" row that shows the Klerk's poppetje
pulsing plus a quiet live metacommentary feed while the model works, and a
result area toggling (bare key tray) between an editable Before/After view
and a Monaco diff. Nothing touches the document until the user presses
Apply; Cancel/Escape discards everything. With no selection the dialog is
in insert mode — the instruction becomes required and the result is added
at the cursor. This is the pattern for any future "AI proposes, user
disposes" text surface: preview + explicit commit, never in-place mutation.

**Catalog artwork: Workshop Marks.** Craftbook thumbnails are quiet square
still-lifes drawn from a circa-1905–1915 bindery and small-letterpress material
language: laid rag paper, woven bookcloth, lightly printed charcoal ink, and
dull oxidized brass. They use the Gezel parchment/charcoal palette with one
muted category accent, one dominant job-specific artifact, and at most one or
two supporting tools. The historical cue stays in material and construction,
not decoration: no sepia wash, distress, wax seals, ornate flourishes,
steampunk, medieval props, or nostalgic clutter. Source art is 512×512 WebP
and must remain recognizable in the 44px gallery crop. Catalog image renderers
must replace missing or failed assets with the surface's category glyph or
initial; never expose the browser's native broken-image placeholder.

**Embedded Handboek pages.** When a surface needs explanatory copy that
also belongs in the documentation, don't hardcode the prose — embed the
Handboek article (`LinearDocView`/`DocPlayer` + `createHandboekMediaProvider`,
with the shared `GEZEL_LIGHT_SURFACE` overlay in light mode) so the pitch and
the docs never drift. The Home "What is gezel?" embed
(`IntroHandboekArticle`) is the reference implementation: a cream page
resting on the card, a Read/Watch key tray, and an "Open in Handboek →"
link that lands on the same article.

**Loading states.** Prefer inline `muted` text ("loading models…",
"generating…") over blocking spinners. A pulsing icon (see
`.gezel-icon--pulse`) is the canonical "this thing is working in the
background" signal. When a surface needs to tell two working *phases* apart,
it may use a small themed glyph per phase — a quiet 16px figure on the
muted ink with a single moving accent stroke, animation stilled under
reduced motion. The index popover's phase spinners
(`.project-index-phase-spinner`: a ledger page with a sweeping read-line
for the file scan, a quill writing a line for the AI tiers) are the
reference; don't reach for a generic rotating ring.

**A pane that is swapped, not entered, holds its shape.** Switching projects
remounts the whole chat pane, and for the round-trip it takes to fetch the
roster the pane knows nothing — including whether the project has a crew at
all. Rendering the real empty state there flashes a false claim on every
switch. Render a wordless structural stand-in instead
(`ProjectChatPlaceholder` / `.project-chat-placeholder-*` in
[styles/chat.css](../packages/ui/src/styles/chat.css)): reuse the hydrated
surface's own classes so the frame, the metrics, and the palette are
literally the same, and let the content fill in underneath. No shimmer and no
spinner — the wait is under a second, and a pulse is louder than the flash it
replaces. An empty state is an *answer*; show it only once the surface has
one. Screen readers get the truth through `aria-busy` plus one `sr-only`
line, not through the decorative frame. A project switch does this twice, at
two depths: the pane holds the tab strip's place while the project detail is
fetched (`ProjectPanePlaceholder`), then the chat pane holds the composer
frame's while the roster is. Reserve a neighbour's height by rendering that
neighbour's own element hidden — `visibility`, so it still lays out — rather
than by writing down a pixel figure that the rule it copies is free to
change.

**A search box answers the keystroke, not the query.** The results surface
mounts as soon as there is something to search for — never on the response —
because a panel that only appears once data arrives has no way to say
"working", and the box reads as broken for however long the backend takes.
The titlebar search is the reference: it opens on the debounced query showing
*Searching…*, fills with the instant name matches, then keeps a quiet
`.search-palette-more` line while the slower content fan-out completes. Two
rules travel with it. **Fast and slow sources are separate phases** — the
name catalog answers in milliseconds while content search waits on the
embedding pipeline, and making the user wait for the slow half to see the
fast half is what produced a 41-second silent box. And **"No results" is a
claim about the user's data**, so a lookup that *failed* must say that
instead; the two are different answers and only one of them means "stop
looking".

**The theme reaches everything on screen, including what we don't style.**
A project-type Output page renders in a null-origin sandboxed iframe, so our
CSS variables never reach it, and a page that only knows the OS preference
becomes a glaring cream slab down the side of a dark workshop. The desktop
shell therefore pushes the user's Light/Dark/System choice into Chromium's own
preference (`nativeTheme.themeSource`, set from `applyThemePref` in
[theme.ts](../packages/ui/src/theme.ts)), which is the one signal that crosses
the sandbox — a `color-scheme` on the frame element does not, and the
`window.gezel` theme message only reaches pages that opted into the page API.
Embedded content is then themed by honouring `prefers-color-scheme`, which is
the contract documented for page authors in
[project-types.md](project-types.md). The rule generalises: when a surface is
a separate document we cannot style, hand it the preference rather than
assuming it will match by luck.

**Meters name their denominator.** A usage bar is a claim about a physical
pool, so only a figure measured against that pool may fill it. The engine
broker's reservation spans graphics memory *plus* a share of system RAM, and
folding it into the VRAM usage bar once pegged a 32 GiB card at 100% while the
session's model was 5.5 GiB. When the platform can't report use, omit the
physical-use meter and show capacity as text rather than drawing an
unactionable unknown bar or printing a zero. A reservation may have its own
separate meter against the broker budget, but it must say `reserved` (never
`used`), expose the VRAM/RAM capacity split, and visually differ from the
measured-use meter. Name what is holding the reservation underneath. Memory
borrowed for a reclaimable system cache uses alternating cache-color and
empty-pool stripes: it is physically occupied, but remains available when the
operating system needs the capacity. When a discrete-GPU driver exposes only
aggregate use and no process accounting, the remainder must say `Unattributed`
rather than `Other`, with a note that it may include retained Gezel models;
`Other` is only a defensible claim after the Gezel process footprint was
actually observed.
[MachineMemoryStrip](../packages/ui/src/components/MachineMemoryStrip.tsx) is
the reference.

**A standing status number is a ring, not a strip.** A value that is always
present and rarely acted on — the provider quota, how full a thread's context
window is — gets a small **ring meter**: a ~15–22px circular fill, an optional
short label, and the numbers behind a popover on click. It sits inline in the
row it belongs to, never as its own full-width band. A strip claims a whole
band of the frame permanently, and the two the app had spent that band
restating constants: `139K-token context · Automatic compaction around 70%`
told the reader the model's capacity and the runtime's policy, and never once
told them how full the thread actually was. If a strip's copy would be the
same on the first turn and the fiftieth, it is a ring.
Reference implementations: the header's `.quota-meter`
([App.tsx](../packages/ui/src/App.tsx)) and
[ContextMeter](../packages/ui/src/components/ContextMeter.tsx) beside the
thread picker. Rules: the ring itself is a sanctioned true circle, but the
button around it keeps the row's small radius (see
[keys in trays](#controls-keys-in-trays)); the ring is a *dial*, so it never
takes a latched state; a reading the app has not measured shows an empty ring
and the capacity as text rather than an invented zero; and an exceptional
state (a failed compaction, a quota at 95%) recolors the ring and its label
rather than growing back into a banner. What a ring counts must be said in
the popover, because a bare percentage invites the reader to assume it is
global when it is scoped — the context meter names *this thread* in its
label, its tooltip, and its popover.

**A ring earns its popover by holding the lever, not just the numbers.** The
popover a ring opens is the natural home for the one action a reader takes
after looking at it — the context meter's **Compact now**, which runs the
same collapse the runtime performs automatically at the threshold. Without
it, a user watching a thread fill up has no move but to send a throwaway
message and hope the pressure check fires. Two rules: the action's refusals
are *sentences*, rendered where the button is (the thread is mid-turn; there
is nothing older to summarize yet) — never a toast, and never a silent
no-op; and a number the app has not actually measured says so rather than
showing a zero. The context meter's "in use" figure is the transcript tally
until a turn measures the real prompt, and it says `at least` instead of `~`
for exactly as long as that is true.

**An unsent message is a row in the thread picker.** A prompt someone is
still writing is a thing they own, not composer scratch, so it survives a
restart and shows up where they would look for it. A draft addressed to a
thread that does not exist yet is listed **above** the threads under a
`Drafts` label, carrying a small `draft` badge so the difference is visible
before it is committed to; drafts that already belong to a thread live behind
that thread's `Drafts` key rather than crowding the picker. Two rules keep it
honest. The picker's `+ New` still mints a thread and `+ Draft` mints only a
message, because "start a conversation" and "start writing" are different
intentions and collapsing them is what left empty threads behind. And the
composer's save state is the toolbar's quiet autosave status — a dot while
dirty, a word while saving — never a chip and never a banner: a person typing
should not be told that typing is working.

**Identity codes.** When two people must compare a cryptographic value
out loud — device pairing is the only case today — show a short grouped
**identity code** (`.device-code`, the first 16 hex characters in groups
of four) and keep the full value behind a "Show the full fingerprint"
disclosure. Both ends of the comparison must show the *same* form, and the
prompt asks the user to *check that the codes match*, never to "read it
across". Length is a security floor, not a style choice: 16 hex characters
is 64 bits, and a shorter code can be ground out offline by an attacker
who wants a colliding prefix. Full-length values still travel in the API
and are what the code compares —
[RemoteServersPanel](../packages/ui/src/components/RemoteServersPanel.tsx)
is the reference.

**Time is always relative, and the exact stamp lives on hover.** Every
"when did this happen" label goes through the one formatter in
[relative-time.ts](../packages/ui/src/relative-time.ts) —
`formatRelativeTime` for the label, `formatAbsoluteTime` on the `title` of
whatever element carries it. Never hand-roll a scale, and never let a
relative label roll over into a calendar date once it gets old: a surface
that shows "synced 7/24/2026" beside "17d ago" is asking the reader to hold
two calendars at once. The scale runs `just now → 18m ago → 3h ago →
yesterday → 4d ago → 2w ago → 3mo ago → 2y ago`; `{ style: 'long' }` spells
the units out for prose lines and `{ seconds: true }` counts seconds under
the first minute for rows that tick while you watch them (file mtimes,
worker pools). Standalone labels use a `<time>` element with `dateTime` set.

**Sage is chrome; `--success` is an event.** The workshop's green is sage —
`--sage`, `--sage-deep`, `--sage-ink`, `--sage-soft` on `:root` in
[foundation.css](../packages/ui/src/styles/foundation.css). Resting state
that just says "this is fine" takes it: the System Health chips, engine
readiness, "on device", every `.gz-status-pill--ok`. `--success` is the
mint reserved for something that *changed* — a save landed, a diff line was
added — and it is a near-miss of sage, so a resting chip painted with it
reads as an off-token green sitting inches under the sage titlebar. If you
find yourself writing `var(--sage, #somehex)`, pin the primitive
(`--gezel-sage`) instead: a fallback is a token waiting to shift under you.

**Status bars.** Ambient state that describes a whole surface — what branch
it's on, whether the index is fresh, whether gezels may edit — belongs along
the *bottom* edge of that surface, not in a row of chrome above the content.
Separate it with a single hairline `border-top` and no fill: the bar has no
weight of its own, and the controls inside stay ordinary keys so they still
read as pressable. Everything that overlays out of a bottom bar opens upward
— hand-positioned menus anchor with `bottom: calc(100% + …)`, Radix surfaces
take `side="top"` (selects flip on their own). The project status bar
([ProjectGitStatusBar](../packages/ui/src/components/ProjectGitStatusBar.tsx))
is the reference. When a project's active provider is Codex, its access key is
the compact four-state `Plan / Edit / Reviewed / Full` control: this is an
ambient project posture, so changing it belongs here rather than in the chat
composer or a modal.

**Save state is ambient, so it lives in the status bar.** An editor's
saved/unsaved indicator goes in the shell's status bar
([AutosaveStatus](../packages/ui/src/components/AutosaveStatus.tsx) into
Squisq's `statusBarSlotRight`), never in the toolbar beside the actions —
put it up there and a routine autosave reads as loud as the buttons around
it. It takes the bar's own small muted type rather than a colored chip, and
the unsaved state is a bare `--warning` dot with its words in the tooltip
and an `.sr-only` label: a document being typed into is the normal case and
doesn't deserve a sentence. Only the transient "Saving…"/"Saved" pair and
the actionable failure ("Save failed" + Retry, in `--danger`) carry text.

**Terminal output.** Terminal text is spatial, not prose: preserve whitespace
and columns exactly, and contain overflow in a keyboard-focusable viewport with
horizontal and vertical scrolling. Never reflow output to fit a chat bubble.
Live output follows the newest line while the reader is at the bottom; scrolling
up pauses that follow behavior until they return to the tail. The timeline's
lightweight ANSI rendering is the durable transcript view. Full-screen TUIs that
depend on cursor movement or the alternate screen belong in a dedicated live
terminal surface backed by a terminal emulator, not in every historical bubble.
When directory-listing output names a workspace file the service has verified,
render that filename as a subtle inline link into the References previewer;
filename-looking arbitrary output stays plain text. The native `open <path>`
command provides the keyboard-first version of the same action.

**Errors.** Inline, close to the thing that failed, `.error` class. Don't
use toasts for errors. If the operation is dismissable, show the error
until the next user action; if it blocks something, show it until the user
fixes it.

**A red error names both exits.** A persistent red alert never uses an
ambiguous verb such as “Continue” for dismissal. When the user can remove the
alert without fixing its cause, label that action **Acknowledge** and say in
its tooltip what scope it clears. When the failure is genuinely recoverable,
offer a separate, primary **Retry** (or a more specific repair verb) that
actually performs the recovery. Retry is contextual: prefer structured error
classification, with a narrow compatibility fallback for older errors whose
own copy explicitly recommends retrying; deterministic failures and “do not
retry” conditions do not get it. Keep both actions in a distinct row beneath
the explanation, disable them while one is running, and surface a failed
action inline instead of swallowing it. The failed-turn banner and its live
streaming twin are the reference.

**A failed tool says why, in the thread.** A red ✗ on a tool row is a
status, not an explanation, and burying the reason in a tooltip or behind
the collapsed step expando makes a gezel look stuck for no stated cause —
a completion gate would reject the same step six times while the user
watched a counter climb. Every failed row carries a bounded reason under
it, and any failure the turn never recovered from (no later success of the
same tool) is repeated above the expando where a closed disclosure can't
hide it. Bound the text — 250 characters, cut on a word boundary — and
strip what was written for the model, not the reader: the `[code]` prefix
and the `Retryable:` flag. Line breaks survive, because a gate lists its
unmet criteria. The exact untruncated text stays one click away in the
details drawer. Failures the model corrected itself stay quiet; a
self-healed turn must not read as a broken one.
[toolErrorSummary](../packages/ui/src/components/tool-display.ts) and
[unresolvedToolFailures](../packages/ui/src/components/chat-bubbles.tsx)
own the two rules.

**Reporting an error.** A clear *system* error may carry a "Report error on
GitHub…" link beside it ([ReportErrorLink](../packages/ui/src/components/ReportErrorLink.tsx)),
and Settings → About carries a permanent one. It opens a dialog holding the
exact text that will be filed — the user's own description, the error, and a
machine profile — which they can edit before "Create issue on GitHub" opens a
pre-filled issue in their browser. The report never contains logs, absolute
paths, or anything identifying;
[error-report.ts](../packages/core/src/error-report.ts) composes the body and
scrubs it in one pass, and is the only place that decides what goes in. Put
the link where the app itself failed — an engine crash, a tab that would not
render, a service that never came up — not next to a validation message the
user can fix themselves, and not on a condition that is simply the offline
case. It is not a new control shape: it reuses `.timeline-session-error-link`
inline in a red banner, `.home-link` on a neutral surface, and the host's own
button class inside an action row.

**Status indicators take you to the thing.** A signal in the nav (the
sidebar's per-project needs-input `?`, failed-turn `!`, working dots) is a
button, and clicking it lands on the exact spot the signal is about — not
just the parent screen. When a signal can also be dismissed, put the
dismissal in that entity's `⋯` menu (e.g. "Clear error indicator"), gated
so the item only appears while there's something to clear.

**Selected navigation tabs join the canvas.** The current destination in
the main sidebar is a raised piece of canvas-colored paper, not a pressed
choice key. Its inner edge bridges across the rail seam into the open canvas,
while its remaining edges keep a quiet border and directional drop shadow.
Mirror the bridge and shadow when the sidebar changes sides, and put
row-level status/actions on the same raised surface. Reserve this treatment
for the one destination currently shown; hover and expand/collapse states
remain flat in the rail.

**Install and update notices.** Conditions about the *installation* rather than
the user's work — the background service did not start, an update could not be
checked or applied — never take a banner on the home screen. They get one muted
line in the navigation rail beneath Settings (`.app-sidebar-notice`) which lands
on Settings → About, where the full explanation lives as a `.settings-notice`
block with the raw diagnostic behind a "Technical details" disclosure. The same
line carries a whole-app update's live lifecycle: accent dot while checking or
downloading (with integer percentage), success dot when current or ready, and
warning only for failure. "Up to date" clears from the rail after a few seconds;
download progress and ready-to-install persist. A failed update *check*, which
is what being offline looks like, skips the rail entirely and appears only in
Settings. Copy rule: never say a capability is "temporarily paused" unless it
genuinely returns on its own; on Windows/Linux say that a ready update installs
after a **complete quit**, because closing the window may only hide Gezel in the
tray. Derivation lives in
[system-notices.ts](../packages/ui/src/system-notices.ts), so the rail and
Settings can never drift apart. The one update outcome that *is* worth
interrupting for — a verified update waiting to install — also stays a banner.

**The titlebar sheds words before it sheds pills.** The status cluster is
open-ended — one engine pill per busy on-device engine, one queue chip per
busy provider — so on a crowded bar something has to give. Never a pill:
each one is a live process the user needs to see, and a squeezed pill is an
unreadable smear rather than a smaller pill. Drop *text* instead, in one
ladder measured for the whole cluster at once so every pill compacts on the
same beat: first the machine name ("This Mac" — every local engine wears it,
so it stops distinguishing anything the moment a second pill appears) and the
queue chip's activity phrase, then the gezel's name in an engine pill. What
survives is what is unique to that pill: the engine, the phase, the model, the
count. Nothing is lost outright — every dropped string stays in the pill's
tooltip and its popover, which is the price of being allowed to drop it. A
named engine ("DwarfStar", "Video") is not a machine name and never goes.
[header-density.ts](../packages/ui/src/components/header-density.ts) owns the
measurement; a plain width media/container query cannot see this, because the
bar overflows from *how much is happening*, not from how narrow the window is.

**Rows that differ only by state need the state named.** When one list holds
items in two states that share a row shape — a queue's running turns above its
waiting ones — the row itself says nothing: same figure, same job, same
duration column. Split the groups with an uppercase eyebrow
(`--text-2xs`, weight 700, `0.06em`, `--text-muted`) naming each state, and draw
it only when both groups are present, since a single-state list is already
answered by the section's own counts. Animation is not the signal: a 24px
pulsing poppetje is too quiet to carry the distinction on its own. Supporting
cues stay on the artwork, not the words — a waiting row's figure sits back to
`opacity: 0.6` while its text keeps full contrast. The QueueMeter's provider
sections are the reference.

**Scheduled work is not a backlog.** A count in the chrome says "there is
something here you are waiting on." Work that is deliberately parked until
a future window — night-shift handoffs sitting on the task queue at
eleven in the morning — is waiting on nothing and asks nothing of the
user, so it never gets a badge, a count, or a chip. Left in one it reads as
a stuck queue, and the user goes looking for the jam that isn't there. Keep
it out of the header entirely (the QueueMeter's `taskHandoffSplit` is the
reference: the runner reports `dispatchable` and `scheduled` separately, and
only the first is counted), give it a muted section in the relevant popover
that leads with *when it runs* rather than how many there are, and let the
feature's own surface — the Night Shift menu — be where it's browsable.
The corollary is a duty: once it's out of the chrome, that surface has to
answer for it all day, not only while the window is open. And when queued
work genuinely *is* stuck, say which of the two it is — a busy engine
resolves itself, an engagement switch set to Off does not.

**Landing cues.** When navigation scrolls a surface to a specific row
rather than the top or bottom of it, flash the row so the jump doesn't read
as the view moving on its own: add `.timeline-focus-flash` (a ~2s ring that
fades, no-motion variant included) and remove it once it settles. Never
leave a permanent highlight behind — the ring is a cue, not a selection.

**Horizontal strips need their own overflow cue.** A row that scrolls
sideways — the chat pill row is the reference — cannot lean on the native
scrollbar: on macOS's default "Automatic" setting Chromium paints an
overlay bar that is invisible exactly when the user needs it, at rest, and
forcing the classic bar costs 8px of height in a band whose height is often
shared with a neighbouring toolbar. Draw the affordance instead:
`.chat-pill-row-bar` is a 4px absolutely-positioned track sitting in the
row's bottom padding, level with its border, rendered only while the
content actually overflows, with a draggable thumb sized to the visible
fraction. Absolute positioning is the point — the band's height must not
depend on how many cards are in it. Vertical scrollers keep the native bar;
this is a horizontal-strip pattern, not a general replacement.

**Figure lists in articles.** A Handboek list whose items lead with a
poppetje — what `::handboek-gezel-roster` expands to — renders as a card
per figure: portrait, name, role, and the role's one-line summary, in an
`auto-fill` grid on the article's own surface tokens
(`--squisq-page-bg-alt`, `--squisq-page-radius`). A row of bare portraits
makes the reader match faces to a name list somewhere else; the nametag
belongs on the figure. The item's *shape* is the CSS hook — squisq's
markdown carries block attributes on headings only, so a macro cannot
class the list it expands into — which means any figure-first article
list gets this treatment, and should.

## Poppetjes: painted wooden crew

Poppetjes are the app's character system, not generic avatars. Their visual
language is small hand-painted, lathe-turned wooden figures: simple faces,
warm asymmetric light, rounded volume, quiet grain below the paint, and stable
silhouettes that survive icon crops. Avoid flat clip-art shading, literal wood
texture, and glossy plastic highlights. The persistence invariants, rendering
stack, application-crop rules, and PNG quality workflow are documented in
[poppetje-rendering.md](poppetje-rendering.md).

## The Village: a codebase as a settlement

The project **Village** tab (`FileMap` in code) draws a folder tree as a
settlement from roughly **1890–1915** — never a modern skyline. Its architecture
should feel compatible with the guild world: gabled cottages, shopfronts and
inns, civic halls with cupolas, brick workshops, rail depots, and
sawtooth-roofed foundries. Avoid glass towers, rooftop HVAC fields, neon, and
contemporary office-campus forms.

The goal is a place you come to **recognize**. Users navigate by "the sawtooth
foundry next to the plaza," so a file's building is its identity, and stability
matters more than novelty.

### One map, a settlement gradient

A repository is not uniformly urban, and neither is its Village. The core —
the files everything imports, near the map's center of mass, tightly packed —
reads city-ish: masonry terraces, parapets, cobbles. The outskirts read
village-ish: cottages, thatch, hedgerows, dirt lanes. The transition is an
amorphous field, not four concentric rings, and not a per-project setting.

Two fields carry it, and **the split between them is a contract**:

- **`settlement`** (`hamlet | village | town | city`) is the **only** input to
  categorical choices — archetype family table, wall and roof material, hedge
  vs picket vs curb, dirt lane vs cobble vs macadam. Thresholds live in
  [urbanity.ts](../packages/service/src/filemap/urbanity.ts) and nowhere else;
  re-deriving them client-side guarantees they drift the first time policy is
  tuned.
- **`urbanity`** (0..1) is a **lerp parameter only** — prop density, vegetation,
  wall hue mix, bay rhythm. Never compare it against a constant.

Urbanity samples the *neighborhood*, never a block's own importance. Importance
already drives `levels`; counting it twice would make every central file
simultaneously tall, civic, and city-registered, and the core would collapse
into an undifferentiated mass.

### Five orthogonal signals

Architecture carries real code meaning rather than acting as random decoration.
Keep these separate:

| field | question | renders as |
|---|---|---|
| `health.zone` | what does this file **do**? | archetype family |
| `levels` | how important is this **file**? | storeys |
| `landmark` | which few files are the **skyline**? | guildhall / town hall |
| `health.vibe` | how well **kept** is it? | trees vs weeds |
| `urbanity` | what kind of **place** is it in? | ground, materials, surroundings |

Symbol count becomes facade bays and dormers; churn may add workshop stacks;
test files read as schoolhouses in every register.

### What a file is for comes first

Before zone and register, a file's **use** decides what kind of place it gets
(`fileUseOf` in core, path-based so both renderers and every payload agree):

- **data** (JSON, YAML, CSV, XML that hold content) is a **field**: the parcel
  under crop, furrowed along the ridge axis, a shed in the corner. No walls, no
  roof, and deliberately no language hue — the crop is the signal. Fields are
  weight-capped in the layout so a 40k-line fixture is a big field, not the
  largest thing in town.
- **config** (package.json, tsconfig, `*.config.*`, rc files, workflows,
  Dockerfiles) is a **signal tower**: a squat municipal block under a parapet
  with the glazed control cab on the roof, given at least three storeys so the
  cab clears the roofline. A config file with a couple of symbols is still a
  tower, never a campus.
- **style** (CSS, SCSS, Less) is a **park**: lawn, a gravel cross of paths, a
  flowerbed in the language hue, and a bandstand, fountain, or obelisk by seed,
  with trees at street zoom.

Everything else is code and gets the vocabulary below.

### Vocabulary

A 3×4 grid: four zone families crossed with three urbanity registers, each
family table exactly three entries, index-aligned small → mid → large. So a file
keeps its size-role slot across bands and only changes regional idiom — a
mid-size commercial file is an `inn` in the town and a `hotel` in the city.

Language hue **stays on the roof**. At 2:1 dimetric the top diamond dominates a
building's projected area, so moving hue onto walls in the dense core would kill
the language field exactly where the map carries the most information. Walls
instead mix toward their material (brick, stucco, timber, stone) by however
urban the ground is.

### Stability is the constraint

Variants derive deterministically from the file path through the shared map seed
helpers. Never use `Math.random()` in the renderer. A file keeps the same
recognizable building across frames, reloads, and machines; it changes only when
its code-derived role changes.

That makes the seed stream's *shape* load-bearing, and three rules protect it —
they are documented in full at the top of
[iso/town-style.ts](../packages/ui/src/components/FileMap/iso/town-style.ts) and
pinned by `town-style.golden.test.ts`:

1. Never change the length or order of a family table.
2. The main PRNG stream is append-only.
3. Prefer separately-salted sub-streams (`SEED_SALT`) for anything new.

If the golden test fails, the change moved buildings that already exist on
users' maps. That is the finding — not a stale fixture.

### Streets carry traffic

Streets are the gaps the packer leaves between parcels and folders, so no
street *is* an import. What a street can honestly show is how busy it is, and
the service estimates that per street ([service/filemap/traffic.ts](../packages/service/src/filemap/traffic.ts)):
the import degree of every parcel fronting it, the roads that travel along it
between two sibling boxes of its folder, and the traffic leaving the folders it
bounds. The sum is bucketed into a **road grade** 0..7 on a log scale against
the map's own busiest streets, nudged by the neighborhood band (a hamlet lane
stays dirt, a city lane is at least cobbled) and capped by the settlement, so a
hamlet never grows a trolley line:

| grade | built as |
|---|---|
| 0 | narrow dirt track, grass verges |
| 1 | narrow cobbled lane |
| 2 | narrow paved lane |
| 3 | wide dirt road, wheel ruts, the odd cart |
| 4 | wide paved road with curbs |
| 5 | wide paved street with sidewalks, gas lamps, people |
| 6 | broad paved avenue with sidewalks and street trees |
| 7 | broad avenue with a trolley line: rails, poles, overhead wire, cars |

The right-of-way width is the layout's street **tier** and never changes; the
grade only varies what is built inside it. A narrow dirt track down a 16-unit
boulevard reservation reads as a country road with wide verges, which is what
a boulevard between two sleepy packages is. Same contract as urbanity: the
renderer maps grade to geometry 1:1 in
[traffic.ts](../packages/ui/src/components/FileMap/traffic.ts) and never
re-derives thresholds; both the iso and the plan view read that one struct.

Streets must meet. The packer leaves every folder's inner lanes a pad short
of the parent's trunk, so each street end reaches across to the nearest
perpendicular street within twenty units: to the met carriageway's edge at a
T, and through to its far edge at an L-corner (`joinStreets` in
[traffic.ts](../packages/ui/src/components/FileMap/traffic.ts)). A road that
visibly stops a few units short of the road it turns onto is the single most
artificial thing on the map; never reintroduce one by drawing from the raw
`street.rect`.

Street life — carts and horses, walkers on the sidewalks, trolley cars, and
working smoke over the industrial zone — moves on the frame clock at street
zoom only, honors reduced motion (a still frame at t=0), and stops repainting
when none of it is on screen, exactly like the rooftop fire. The city overview
stays a plain carriageway fill per surface, and the age lens suppresses all of
it.

### The village file is committed, so it must not churn

Placement memory lives in `.gezel/village.json` — anchors, user overrides, and
the journal that can rebuild the whole settlement after index loss. Users are
asked to commit it, which makes one property non-negotiable: **a rebuild that
changes nothing must produce no diff.**

Timestamps are the natural enemy of that. The file therefore records a timestamp
only where the app reads one back — a block's first placement (the age lens) and
its removal (tombstone pruning). Both change only when a file is genuinely added
or deleted, which is a real change and belongs in the diff. There is deliberately
no `updatedAt`, no `seededAt`, and no `recordedAt`; derived geometry (streets,
plates, plazas) carries no timestamp at all. Don't add one back "for debugging" —
it puts a dirty working tree in front of every user on every indexer tick.

The same reasoning is why the urbanity field's parameters are sticky rather than
recomputed (see [urbanity.ts](../packages/service/src/filemap/urbanity.ts)).

### Zoom-tier budget

- **City** stays quiet: flat batched diamonds and landmark beacons. No lots, no
  hedges, no trim, no materials — a 20k-block map has to hold frame rate.
- **District** is the roof-silhouette tier: all thirteen roof forms, secondary
  massing, lot boundaries, road grades as fills (carriageway, sidewalks, a
  single track line), and **cornices and string
  courses** — two 1px lines are most of what makes a core read as masonry at the
  zoom where windows would be sub-pixel mush.
- **Street** gets everything: windows, shopfronts, cart doors, porticos, roof
  furniture, yard decor, street furniture and moving traffic, plaza fountains
  and park trees.

Anything drawing taller than an ordinary roof — a clock tower, a kiln cone —
must declare `roofFactor`. Culling, hit-testing, and the issue-marker anchor all
budget against it, and exceeding it causes pop-in on scroll and dead clicks over
a building's own silhouette.

The **flat top-down renderer reads the same `TownStyle`** and expresses it as
roof *plan* rather than silhouette. Any new visual must be expressible as a
field on that struct, never as renderer-local logic, or the two views drift
apart again.

The age lens overrides all of it — material, massing, trim, facade, and lot
treatment are suppressed so one clean surface per file keeps the recency signal
legible.

Files with indexed findings carry a small deterministic rooftop fire and smoke
marker at district and street zoom. Finding count increases the plume and the
highest severity sets its intensity. At close zoom the fire may grow modestly,
flicker, and produce a clearly billowing plume, but it must respect reduced
motion and stop repainting when no affected building is visible. Keep the city
overview and age lens quiet so those views continue to tell one clear story.

Opening an affected file places a compact findings tray between its metadata
and code. Each finding names the issue, severity, scanner rule, evidence, and
source location; selecting it reveals and highlights the impacted line. “Mark
resolved” closes the finding immediately. “Ask a developer gezel” creates a
tracked terminal task and keeps the finding visibly in progress until that task
finishes. The rooftop fire reflects open and in-progress findings only, so it
goes out when the last one is resolved and relights if a later scan finds a true
regression.

Below the findings tray, a reviewed file carries a **Boekwachter review card**
on the same tray recipe but a neutral surface: the 1–10 health score with its
one-line reason, the reviewer's cliffs notes as read-only markdown prose, and
durable issue rows identified by a short project-scoped reference (`BW-12`).
Selecting a current line reveals it in the source; after the file changes, the
old location is explicitly labelled **Previously line N** and **Needs recheck**
instead of pretending it is still exact. Rows support read/unread, dismiss as
not an issue, resolve, and reopen. With project editing enabled, **Fix** opens a
confirmation dialog and creates an assigned terminal task; the row stays in
progress and links to that task until completion resolves it. Review severities
(info / minor / major) are a deliberately separate vocabulary from security
severities and never borrow their colors or badge treatment. The card closes on
a one-line reminder that these are leads from a background model pass — an
opinion, not a verdict — and a muted provenance footer naming the model, gezel,
and date. A file the boekwachter hasn't reached yet gets one muted "not reviewed
yet" line, no spinner.

Past street zoom, miniature symbol buildings may gain compact floating tags.
These use small-radius plates with short rooftop leaders, prioritize functions
and methods when labels collide, and appear progressively as each building gets
large enough on screen. Keep the ordinary street view unlabeled and preserve
hover details as the fallback for tags suppressed by density.

## Social preview cards

Every published Handboek page carries a 1200×630 Open Graph card, rendered at
export time by [og-image.ts](../packages/service/src/handboek/og-image.ts). It
is the first thing anyone sees of gezel when a docs link is shared, and it is
seen at thumbnail size in someone else's feed — so it is a poster, not a page.

The recipe is fixed on purpose, and there is only one:

- **A kicker and a headline. Nothing else.** A thin title band carries
  `gezel · <area>` (release notes add their version) with the terracotta accent
  bar; the rest of the canvas is the headline, set in Playfair at whatever size
  fills it. No body text, no logo lockup, no decoration.
- **Under 80 characters.** Past that the type has to shrink out of poster
  scale and the card stops working at the size it is actually read. Aim for
  30–50.
- **The site palette, flat.** Parchment `#eae5d6`, ink `#1c1c1c`, terracotta
  `#b0724c` — the same tokens as the Handboek page it previews, so the card and
  the page it opens are visibly the same thing.
- **No texture layers.** Squisq's built-in themes add a `noise` background;
  noise is random pixel data across the whole canvas, and it tripled the encoded
  PNG (736KB against 213KB) for something invisible at preview size.

A dashboard mosaic is the opposite of all of this and is not an option here,
even though the renderer underneath is the dashboard renderer. If a card needs
more than one idea on it, the headline is wrong, not the layout.

## When in doubt

If a new piece of UI is hard to build within these constraints, the answer
is usually that either (a) the primitives layer is missing something and
should grow, or (b) the design is fighting the app's grain and should be
rethought. **Don't work around the primitives layer.** Extending it pays
off everywhere; working around it erodes the consistency we're building
toward.

## Future work (not yet)

These are known gaps; the branding pass will fill them in:

- No icon system beyond the abstract gezel SVGs. Toolbar glyphs are mostly
  text or emoji (to be replaced).
- No empty-state illustrations. Today we use `placeholder` prose.
- No motion system beyond the basic fade/settle. More deliberate
  micro-animations will come once the visual identity is set.

Don't invent these ahead of the branding pass — they're better decided
together.
