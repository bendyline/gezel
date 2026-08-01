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

- **Color** lives in [packages/ui/src/styles.css](../packages/ui/src/styles.css).
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
  square; never capsule-shaped. Fully-rounded (`999px` / `50%`) is reserved
  for true circles: dots, avatars, scrollbar thumbs, and switch knobs.
  There are no pill buttons — a capsule-shaped control is a bug, not a
  variant.
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

Implementation lives in exactly two places, both in
[styles.css](../packages/ui/src/styles.css):

- **Tokens** in `:root` and the three theme-override blocks:
  `--tray-bg/-border/-shadow`, `--key-bg/-bg-hover/-border/-shadow`, and
  `--key-pressed-bg/-border/-ink/-shadow`.
- **The "Keys in trays" block at the end of the file** — the single CSS
  recipe. `.gz-tray` is the group; `.gz-key` is the option
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
  danger-red (emergency stop), the security posture latches sealed-green
  on Super Lockdown and open-amber on Unrestricted. Middle options keep
  the accent; never give every key its own color.
- **Native `<input type="radio">` stays native** in dense config forms
  (folder scopes, engine settings) — the round dot is a true circle and
  keeps its shape. Reach for keys when the choice is prominent enough to
  deserve a control with physical presence.
- **Legacy aliases:** `.provider-pill`, `.gz-type-chip`,
  `.pending-question-choice`, and `.catalog-category` (plus their wrappers)
  are aliased into the recipe pending markup migration. When touching one of
  those surfaces, move it to the `gz-*` classes and delete its alias.
- **No new fully-rounded controls.** If you're reaching for
  `border-radius: 999px` on anything with a text label, it should almost
  certainly be a key or a small-radius chip instead.

## Typography

Two typefaces, both bundled as woff2 (see
[assets/fonts/fonts.css](../packages/ui/src/assets/fonts/fonts.css)) — no
web-font CDN, no runtime fetch. They are exposed as CSS variables in
[styles.css](../packages/ui/src/styles.css) `:root` and you should always
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
[styles.css](../packages/ui/src/styles.css) is the canonical application —
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
| Design tokens (colors, space, etc.) | [styles.css](../packages/ui/src/styles.css) `:root`       |
| Overlay, dialog, tabs, select CSS   | [styles.css](../packages/ui/src/styles.css) `gz-*` blocks |
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
Ollama, engagement modes, tempo), use **keys in a tray** — see
[Controls: keys in trays](#controls-keys-in-trays). The Home + Settings
provider switches are this pattern.

**Split buttons.** Use a split button when one creation action is the clear,
frequent default and two or three closely-related variants should remain
available without crowding the toolbar. The wide left key performs the default
immediately; the narrow attached right key opens a `DropdownMenu`. Join the
halves on one straight seam and keep `--radius-md` only on the outside corners.
Menu items should name the variant and may carry one short hint line. The Tasks
screen's New task / scheduled / Night Shift control is the reference.

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
layout: header with title + search, a category rail on the left, a card
gallery in the middle, and a right-hand pane holding the selection's hero
+ properties form + footer actions. The CSS skeleton is the `gz-npd-*`
block in [styles.css](../packages/ui/src/styles.css) (named for the New
Project dialog, its first tenant); New Task reuses it with a `gz-ntd`
modifier for task-only pieces. New gallery surfaces should reuse the
skeleton the same way — extend it rather than fork it. Lead the gallery
with the curated, context-relevant subset (e.g. craftbooks recommended
for the project's type) and keep the full catalog one rail-click away.

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
background" signal.

**Status bars.** Ambient state that describes a whole surface — what branch
it's on, whether the index is fresh, whether gezels may edit — belongs along
the *bottom* edge of that surface, not in a row of chrome above the content.
Separate it with a single hairline `border-top` and no fill: the bar has no
weight of its own, and the controls inside stay ordinary keys so they still
read as pressable. Everything that overlays out of a bottom bar opens upward
— hand-positioned menus anchor with `bottom: calc(100% + …)`, Radix surfaces
take `side="top"` (selects flip on their own). The project status bar
([ProjectGitStatusBar](../packages/ui/src/components/ProjectGitStatusBar.tsx))
is the reference.

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

**Reporting an error.** A clear *system* error may carry a "Report error on
GitHub…" link beside it ([ReportErrorLink](../packages/ui/src/components/ReportErrorLink.tsx)),
and Settings → About carries a permanent one. It opens a dialog holding the
exact text that will be filed — the user's own description, the error, and a
machine profile — which they can edit before "Create issue on GitHub" opens a
pre-filled issue in their browser. The report never contains logs, absolute
paths, or anything identifying;
[error-report.ts](../packages/ui/src/error-report.ts) composes the body and
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

**Install-health notices.** Conditions about the *installation* rather than
the user's work — the background service did not start, an update could not
be checked or applied — never take a banner on the home screen. They are not
urgent, and none of them is fixable from where the user is standing. They get
one muted line in the navigation rail beneath Settings (`.app-sidebar-notice`:
a small `--warning` dot, muted text, no pulse) which lands on Settings → About,
where the full explanation lives as a `.settings-notice` block with the raw
diagnostic behind a "Technical details" disclosure. A condition that is purely
informational — a failed update *check*, which is what being offline looks like
— skips the rail entirely and appears only in Settings. Copy rule: never say a
capability is "temporarily paused" unless it genuinely returns on its own; say
what is off, and what the user would have to do. Derivation lives in
[system-notices.ts](../packages/ui/src/system-notices.ts), so the rail and
Settings can never drift apart. The one update outcome that *is* worth
interrupting for — a verified update waiting to install — stays a banner.

**Landing cues.** When navigation scrolls a surface to a specific row
rather than the top or bottom of it, flash the row so the jump doesn't read
as the view moving on its own: add `.timeline-focus-flash` (a ~2s ring that
fades, no-motion variant included) and remove it once it settles. Never
leave a permanent highlight behind — the ring is a cue, not a selection.

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
  massing, lot boundaries, urbanity street surfaces, and **cornices and string
  courses** — two 1px lines are most of what makes a core read as masonry at the
  zoom where windows would be sub-pixel mush.
- **Street** gets everything: windows, shopfronts, cart doors, porticos, roof
  furniture, yard decor.

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

Past street zoom, miniature symbol buildings may gain compact floating tags.
These use small-radius plates with short rooftop leaders, prioritize functions
and methods when labels collide, and appear progressively as each building gets
large enough on screen. Keep the ordinary street view unlabeled and preserve
hover details as the fallback for tags suppressed by density.

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
