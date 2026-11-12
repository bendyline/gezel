# Gezel UX

For HTML pages shipped by project types, also read the
[app page style guide](handboek/technical/gezel-app-page-style-guide.md). It
documents the injected font defaults and the CSS each sandboxed page must own;
the shell's variables and classes do not automatically cross into those pages.

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
3. **Historic** — Gezel is a guild. The vocabulary (gezel, meester) is Dutch
   apprenticeship terminology; the visuals should echo the world those words
   come from. A guild hall, an apprentice's bench, a master's ledger — not a
   SaaS dashboard.

   **Gezel is the product, and Gezel is who does the work.** "gezel",
   "gezels" and "gezellen" are not words for a helper in anything a person
   reads: the app, Help's articles, command-line help and package
   READMEs. With most models one generalist carries a job from start to
   finish, so copy must not promise or presume a team. Three rules:

   - **A general statement names Gezel.** What may happen, what did happen,
     what is known: "Let Gezel run scripts it writes", "Gezel isn't allowed to
     write there", "What Gezel has learned about you". Gezel takes "it".
   - **A particular helper goes by name**, with the role where it helps:
     "Anna is making your document". When no name is known yet, say Gezel.
   - **"Crew" is the roster, and only the roster.** The Crew area, a
     project's crew list and pickers that list people say **Crew**, **your
     crew** and **crew member** ("+ New crew member", "Add crew member").
     Outside those places, rephrase instead of reaching for the noun: "Ask
     someone on the crew", "No one is available to take this on".

   Technical names keep `gezel` and `gezels` — the `gezels/` folder,
   `gezel.md`, routes, ids, API and tool names — and so does text written
   only for a model. `styles/owner-vocabulary.test.ts` reports either word
   used for a helper in interface text.

   **The place has no name of its own, and the manual is Help.** Neither
   "workshop" nor "workbench" is a word the interface leans on: nothing a
   person reads names the whole app that way, and no area, group or key is
   called either. Say Gezel ("Opening Gezel…", "when Gezel is ready"), or say
   what is there ("Already on your crew"). The built-in documentation is
   **Help** wherever a person or a model reads it: the Home tab, "Open in
   Help", the Knowledge catalog "Gezel Help", the gezel.com pages. Code keeps
   its first name (`handboek` in folders, routes, macros, ids and the
   `gezel handboek` command), the way it keeps `voorman`.

   **Roles are plain English; the Meester is the one Dutch title.** A
   newcomer met a crew of Voormannen and Ceremoniemeesters and could not tell
   who did what. Whatever a person or a model reads names the role plainly:

   | Internal key (code, config, ids) | Shown as |
   | --- | --- |
   | `voorman` | Crew Lead (prose: crew lead) |
   | `boekwachter` | Librarian |
   | `klerk` | Scribe |
   | `keurmeester` | Inspector |
   | `meester` | Meester |

   Catalog roles follow the same rule (Reisleider is a Trip Planner). The
   full table lives in `core/src/roles/plain-names.ts`; route role text
   through `roleForMatching` before any logic, never compare it to a Dutch
   string. Identifiers keep their Dutch keys (`voormanGezelId`,
   `boekwachterGezelId`, `BW-n` issue ids).

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
  Secondary copy uses `--text-muted`, never a fixed gray. Filled action keys
  pair `--action-bg` with `--action-ink`; links use `--accent-text`. These pairs
  preserve normal-text contrast in both themes. The brand sage
  (`--gezel-sage`, #5c6a4a) is deep enough that the titlebar's small cream
  labels clear 4.5:1. The titlebar uses it exactly: the native Windows/Linux
  window controls, the window background and the splash paint that color
  outside the renderer (`BRAND_SAGE` in the Electron main process), so any
  other tone shows as a seam at the controls. At night the bar is the same
  hue, deeper (`--gezel-sage-night`, #38412d, `BRAND_SAGE_NIGHT`): the day
  sage over the night canvas was the brightest thing on a dark screen. Main
  repaints the window controls and background when the theme in effect
  changes, and holds the day sage until the renderer has said which theme
  the person chose, so someone who pinned Light on a dark OS never sees the
  night bar flash. A rule that only wants "sage" uses `--sage-deep`, never
  `--titlebar`, which now differs by theme.

  **One paper, in steps of lightness.** Every `--gezel-paper-*` tone sits on
  the parchment hue (OKLCH h≈88). The reading, workshop and control papers
  carry less color than the chrome around them, so long text sits on a quiet
  cream without a yellow cast, but they are the same hue: they used to lean
  rose (h≈55-70), and a chat bubble or a Help page read pink beside the
  yellow rail. A new paper tone is a lightness step on that hue, with chroma
  between 0.010 and 0.032.

  **One treatment for "selected".** The current item in any list or
  navigation is a wash of the accent over whatever paper the list sits on:
  `--selected-bg`, `--selected-bg-hover` when the pointer is over it, and
  `--hover-bg` (a breath of ink, never a color) for a row that is not
  selected. This holds for the task, plan and history lists, crew rows, file
  trees, the Settings list, menus' checked items, an editor toolbar's
  pressed toggle and every other "you are here". A selected row was sage in
  Tasks, History and Plans, tan in Crew and the rail, blue in the chat rail,
  gray in the GitHub lists and cyan in the terminal's folder tree. Three
  other patterns look pressed and are not this one, so they keep their own
  faces: a **latched key in a tray** (a choice you made: the accent fill,
  see "Controls: keys in trays"), the **active tab of a pane** (it takes its
  pane's paper, so tab and content read as one sheet) and the **active row
  of the navigation rail** (a tab bridged into the content beside it).
  `styles/visual-system.test.ts` reports a selected-row rule that paints
  any other background.

  **Three status colors, each always beside its word.** Needs you is ochre
  (`--status-attention`, which is `--warning`), Working is the accent
  (`--status-working`) and Ready is sage (`--status-ready`). Trouble is
  `--danger`, and nothing else is a status color: work that is only waiting,
  scheduled or canceled carries no hue. The Activity panel's zones, a task's
  dot, badge and status keys, the chat rail's task chips and a project's
  active dot all draw from these three; a surface that tints a zone mixes
  its wash and its edge from the one color (`color-mix`), so both themes
  follow the tokens. A color never stands alone: the dot sits beside
  "Needs you", "Working" or "Ready", or carries the word in its accessible
  name. `--warning` moved from orange to ochre for this: the orange shared
  the accent's hue (OKLCH h≈55 against 52), so a warning dot and an accent
  dot were the same color at two strengths. The Activity panel had nine
  colors of its own (blush, honey and sage, each with a wash and an edge),
  and a task's five states were two greens, a yellow, an ember and a red.
  `--success` stays for genuine transitions (a save landed, a diff line was
  added), never for a resting state.

  **Warm neutrals only.** No blue. A hover, an inset or a neutral badge is a
  wash of the ink (`color-mix(in srgb, var(--text) 5-8%, transparent)`),
  which resolves warm in both themes; the cool `rgba(79, 125, 255, …)`
  washes that marked a few forms and badges are gone.

  **Dark mode is charcoal with a trace of warmth.** The dark blocks in
  foundation.css re-author the `--gezel-paper-*` and `--gezel-ink*`
  primitives as dark grays that lean to the day paper's side (red a point or
  two above blue, never cool): canvas `#171615`, workshop `#1d1c1b`, panel
  `#1f1e1d`, inset `#252423`. The ground has no color of its own, so the
  terracotta accent and the sage bar are the only colors on a dark screen,
  which is the relationship parchment and accent have by day. It was walnut
  until 2026-11-11 (red 7 to 11 above blue), the accent's own hue: under
  cream text and terracotta lines the whole window read brown, and the
  accent had nothing to stand out from. Each tone kept its lightness, so
  trays still sit below the canvas and key faces above the inset, each step
  a few hundredths of OKLCH lightness apart, and text contrast is unchanged.
  Text is the titlebar's cream (`--gezel-cream-ink`), never a neutral white.
  The quieter inks (muted `#a8a49e`) keep the cream's hue at under half its
  color: they are most of the secondary text, and at full warmth read tan on
  gray. Home's dusk tokens derive from the same primitives, so Home and the
  rail share one temperature; the cool gray ramp before walnut put a warm
  Home beside a slate sidebar. What stays warm at night is the accent at
  work: a selected row's wash, the person's own chat bubble, the composer's
  edge, a latched key. A new dark surface is a lightness step on the ramp,
  never a hand-written brown (`night-ground.test.ts` pins the range).

  **Emphasis points the same way in both themes.** Filled actions
  (`--action-bg`) and latched keys (`--key-pressed-bg`) are the day's deep
  terracotta with cream ink at night too, so pressed reads deeper, never
  paler; a pale-peach latch made the selected thing the brightest object on a
  dark screen. The structural `--accent` lifts to `#c0875d` at night for
  rings, dots and accent-colored labels, and its fills carry dark ink. A rule
  that paints cream on any fill other than the action or pressed pair checks
  its dark contrast. Monaco themes and Squisq reading surfaces cannot read CSS
  variables and repeat the panel and inset hexes (`monaco-base.ts`,
  `terminal-monaco-setup.ts`, `transform/surfaces.ts`); the chat reading
  surface repeats the reading papers (`chat-theme.ts`), and the same test
  holds every copy to the tokens. A Squisq reader names its surface in both
  modes through `gezelReadingSurfaceForMode`: the gezellig preset is
  dark-first and brings a walnut page of its own, which a reader that left
  `surface` unset at night painted inside the app (Help, Knowledge, the Home
  article, code blocks in chat). The app pages'
  component kit cannot read them either: its `--action` / `--on-action` pair
  repeats the deep terracotta and cream for primary keys and the demo Send
  (core `page-components.ts`), while its `--accent` lifts for rings and tints.

  **Spend the accent once per view.** One filled primary per view, reserved
  for create or commit. The bare `button` face is that filled primary, so a
  routine action (Refresh, Cancel, Back) takes `.secondary`, or is a link or
  an icon key. Accent ink is for links and the one primary; a placeholder, a
  selected tile or a label that wears the accent reads as a link or a
  warning. The chat composer's placeholder is `--text-muted`, and a selected
  thread tile in the chat strip sits pressed on its own paper with an accent
  edge rather than the full latched fill.
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
  the small radius because it's a link). A radius that nears half the
  element's height is a capsule too: 10px on a 23px chip read as one.

  **One badge family.** A status or kind badge is the `.gz-status-pill`
  capsule at `--text-2xs`, weight 500, in sentence case, in one of a few
  tones: neutral (muted ink on a faint wash), ok (`--sage-ink` on sage), warn,
  info. Kind badges (`.task-badge`: local, bundled, template…) and step
  states (`.step-status-pill`: Entry) use the same recipe. Never give a badge
  its own hue per kind, never uppercase it, and never draw it as an
  outlined rectangle beside capsules. The rubber-stamp "Soon" mark on catalog
  cards (`.gz-npd-card-badge`) is the one deliberate exception, and only for
  something not yet available. Keyword tags (a model card's `agentic`,
  `tools`) are metadata, not status: small-radius chips (`--radius-sm`).
  Sentence case means the text itself reads "Paused", "Crew lead" or
  "Role default", with no `text-transform` on the badge. The chat rail's
  task status, the New Project crew's lead marker, the toolset tile captions
  and the Copilot page's Active badge were all drawn in capitals until
  2026-11-09.
- **Typography** is a two-font system — **Hanken Grotesk** (sans) for all
  UI chrome and **PT Serif** (serif) for the editorial register. Both are
  bundled woff2 (no CDN). The rules and the shared size scale live in
  [Typography](#typography) below; read it before styling any text.
- **Density** is moderate. We're not Linear-tight and not Notion-loose.
  Line-height is comfortable; gaps between related controls are ~0.5rem.
- **Text selection** belongs to content, not application chrome. The shell,
  navigation, settings, and dialogs keep headings, descriptions, labels, and
  control text non-selectable by default. Chat message bodies, document reading
  surfaces, the composer, and text fields remain selectable; controls inside
  those surfaces do not. Chrome stays copyable where people copy from it:
  commands, paths, and identifiers go in `<code>`, and error text carries
  `role="alert"` or `.error`; all three are selectable everywhere except inside
  a control. Other copyable values opt in with `.gz-selectable-text`
  (preformatted output is selectable too).
- **Spelling is American English** everywhere a person reads it: UI
  strings, Help articles, starter prompts, and prompt text a model may
  echo back. *Practice*, *color*, *organize*, *labeled*, *catalog*, *gray*.
  Code that recognizes what a person typed (brief routing, intent matchers)
  keeps accepting British spellings too.
- **No emojis in committed UI** (repeating the rule from CLAUDE.md). The
  ⭐ is the single sanctioned exception, and it means one thing: the main
  crew member of a place. It marks the Meester in the Crew list, and a
  project's main crew member in that project's crew list and beside their
  name in its chats (see "Every project has a main crew member").

## Permission requests

Permission requests use a shield-and-check glyph, the explicit heading
"Permission request", and a service-authored scope summary before the action.
Show the operations, project, full folder, recipients and duration. A project
file-edit grant covers all files and subfolders until revoked in the project's
settings; never present it as a one-file or one-task approval. The primary action
is "Allow project file edits and continue", paired with "Keep current permissions".
Only structured permission requests get these controls. An ordinary question's
choice text never changes access.

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
  they act on: the tracked-issue rows are the reference, where *Mark
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
- **One tray can hold a choice and its actions.** When a view switch has an
  action that belongs with it, put both in one tray instead of a key tray
  plus a stray text link. The tray is a `role="group"` named after its
  subject, the choice keys keep their own inner `role="radiogroup"` (one Tab
  stop, arrows move), and a 1px `--tray-border` divider separates them from
  the action keys so an action never reads as one more choice. The Home
  Help tab's *Read · Watch | Open in Help* is the reference.
- **Native `<input type="radio">` stays native** in dense config forms
  (folder scopes, engine settings) — the round dot is a true circle and
  keeps its shape. Reach for keys when the choice is prominent enough to
  deserve a control with physical presence.
- **Radio keys share one Tab stop.** The selected key is tabbable; arrow keys
  select the next enabled choice and wrap within the group. Home and End select
  the first and last choices. Button-based groups use `onRadioKeyDown` from
  `primitives/radio-keyboard.ts` and set unselected keys to `tabIndex={-1}`.
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
  wedge other content between them. The Security & compliance level
  switch in Settings is the reference implementation. Set
  `gz-tray--described` only when the readout renders: a described tray with
  no readout drops its stem into whatever follows (it did, under the
  generalist-mode switch), and `styles/described-trays.test.ts` fails on
  one.
- **Stacked keys (`.gz-key--stacked`) carry a label and a hint:** the
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

### Crew activity: one tray, read left to right

The titlebar's **Crew activity** menu is the product's most-used dropdown,
so it stays simple: a heading, one line ("How much your crew does on its
own."), and one described tray of four keys ordered from paused to most
independent: **Off → Chat only → Tasks + chat → Proactive**. Each key is the
mode's icon over its label, so the row reads as one story, the crew coming
to the bench. The latched key explains itself in the readout beneath, through
the described-tray stem; Off latches danger-red. Settings shows the same
tray in the same order with the same copy (`engagement-modes.ts`).

These are discrete menu radio choices, not a continuous range. Left and
right arrows walk the tray (Radix menus only move up and down, so the tray
adds them); Enter, Space, or a click commits one mode and leaves the menu
open, so the readout confirms what was just applied. The menu shows the pick
at once and falls back if the save fails. Each unlatched key describes itself
in a tooltip on hover or focus, while the latched key has the readout instead.
The first Escape dismisses a showing tooltip and the next closes the menu.
Chat only and Off can stop a running Night Shift. Night Shift stays below
the tray as its own section, never as a fifth key.

The icon family is the crew at the workbench: one bench that never moves,
with up to three poppetje figures standing behind it in fixed places, the
lead in the middle a little taller. Off leaves the bench empty with the
hammer lying on it; Chat only brings the lead to the bench; Tasks + chat
brings the whole crew; Proactive puts a bullhorn in the lead's hand, calling
the shots. The figures stand for a crew, not a literal count of active
crew members. Three shapes are deliberate. The H-frame legs make it a workbench;
a plain table reads as a desk or a meeting table. The resting hammer has a
flat face and a rounded peen: a symmetric mallet reads as a gavel, and a
hooked claw as an axe. And initiative is the bullhorn, flared and rimmed so it
never reads as a flashlight, held clear of both neighbors by a pistol grip,
with a thin cut between the grip and the fist so the hand holds a handle
instead of fusing into the horn. It is never a
raised hand, which reads as waiting to be called on, and never a raised tool,
which over the crew reads as a threat. Labels and descriptions always explain
the mode; color alone
never does. Reuse `EngagementModeIcon` and the shared mode copy in the
titlebar, menu, and Settings so this vocabulary remains consistent.

### Night Shift: a tile, a badge, and the night as a track

The menu's second section answers "when?" before anything else. A sage night
tile holds the moon (the titlebar key's own look while a shift runs), then
the title with one status line, and a read-only status badge: the night it
next runs (Tonight, Tomorrow, a weekday), Running, Idle, On hold, or Paused.
Everything after the tile shares one left edge; list dots sit in the tile's
column. A thin track draws the window from its start to its end and fills to
now while a scheduled shift runs, so the line never has to spell out "3h 46m
left" twice. A manual shift draws no track: it runs until the queue is
empty, so it promises no end.

The section must say when the shift cannot run. Chat only and Off hold all
task work, so the badge reads Paused, the line says which mode is holding
it, and there is no Start key (a Start that does nothing is worse than none).
All of this wording is decided in one place, `nightShiftSummary` in
[App.tsx](../packages/ui/src/App.tsx); add a state there, not in the markup.
Name times plainly ("Instead of waiting until 10:00 PM", "It starts again
tomorrow at 10:00 PM") and never the machinery ("deferred indexing",
"scheduled window").

### The titlebar: one line of keys

The titlebar is one line of keys on a sage bench, with one well. Twice it
has read as parts from different kits. First it mixed three heights and
three shapes: a capsule search field, flat outlined tags, and borderless
34px squares. Then, at one height, it still showed five styles across seven
controls: a tray of small flat keys, a borderless brand tile, a well with a
keycap inside it, raised pills, and a tray holding a single key. "Sunken"
meant a field, a tray and "you are here" at once. It follows six rules now.

- **Two things, no more: a key and a well.** Everything you press is the
  same raised key. The one sunken thing is the search well, because it is
  the one place you type. The bar is the tray, so nothing on it sits in a
  tray of its own.
- **One height.** Everything on the bar stands `--titlebar-control-h`
  (28px): Back and Forward, the brand, the search well, every status key,
  the quota meter and the icon keys. The header centers one line (`align-items: center`). On
  Windows the whole line drops 1px to sit with the native caption buttons,
  which is done with header padding, never a transform: a transformed
  ancestor would capture the fixed-position header popovers. Never size a bar
  control by its content. A nested badge once made the engine pill taller
  than Activity beside it.
- **Keys are raised; readouts are flat.** Anything you press wears the
  titlebar key recipe in
  [app-shell.css](../packages/ui/src/styles/app-shell.css) ("Titlebar
  keys"), built from the `--titlebar-key-*` tokens in
  [foundation.css](../packages/ui/src/styles/foundation.css). The face is a
  few percent darker than the sage, with a cream top highlight for lift. An
  open or pressed key sinks 1px with an inset shadow, like a latched key.
  Faces go darker, never lighter: a lighter face drops the cream labels below
  4.5:1. Something on the bar that cannot be pressed keeps the silhouette
  but not the lift. A new bar control
  joins the recipe's selector list rather than styling a face of its own.
  The brand is a key too: "gezel" goes Home, and on Home it sits latched,
  the way an open key does.
- **A status key keeps one width.** Activity and the engine key share
  `--titlebar-status-w`, and a crowded bar steps each down to a narrower
  fixed width, never to a width that follows its words. Sized to their
  text, the two grew and shrank with every phase, progress bar and tick of
  the clock, and pushed each other about as they did. So the key says its
  state in few words ("1 needs you", "3 waiting", "Paused"), with the whole
  sentence in its tooltip and accessible name, and what still does not fit
  is cut with an ellipsis. In the engine key the phase gives way first and
  the clock holds its place. One engine on the bar drops its name and its
  health word while it works, since its rim and light already carry them;
  two engines keep their names, or two progress bars could not be told
  apart.
- **The search well is a slot, not a light.** At rest it is a recessed
  `--titlebar-well-*` slot with cream text, a `--radius-md` rectangle (never
  a capsule), and it turns cream only on focus. It is the widest thing on the
  bar, so it must not also be the brightest while nobody is searching. The
  quick-open shortcut sits at its far end as quiet words
  (`.titlebar-search-shortcut`), never a keycap: a box inside the well was
  one more shape on the bar. It shows only while the well is empty. The
  input names the shortcut in `aria-keyshortcuts`, so the words stay
  `aria-hidden`.
- **Icon keys close the cluster.** The crew-activity key, and Output's
  restore key while that pane is maximized, are square keys the bar's
  height (`.app-header-tray` only groups them), just before the window
  controls. The native caption buttons are not ours to restyle: drawing our
  own would lose the Windows 11 Snap Layouts flyout.
- **State shows on the key itself, never in a box inside it.** A warm or
  cooling engine gets an amber rim (`.engine-pill-warning`) and a paused one
  a red rim (`.engine-pill-danger`); the word stays cream and bold. A box
  inside a key is visual noise, and it changes the key's height. Live work
  breathes. While the crew works, the Activity dot lights cream and pulses
  slowly (`.is-working`). When a working gezel is known, Activity shows their
  face, name, and three thinking dots in place of the working count, with
  stacked portraits and `+N` for additional working gezels. A face is not a
  word, so the density ladder never sheds it. Role-only names hide it, the
  way the queue chips do. The
  compact header's 44px keys keep their own lighter face and the corner
  status light; none of this desktop styling applies there.

### Back and forward

Gezel keeps a trail of the views a person visits, the way a browser tab
does: a parent task, then its child task, then the project, then the
project's Chat tab. Back, Forward and the trail itself are one joined key at
the left of the titlebar, ahead of the brand as in a browser
([HistoryKeys.tsx](../packages/ui/src/components/view-history/HistoryKeys.tsx)).

- **Three keys, joined.** Back and Forward are titlebar keys that share
  their inner edges (`.app-header-history`), so the three read as one
  control with no tray around them. A narrow third key with the dropdown
  chevron opens the trail. The arrows are the rail's caret turned to point
  the way they lead; never use `DropdownChevron` for them. A key with
  nowhere to go keeps its place and its face, with a dimmed arrow, so the
  group never changes shape. The
  narrowest bars drop the trail key first. Right-clicking either arrow
  opens the same trail, as in a browser.
- **Keys name where they lead.** The tooltip and accessible name say
  "Back to Invoices · Tasks", never just "Back", plus the shortcut:
  Alt+Left/Right, or ⌘[ / ⌘] on macOS. The mouse's side buttons work too.
  Shortcuts typed into a field belong to the field.
- **The trail reads newest first.** Each item shows the view's own name on
  the first line (a project's or task's title, else the area's label) and
  where inside it on one muted hint line ("Tasks · Draft the invoices"),
  else what kind of thing it is. The current view carries a check.
- **What counts as a view.** A step is a top-level selection, a tab inside a
  view (a project's Chat or Tasks, a gezel's tabs, a Settings section, a
  task's Task or Chat), or one chosen item in a list (a task in Tasks, a
  Knowledge article). Dialogs, scroll position, a run's step panels, a
  multi-selection, and the compact navigation screen are not steps. A view
  correcting itself, such as landing on its first row or leaving a section
  that closed, adds no step. Views report this through `useViewLocation`
  ([ViewHistoryContext.tsx](../packages/ui/src/components/view-history/ViewHistoryContext.tsx));
  a new view with tabs or a list should report its place the same way.
- **Back reopens the place, not just the screen.** Going back to a project
  reopens the tab it was left on, and the task chosen on that tab.
- **One window session.** The trail survives a reload or a service restart
  and ends when the app quits. Deleting something removes it from the trail.
  At most 50 steps are kept.
- **Phones and narrow windows.** The compact bar has no room for the tray.
  The phone's Back closes an open overlay first, then steps back through
  the trail, then opens navigation, and only after that leaves the app.

## Controls: checkbox cards

Keys latch **one** choice. When several options may be picked at once — the
interest areas (`InterestPicker`), the meester's folder question — each
option is a **checkbox card**: a bordered card with a native checkbox, a
label, and an optional muted hint. A whole key turning accent says "this is
the one", which is the wrong message for a set, and a row of latched keys
reads as a wall of orange. The checkbox says "on" by itself.

- **The recipe** is the "Checkbox cards" block in
  [styles/controls-handbook-and-admin.css](../packages/ui/src/styles/controls-handbook-and-admin.css):
  `.gz-check-cards` is the grid, `.gz-check-card` the `<label>`, with
  `.gz-check-card-text` → `.gz-check-card-label` + `.gz-check-card-hint`.
- **Every card in a group is the same size.** The grid fixes the column
  width and `grid-auto-rows: 1fr` gives every row the tallest card's height.
  A surface changes the column width only through `--gz-check-card-min`.
- **Ticked = accent edge plus a faint tint**, never a full accent fill.
  States come from the input through `:has()`, so markup carries no state
  class. The card takes the focus ring; the checkbox's own outline is off.
- **A hint describes, it does not name.** When a card has a hint, point the
  checkbox's `aria-labelledby` at the label and `aria-describedby` at the
  hint, so a screen reader hears "Data and spreadsheets, checkbox" and the
  hint after it rather than both lines as one name.
- **Nothing starts ticked** unless the person ticked it earlier.

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

## Settings pages

A page of settings is something a person scans for one thing, so its shape
has to say where that thing is before they read a word. A project's Settings
tab is the reference implementation, and most app Settings pages use the
same pieces: General, Device integration, Your team, About you, Folders,
Security & compliance, Accounts, Artificial intelligence and its
cloud-provider pages, Night Shift, Web search, Shared toolsets and About. The
engine, image, video and audio, Integrations, Remote servers, Knowledge,
Channels and Benchmarks pages still draw their own panels and move over when
they are next touched.
Before the move, three neighboring pages were drawn three ways: one big
bordered card, half boxed, and unboxed, at two different widths.
The pieces live in
[components/SettingsSection.tsx](../packages/ui/src/components/SettingsSection.tsx)
(`SettingsSection`, `SettingField`, `SettingCheck`). The one CSS recipe is the
"Settings pages" block in
[styles/settings-and-status.css](../packages/ui/src/styles/settings-and-status.css).
Don't restyle a settings page per surface; extend the recipe and this section.

- **The app's Settings list opens on about eight rows.** An owner first sees
  General, About you, Security & compliance, Artificial intelligence, Night
  Shift, Integrations and About. Every other page sits under a heading-only
  **More settings** group: Device integration, Your team, Folders, Accounts,
  the image, video, image-recognition and audio pages, Web search, Knowledge,
  Benchmarks, Channels, Remote servers and Shared toolsets. That group and
  the engine and provider pages under Artificial intelligence start folded,
  open by themselves whenever the open section is inside one (a click, a
  link or Back), and otherwise stay as the person left them until Settings
  closes. The Artificial intelligence header also opens its own page; the
  More settings header only folds and unfolds. The list used to show eighteen
  rows at once, most of them pages an owner sets up once or never opens, so
  finding the few they came for meant reading the whole list. Nothing was
  removed, and a new page goes under More settings unless most people will
  open it.
- **Group by the question a person is asking.** For a project: Crew (who
  works here), About and Mission (what the work is), Memories, Workspace
  (where the files live and what may change them), Access (what reaches
  beyond this project), Preferences (how the work is tailored), History,
  and Archive. Connections and Toolsets have their own tab (see "The
  Connections tab"). One section titled "Settings" that held fifteen
  unrelated controls is what this replaced: the only way to find anything in
  it was to read all of it. A setting sits beside the thing it changes, so
  the Crew Lead picker goes under the crew it picks from, not eight fields
  further down.
- **A section is a heading, one line of description, and an indented
  body.** The serif heading (`--text-xl`) and its muted description sit at
  the page edge, with the section's actions (Add crew member, Add connection) at
  the right of the heading row. The content is indented 1rem beneath them.
  That indent is what says "this belongs to that heading", with no chrome.
  It drops to zero below 520px of container width, where width matters more
  than hierarchy.
- **Sections are parted by space and one hairline, nothing else.** There is
  2.25rem above the hairline and 2rem below it. Inside a body, settings sit
  1.5rem apart and the body owns that rhythm. A child's own vertical margin
  is reset, so no pair of settings drifts further apart than the rest.
- **Never draw a box around a group of settings.** A border says "this is
  one thing". Draw one only around something you act on as a unit: a crew
  member, a suggestion with Enable and Don't suggest, the Librarian card, an
  editor. Never draw one around a list of checkboxes or a whole section. A
  `<fieldset>` here has its border reset, and a component that brings its
  own panel (`ToolsetsEditor`) drops that panel inside a section. Several
  boxed cards together get a field label saying what they are, such as
  "Background work" over the Librarian and night-work cards.
- **Every setting reads label, then control, then hint.** `SettingField`
  sets a semibold `--text-md` label above the control and a muted
  `--text-xs` hint below it, one step down. The field is capped at 48rem, so a text input
  never runs the width of a wide window. Give the control an id
  (`controlId`) so the label names it and the hint describes it. A list of
  options, or a picker that labels itself, becomes a `<fieldset>` named by
  its legend. Wrappers fill the field; pickers and selects keep their own
  width.
- **An on/off setting leads with its checkbox.** `SettingCheck` puts the
  box first, its label beside it, and the hint aligned under the label. The
  label is the checkbox's whole accessible name and the hint its
  description. Never put a heading line above a checkbox whose only
  neighbor is the explanation: the box reads as belonging to the
  paragraph.
- **One heading per section.** An embedded view that brings its own title
  turns it off when it is placed in a section (`HistoryView`
  `showTitle={false}`). A section heading over the view's own copy of the
  same word was the History section's double title.
- **Hints say what changes for the person, in a sentence.** Write "Every
  chat in this project reads it", not "Flows into the system prompt". Leave
  out ids, paths and internal posture names unless the person needs them
  to act. A hint that only repeats its label is cut.
- **The page index lists every section, in page order.** The sticky "On
  this page" rail names each section by its heading. The same capability
  check that hides a section hides its entry. `ProjectsView.test.tsx`
  checks that the rail and the rendered sections agree.
- **The lifecycle action comes last.** Archive (or Restore) is its own
  final section: a heading, what it does, and one key. It never sits
  between ordinary preferences.
- **A whole-section action goes in `actions`.** Reset gezel templates and
  Uninstall sit at the right of their heading row, like Archive.
- **Name sections in sentence case.** The nav and every section heading:
  "Your team", "Security & compliance", "Artificial intelligence". Proper
  names keep their capitals (GitHub Copilot, OpenAI, Anthropic Claude,
  Night Shift).
- **A crew role is one control.** Meester, Scribe, Librarian and Inspector
  are each a label, a picker that names the holder, and a hint
  (`RoleAssignmentField`). Never put a card of the holder above a "Change …
  to" select; the picker already says who it is.
- **Controls keep their own width.** A tray, provider switch or lone key
  placed directly in a field or a section body sits at its natural width;
  only layout wrappers fill. A checkbox-card grid is one field and shares
  the 48rem measure, and inside a section hints and tray readouts use 48rem
  too, so a hint, its field and a readout end at one edge.
- **A described tray in a section is one unit.** Wrap the tray and its
  readout in a plain element so no flex gap or paragraph margin comes
  between them. Inside a section the readout is muted and margin-free.
- **Smaller pieces of the recipe.** `.gz-setting-inline` for a control
  inside a sentence ("Keep sent drafts for [90] days"). `.gz-setting-stack`
  for a wrapper holding several settings; it keeps the body's 1.5rem rhythm.
  `.gz-setting-panel` for a box you act on as a unit (a consent step, a
  new-gezel form). `.gz-setting-more` for an Advanced disclosure at the end
  of a section. `.gz-setting-steps` for numbered setup steps. `SettingField`
  takes `className`; `SettingCheck` takes `aside`, a small decorative figure
  at the row's end.
- **Save messages are sentences.** "Generalist mode is Automatic. On for
  cloud providers…", never "generalist mode ON".
- **Check only what the person uses.** A provider page probes its
  connection on open only when that provider runs something: the default,
  the Night Shift's model, a crew member's own provider, or a stored key
  (`copilotIsInUse`). Otherwise it reads "Not set up" and Test connection
  probes on demand. A failure is one plain sentence that names the fix; the
  provider's own error stays in the tooltip. Any Copilot CLI on the machine
  made Copilot look installed, and an owner on This PC opened the page to
  "copilot provider failed to start: Pending response rejected since
  connection got disposed".
- **Words a person reads are English.** The tempo keys are Relaxed, Steady,
  Brisk and Hectic, each explained as how often check-ins come while a
  project is busy and once it goes quiet. The stored ids (`gezellig`,
  `bedrijvig`, `druk`, `dolle-boel`) do not change; the Meester is the only
  Dutch title on screen.

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
almost never set `font-family` yourself.

**Reports are the exception: one sans throughout.** Reports, plans and notes
are working documents, read for their facts. Gezellig's serif titles and
numerals make a night-shift report read like an essay. Every Squisq surface
that shows one renders with `gezelReportTheme` / `gezelReportThemeForMode`
([chat-theme.ts](../packages/ui/src/components/chat-theme.ts)), which keeps
the chat palette and page rhythm and sets headings and body in Hanken Grotesk.
Those surfaces are the report reader, the Home status and night-review
panels, and the rail's document preview. `RenderedMarkdown` takes
`register="report"` for the same reason: the document a question attaches,
a draft plan, and a step's instructions. Chat, Help and albums keep
the serif. A new surface that shows a report uses the report theme, never
`gezelChatTheme`.

**Editors write in the sans too.** Every Squisq editor's Write view uses
`--font-ui` for headings and body. Without this, Squisq mirrors the
document's theme fonts, and a document with no theme falls back to
`standard`'s serif headings. Spread `GEZEL_WRITE_CANVAS`
([write-canvas.ts](../packages/ui/src/components/SquisqIntegration/write-canvas.ts))
onto every new `EditorShell`. The theme still governs Play, previews and
exports. View → "Editor styling from theme" brings it back for one editor.

The two things to actively watch:

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

**Six sizes, none under 13px.** Text a person reads and the controls they
press share one size; what annotates them is one step down; only a badge or
a count is smaller. Three heading steps sit above. Use the shared `--text-*`
scale, never an ad-hoc `rem`/`px` value:

| Token          | Size             | Use                                              |
| -------------- | ---------------- | ------------------------------------------------ |
| `--text-2xs`   | 0.8125rem (13px) | Badges and counts. Never a sentence              |
| `--text-xs`    | 0.875rem (14px)  | Captions, hints, meta, section labels            |
| `--text-md`    | 0.9375rem (15px) | Body, and every control, row and field           |
| `--text-lg`    | 1.0625rem (17px) | Sub-headings, emphasized body                    |
| `--text-xl`    | 1.25rem (20px)   | Panel & dialog section headings                  |
| `--text-title` | 1.5rem (24px)    | An open entity's title (a task, a plan, a crew member) |

`--text-sm` is the same size as `--text-md`: controls and body are one size,
and the old name stays so rules written with it keep working. Write
`--text-md` in new rules.

The scale before this ran 11.5 / 12.8 / 13.6 / 14.4px: four sizes inside
three pixels, too close to tell apart and all of them small. Three quarters
of the text on Home, Tasks and Settings rendered under 14px, on laptops,
for people who run a business and are often past forty-five. Now no text is
under 13px and on those three screens under a seventh of it is under 14px.

Nothing falls off the scale by default. A bare `<button>`, `<input>` or
`<select>` takes `--text-md` and a bare heading takes a heading step
(`h1` title, `h2` xl, `h3` lg, the rest md) from zero-specificity rules in
foundation.css, where the browser's own 13.33px button and 18.72px `<h3>`
were the sizes that made a panel look "off".

Three things are sized outside the scale, on purpose:

- **Long-form reading surfaces** set their own comfortable reading size:
  chat prose (15px PT Serif, scaled by the person's font setting), the Home
  welcome's lines and Help's articles (16px and up).
- **Glyphs** (carets, close marks, arrows, a prompt sigil) are sized as
  drawings.
- **A count raised on the corner of a key** in the phone header (9-10px in
  a small disc) is a mark, not text; its number is in the key's accessible
  name.

`styles/token-drift.test.ts` counts literal sizes and fails on a jump, and
`styles/visual-system.test.ts` fails on any literal chrome size under the
13px floor.

**Section labels are sentence case.** Small labels over a group (Recent
activity, Tip of the day, Chat thread, Librarian, the composer's To) are
`--text-xs`, weight 600, `--text-muted`, in the case they are written in.
Letter-spaced capitals are kept for three places only: the navigation
rail's group headers, the category headers in the New Task and New Project
rails, and the one dateline that opens Home (`.home-workshop-dateline`).
When nine kinds of label all whispered in capitals, none of them marked a
section, and a long one wrapped to leave one word alone on a line.

**Create keys and their dialogs are sentence case, in the owner's words.**
The area keys read **+ New project**, **+ New task**, **+ New crew member**
and **+ New plan**, and the dialogs they open are titled "New project" and
"New task". "+ New Project" sat beside "+ New gezel" and "+ New craftbook".

**Names and roles are written one way.** A crew member and their role
always render through `PersonLabel`
([components/PersonLabel.tsx](../packages/ui/src/components/PersonLabel.tsx)):

- **Inline**: "Ada Lovelace · Engineer". The name is in the surrounding ink,
  then a middle dot, then the role in `--text-muted`. It never wraps; in a
  tight row the role ellipsizes before the name, and a chat timeline under
  560px drops the dot and role (the role stays in the name's hover text).
- **Stacked**: the name above the role, the role muted and one step smaller
  (set `--person-label-name-size` / `--person-label-role-size`).

Names keep their own case: never uppercase or letter-space a name, speaker
headers included ("You", "System", "Bastien"). Never put parentheses, quotes,
hyphens or arrows around a name or role; there were seven formats before,
from "Bastien -" to "→ Ada Lovelace (Engineer)". Roles are plain English:
pass a stored role through `plainRoleTitle`. With gezel names hidden, the
role-based name already says the role, so leave the role out. A face, where a
surface shows one, leads the label as a `GezelIcon`. A mark that belongs to
the person (the Meester's hat) sits right after the name, before the dot.
Text that names a person outside a label, such as a History summary, uses
the same shape: "Created Taemin · Generalist". `PersonLabel` imports only
React, because the startup screen draws the Meester's caption with it.

**Text fields share one face with selects.** Inputs and textareas take the
zero-specificity recipe in
[styles/primitives.css](../packages/ui/src/styles/primitives.css) ("Text
fields"): `--bg` fill, a 1px `--border`, `--radius-md`, `--text-md`, the
same padding and line height as `.gz-select-trigger`. A surface that styles
its own fields still wins. Disabled is muted ink on the same face, never a
third gray surface. Without it, the craftbook step form showed three field
styles side by side: the browser's white box, a tan select and a gray
disabled field. An editable title (a craftbook's name) reads as the title
it is, in the title face and size, and shows its field on hover and focus.

**Editor chrome is quiet.** Squisq's toolbars and status bars use
`--font-ui` (bound through `--squisq-ux-font` in
[styles/squisq-theme.css](../packages/ui/src/styles/squisq-theme.css)),
and the status bar is a muted footer in the editor's own paper. It used to
wear the titlebar green, which made word counts the heaviest marks on any
page with an editor. A short field (a task's description, a note, a step's
prompt) is a **compact editor**: wrap it in `.gz-compact-editor`. Its
toolbar shows as faint marks until the editor has focus, and the word counts
go (the footer keeps its right slot, such as autosave state). Nothing changes
size on focus, so the page never jumps. `MarkdownField` is always compact.
Sibling editors on one page share one frame and one left edge: the task
view's Description and Notes are each a heading over one bordered editor,
with no card around either.

**Reference implementation:** the `.settings-panel` typography block in
[styles/settings-and-status.css](../packages/ui/src/styles/settings-and-status.css)
is the canonical application —
one scoped block that pins the panel's headings, body, controls, and links
to the rules above so no single tab mixes a dozen font/size combos. New
dialog and panel surfaces should follow the same shape: a small scoped
block, sizes from the scale, `font-family` left to the global default except
where a link needs forcing back to sans.

**Section spacing in Settings.** A section that opens with its own heading
("Installed catalogs", "Styles and fast mode") is a new subject and gets a 2rem
gap above it; notices, errors, and progress boxes stay tight to the section
they belong to. Stacked cards in a flat settings pane sit 2.5rem apart, since
spacing is the only separator once the card chrome is stripped. Both rules
live in [styles/catalog.css](../packages/ui/src/styles/catalog.css);
don't set a section's top margin inline. A page built from
`SettingsSection` takes its spacing from the recipe in
[Settings pages](#settings-pages) instead.

**A model page shows what is on this device; the catalog opens on request.**
The llama.cpp, MLX, Ollama, image, video and audio pages lead with their
installed models under a heading whose right end holds **Add a model…**
(`ModelListHeading`). That key opens `AddModelDialog`
([components/AddModelDialog.tsx](../packages/ui/src/components/AddModelDialog.tsx)):
the catalog, its filter and "Show all models" toggle, and at the left of the
footer the other ways in (a model from Hugging Face or a file, a `.gezmodel`
package), which close it before they open. The pages used to list the whole
catalog under the installed models, so a page opened to check or tune a model
read as a shop. With nothing installed, the section says "No models on this
device yet." under its heading. A download keeps going when the dialog closes:
the page's "Downloading…" section carries it, and a notice from a download
that failed to start shows in the dialog while it is open. DwarfStar keeps
one table of installed and downloadable builds, because its memory guidance
has to be on a row before a download of hundreds of GB starts.

**A media model row says what the model does, in plain words.** A video
model's catalog row reads its size, the clip it makes when asked for
nothing in particular (`1280×704, 5 s`), and what it does beyond words:
"Animates pictures", "Animates pictures only", "With sound". Installed rows
repeat those after the name. Never name the engine (sd.cpp, diffusers) or
the quantization as the reason to pick a model; say what it needs or makes.
A model this install cannot run keeps its row with a disabled Download key
whose title says why ("This model needs a video engine this install doesn't
include."), like a model that is too large. The CPU warning on the Video
generation page appears only when no engine reaches a graphics card; when
the larger models fall back to the processor but the smaller ones run on
the card, a muted line says so instead.

**A picture can become a video from where it appears.** A picture an image
gezel made carries "Make a video" in its chat menu, beside Download, only
when a video gezel is set up and an installed model can animate a picture:
the menu never offers what the next message would turn away. It fills the
composer with the video gezel's mention and the picture and leaves the
words to the person, who says how it should move.

## Foundation

Gezel has one responsive product UX. Window width determines its layout; the
operating system determines available capabilities. A desktop window around
400px wide is the mobile experience, with the same projects, documents, crew,
navigation, and project sections. At 760px and below (also on a touch screen
500px high or shorter, such as a landscape phone), the ordinary navigation
rail becomes the full-width entry surface. Selecting an entity opens the same
view at full width; Navigation returns to the rail. Wider windows restore the
side-by-side arrangement and the user's saved rail side and size. Switching
width or opening navigation must preserve the current view, editor, and draft.
`?layout=mobile` constrains the same app to a phone width for convenient desktop
testing; it never switches to a second application or a different data store.

**One navigation column at a time.** An area that brings its own list beside
its content (Crew, Documents, Tasks, Plans, Scripts, History, Settings,
Help, Knowledge, Benchmarks: `LIST_AREAS` in
[Sidebar.tsx](../packages/ui/src/components/Sidebar.tsx)) folds the wide
rail to its icons on its own. With both open, the content sat between two
lists, about 520px of a 1440px window. Leaving the area restores the rail
the person had. Expanding the rail by hand in such an area pins it open
there (`gezel:nav:sidebar-stay-open`), and collapsing it there hands it back
to the automatic fold. The person's own collapse choice for the rest of the
app is a separate setting that the fold never writes.

**The rail leads with places; the builder's tools fold into More.** The
rail lists Home, Projects, Documents and Crew, then one **More** group
holding Tasks, Plans, Scripts and History (`WORKSHOP_AREAS` in
[Sidebar.tsx](../packages/ui/src/components/Sidebar.tsx); the label is
`NAVIGATION_MORE_LABEL`), then Knowledge and Settings. The group has no
screen of its own, so its title opens and closes it the same as its caret,
and it has no "+" key. It starts closed, opens when one of its areas becomes
the destination, and keeps the person's own choice (`workshop` in
`gezel:nav:groups`, the group's first name). An owner's first hour should
not start in a step editor or an audit log. Folding is not hiding: every
area stays one click away with the checks it had as a plain link, a group
with no available area is not drawn, and the person's interests only set the
default (see the next rule and "Interests order; they never hide"). On the
icon rail the group is one icon. An open group, or one holding the current
area, lists its areas' icons beneath it; pressing the icon of a closed group
expands the rail and opens it.

**The rail sits on the left.** It is under the brand and the back and
forward keys, so navigation reads in one direction: the rail, then an area's
own list (Settings' pages, Help's sections, a project's tabs), then the
content. The right edge is left for what a click opens: a file, a document
pane, a page's contents. The rail was on the right until 2026-11-11, to keep
attention on the content, and Settings and Help then had navigation on both
edges of the window. The side is the person's choice (Settings → General →
Appearance → Sidebar position, `config.sidebarSide`), and a choice outlives a
change of default because the picker writes the side by name; only an
install that never chose follows `DEFAULT_SIDEBAR_SIDE`. Every layout is
built for both sides, and a spec that measures the rail checks both.

The rail's scrollbar is on the rail's right on either side: against the
content with the rail on the left, at the window's edge with it on the
right. It is painted only while the pointer is over the rail and there is
something to scroll. Other scroll areas also show their bar while they hold
focus; the rail does not, because a row keeps focus after it is opened and a
bar that stays painted beside the content reads as a second edge. Its gutter
is always reserved, so rows never move when the bar appears, and that gutter
plus a little padding keeps a selected row about 16px clear of the content.
A selected row never touches the content area.

The config is the one place the side is read from, and everything that
paints the rail follows it: the start screen (the desktop host fills the
side from `config.json`, never from the saved start-screen snapshot), the
live app (the boot-time sync repaints the side every launch, even when
nothing changed), and the Sidebar position keys (they follow the side live).
The snapshot is rewritten only after a launch has painted, so on the first
launch after the default moved it still said `right`: the start screen drew
the rail there, the app kept it, and Settings showed Left.

**One test splits the owner's view from the builder's.** A builder is
someone who picked Software as an interest or turned advanced features on
(`useBuilderView`). That one test sets three defaults, so they can never
disagree:

| Surface | Owner | Builder |
| --- | --- | --- |
| The rail's More group | Starts closed | Starts open |
| Title bar | Activity, "This PC", and a plan's quota only once it is 80% used | Also the Claude CLI worker readout, and quota whenever that plan is running |
| A project's status bar | Drawn only for something to act on: a folder Gezel cannot change, a paused project, search that cannot work, a linked repository | The full bar: index state, status, access |

"This PC" is not part of the split: it stays in the title bar for everyone
whenever a local engine is in use, because it says where the person's work
is running. The split only sets what shows at rest. Nothing is removed: a
project's status is also a field in its Settings (Preferences), indexing
shows in Activity while it runs, and a state the person has to act on shows
in either view. A new project used to open over "Not scanned yet" and
"Active", which told its owner nothing; with nothing to say, the bar is not
drawn at all.

The native shell shares the responsive frame, brand, navigation rows, project
section tabs, character renderer, palette, typography, and controls. Its current
portable runtime supports projects, crews, files, conversations, scripts and
foreground tasks through the shared views. Host capability flags identify
operations that require the desktop daemon. Do not build a second mobile
project/document UX to fill those gaps.
Model setup belongs in Settings, with a compact link from an unconfigured chat.
On a phone it is one model list. "On this device" holds downloaded models and the
phone's own AI. "Download" holds the system model still to fetch and the catalog
models that fit the device's memory, judged against the budget its runtime reports.
Choosing a download starts it and selects the model when it lands. The list never
says "import" or "GGUF": a model is named by its catalog name, or by its file name
without the extension, and adding a file from Files is a separate key. The list
is the app's own Select, not a native `<select>`: Android shows a web select as a
system dialog at the system text size, radio column on the right, so model names
wrapped and the list matched no other dropdown. A size sits beside its name in a
row (`Select.Item`'s `trailing`), never in the closed control, and rows take the
44px touch height. A download in progress and a removal confirmation are each a
bordered card. Their keys, like the ones under the list, share a row equally and
fall to one per row when two would not fit.

The compact layout runs one notch denser than desktop on Android and in a narrow
desktop window: `html[data-layout="mobile"]` sets the root to 87.5%, so the whole
`--text-*` rem scale shrinks together. iOS uses a 19px root instead (118.75%),
because iPhone text read too small at 87.5%, at the desktop 16px, and at 17px.
Never shrink a single view to compensate. Editable fields are the one floor:
on iOS they stay at 16px or more, because iOS zooms the page into a focused
field with smaller text. It also narrows the main gutter
through `--app-main-pad-inline` on `.app-main` (0.75rem instead of 1.25rem).
Full-bleed views cancel that gutter with the same `--app-main-pad-block` /
`--app-main-pad-inline` tokens, never with literal negative margins. A view
that adds its own inset on top of the gutter drops it in compact, so every
compact view's content edge lines up. Page-level panes, such as Settings,
span that full width without a second indent. Home's greeting band
steps aside for the visit, without saving that, while the meester's
introduction fills the empty conversation, just as it does once the person
sends. During first run there is no band at all (see [The welcome](#the-welcome)). A tab the person chose, including the one already open, holds it open
through that. The band greets once per launch: shown expanded once, it stays
rolled up on every return to Home in that run. It also steps aside whenever
the meester's thread holds a failed turn or a reply that arrived while the
person was away, because the conversation, with its Retry, is what they came
back to, not the tip of the day. Collapsed, its tab bar stays visible; selecting any tab reopens its
content. On narrow screens a long label breaks onto a second line inside its
tab, so every destination stays visible and every tab stays on the seam.
The introduction reads from its
top, because an empty timeline does not pin to the bottom. In compact, its
figure sits beside the title only, so the openers get the full width. The compact title bar leads with the
navigation button, left of the brand. The button stays while the navigation is
open, pressed, and a second tap returns to the current view, so the brand never
shifts. In the compact rail, the
active row stands alone: a full border and `--radius-md` on all four corners,
with equal side margins. It has no tab bridge, because no content pane sits
beside it to merge into. A choice with one option shows no tray. For example,
Tasks hides its kind filter on a host without background work. In dark mode
the native app paints its ground `--gezel-paper-night` (true black) to meet the
phone's own system bars. The top safe-area inset is painted the title bar's
sage on the app's root, not by the header, so the status bar and the title bar
read as one green band even while the keyboard hides the header. The status
bar's icons stay light in either theme (`SystemBars`, status bar only; the
gesture bar sits on the page ground and keeps the system's choice). On iOS 26 and
later the web view's scroll-edge effects are hidden (`MainViewController`):
the system otherwise dims that band, and over a solid sage strip the dimming
reads as a shadow hanging from the top of the screen. The band is no deeper
than it needs to be: an iPhone's top inset runs about 11pt past its Dynamic
Island, so iOS takes 9px off it and the header sits just under the island. An
inset of 24pt or less (no cutout) is kept whole, and Android keeps its own. Until
the shell mounts, the band also covers the header's row
(`--app-compact-header-height`), so the title bar is whole from the first
frame rather than gaining the header a few seconds into boot. The ground
below it shows the bench in faint outline, a CSS mask in the first
stylesheet: it fades in only after 400ms, so a quick start never flashes it,
breathes slowly (not under reduced motion), and leaves when the shell mounts. Desktop
windows, including narrow ones, keep the warm dark canvas.

Interactive targets are at least 44px on touch input, which is
`@media (any-pointer: coarse)` and never the window width alone. A narrow
desktop window driven by a mouse keeps the desktop navigation's row heights
and caret column. Project and conversation tabs drop to icons only when
their labels no longer fit (see [Tab rows fit by shedding labels](#patterns)),
and narrow file browsers use list → detail/back while keeping editors mounted.
Every master/detail area does the same below 640px of its own width — Tasks,
Plans, History, Crew: the list first, the item in its place when
tapped, and a secondary "Back to …" key above it. Side by side at phone width
they left the editor about 70px wide. A chat whose only pane is Chat shows no
pane tab row. A described tray stays one row on a phone, its keys sharing the
width and wrapping their words, because the stem to its readout can only reach
from the first row. In a compact layout Settings chooses its section from one dropdown beside
its heading instead of a list, because a list in a short box above the form
hid every section past the fourth. Sections under a group heading are
indented in the dropdown's menu, a heading that only groups others is not an
entry, and the sidebar-position choice is hidden, since the rail's side only
shows in a wide window. The Settings dropdown and the row action menus take
the 44px hit area. The composer's keys keep a 36px face and reach 44px through
an invisible `::after` around it, since a 44px face turned the composer into a
row of slabs; keys that do this stand at least 4px apart. The gezel header's
Context and Sandbox chips do not take the hit area yet.
Narrow forms wrap fields and actions before squeezing text inputs; step forms
and catalog grids can fall to one column within their own pane. Task detail
puts its view keys above a full-width step tracker below 480px. A non-chat
editor below 32rem gives its view tabs a separate row so formatting and host
actions such as Export stay reachable. Compact dialogs use the available phone
width, and touch dropdown rows, dialog tabs, and dialog actions keep a 44px
minimum height. Long paths and identifiers wrap within settings panels.

The titlebar never wraps. The compact header shows the navigation button in
place of the brand mark, because the navigation leads with Home and one
place gets one key. Updates becomes a 44px bell key like the menu and search
keys beside it, with its count raised onto the key's top-right corner as a
notification badge. The word stays in its accessible name. At the right end
the bar keeps two status keys from the desktop cluster: the chat queue (a
stack glyph with a total badge, present only while something runs or waits)
and the default engine (a chip glyph whose corner dot is the status light).
While a gezel is being read aloud, the stop-narration key (a speaker glyph)
joins them, left of the queue key. Their popovers span the width of the phone. Further engines, quotas, and the
task-speed menu wait for a wider window. The keys follow the `engineStatus`
capability, so the phone shows them too; there the engine popover reports status
only — idle retention, health policy, memory and Hard Stop are desktop engine
management (`daemonSettings`). On macOS the
compact bar is still the window titlebar, so it keeps the desktop bar's 39px
height and 30px keys, which centres them on the traffic lights (a trackpad
needs no 44px target). The phone preview keeps phone sizes. Compact layouts spend no row on a heading that only repeats a name: a
single-project tab has no project title row. The Projects area keeps its row
for the back button. The chat's thread-and-task strip shrinks to one-line
tiles, 24px tall (WCAG's minimum target), that show the status dot and the
title, each as wide as its title needs up to 12rem or two fifths of the
strip. A fixed 60px cut "Write a short, friendly reminder…" to "Writ…" beside
a strip that was otherwise empty. This is a deliberate exception to the 44px
rule. The strip stays a glance at the state of the work, not a second pane,
and each tile's accessible name still carries the full summary. With no
recent work there is no strip at all, at any width: a new project's chat
opened under an empty tray the height of a row of tiles.
On touch screens and windows up to 600px, and in a conversation narrower than
420px inside a wide window (a page's companion chat), a message's action row
sits in the flow instead of floating in the gutter; it shows only the
debug-bundle key, and only while debug mode is on; Copy and Save stay desktop
affordances. A conversation that narrow also gives its replies the whole
column, with a tighter thread indent and bubble padding: under the usual 92%
cap a reply there wrapped at about 22 characters a line.
Wider than that, the thread bar rides the To line: who and which
conversation are one line of context ("To · Ada Lovelace · Engineer", then the
thread picker taking what the recipient leaves), and it wraps to a full-width
line of its own only when the row is full. As a second row it made four layers
of chrome before the text box. The one exception is the project compose
frame (`threadBarOwnRow`): its chat mode shares every band with the terminal,
whose folder picker is a row of its own, and flipping modes must not move
the frame, so the picker keeps its row there. The label reads "To", not
"TO:", and the recipient is a `PersonLabel`. The To line and the strips above
it (task, image, review, error) share the editor's left and right edges.
Every desktop chat wears the same compose frame: an accent-tinted border, a
warm band for recipient, thread and toolbar above the lighter draft, and the
timeline's 0.75rem gutter on both sides. That holds for Home, a gezel's chat,
and the task, craftbook and page chats (one rule in `shared-content.css`);
project chat draws the same frame around its chat and terminal modes. Insets
are never one-sided. The Office pane's document chat, about 320px wide, runs
edge to edge like a compact composer. A narrow composer (under 480px) moves its thread
bar into the editor toolbar
beside the attach keys, as an icon-only picker plus the context meter. New
thread and New draft are rows in that picker, which lists them at every width,
so their separate keys drop out there. The picker takes the toolbar's key
size, like the attach keys beside it, a deliberate exception to the 44px rule.
Compact chat composers extend to both edges of their pane, with no outer
desktop gutter. Only the text and controls keep a small inner inset. Native
shells reserve the system's safe rectangle for content, including landscape
cutouts and the home indicator; the composer surface continues through the
bottom safe area so device corners never clip the draft. Read Capacitor's
safe-area variables with the browser `env()` values as fallback, and apply
insets once. The native composer follows the visual viewport above the keyboard,
as do portaled dialogs. Menus, selects, popovers, and tooltips use that same
safe app rectangle for collision detection. Replies render as text without privileged HTML or external
navigation inside the native web view.

**A narrow window gives the work the room.** Below 1,200 px
(`NARROW_WINDOW_PX`, [useNarrowWindow.ts](../packages/ui/src/components/useNarrowWindow.ts))
the navigation rail folds to its icons, and a project's docked board steps
aside on the Tasks and Settings tabs, the two that need the width. Neither
changes a saved choice: opening the rail, or pressing the board's toggle,
holds it open for the visit, and a wider window brings back what the person
had. At 1024 x 700 the open rail took 23% of the window while a task's
detail was 120 px wide, its title wrapped to three lines and its status keys
were cut off. A board's own tiles are its page's CSS, so making them wrap is
the app's to do.

**An empty place says what it is for and how to start.** One sentence on what
the place holds, and one key worded as what the person gets: "Give the crew
a task", "Start a project", never "New task"
([EmptyPlace.tsx](../packages/ui/src/components/EmptyPlace.tsx)). It sits in
the upper part of the pane, where the eye lands; a line centered in a tall
window read as a pane that had failed to load. An empty group in the rail
offers the same start as a quiet link ("Start your first project"), not a
statement that nothing is there. A filtered list that matches nothing offers
the way back ("Show every task"). New owners met "Pick a project on the left
to view it here" over a blank page and "No one-time tasks have been created
yet" in the middle of another; neither said what the place was for.

**A doubted sentence is marked where it stands.** When the fact check could
not find a statement in any source, the reply marks that sentence with a
wavy ochre underline on a faint wash (`::highlight(gezel-unconfirmed)`,
[grounding-flags.ts](../packages/ui/src/components/grounding-flags.ts)), and
the line under the reply says how many are marked, in the attention color.
The count in gray footer text was the only sign before, so a wrong weekday
table read as settled. A number the engine calculated shows its working:
its source reads "Calculated from …", and opening it shows the query and
what it returned.

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

### Opening the workshop

Electron opens a small local Home reader before waiting for the daemon. It uses
the normal sage titlebar and real native window controls, the saved theme and
sidebar side, and a bounded reading copy of the Meester's status and recent
Night shift reports. Saved reports carry their dates; live
activity and report actions wait for the service. The Home Help introduction
ships with this reader and works on a first launch too.

The local screen uses the live app's logo, navigation tab, Home typography,
Meester figure, greeting, and tip components and styles. **It is the running
window's frame, waiting** ([startup/Chrome.tsx](../packages/ui/src/startup/Chrome.tsx)):
the title bar holds Back, Forward and the trail, the brand and the search well,
disabled; the rail holds Home and, inert, the same groups and rows the live
rail will show; the Home tabs are the live set (Night shift only when there
is a night to read about, Create disabled until the workshop opens). A home
nobody has used yet (`StartupHomeSnapshot.welcome`, the service's own
`everUsed` rule) opens on the Meester's welcome, so the screen draws the
welcome's shape instead of the greeting sheet. The composer's frame stands
where the composer will, and its draft area says "Opening Gezel…" with
moving dots, the one place an open sheet never covers; placeholder lines
breathe where text is on its way. The screen once showed a brand, a status
pill and one Home row, then swapped to a different page with six more keys and
rows about ten seconds in. Breathing placeholders are an exception to "No
shimmer and no spinner": that rule is for a pane swapped in under a second,
and starting the workshop takes ten. The saved character is the Meester's
persisted poppetje, not a generated stand-in.

The entry includes React and the small Home components (a 400 KB script budget).
Squisq and the bundled Help introduction are lazy-loaded only when a saved
status report or a chosen Night shift/Handboek page needs them. No project or
session scan belongs in Electron boot. When the person was reading, the copy
stays over the live panel while it loads beneath, then steps aside on its own
(`StartupReadingOverlay`): at once, keeping the scroll position, when the live
panel would read the same; with a short fade when it has news. It waits while
the person presses, selects, or scrolls in the copy, and never longer than a few
seconds for a live panel that does not settle. Never ask the person to judge
whether the copy is current. Pending drafts from older startup versions still
transfer before the local copy is released. Honor reduced motion and keyboard
tabs.

### Signing in

Only a daemon that requires accounts (a Gezel container, or `gezel start
--web --accounts`; ADR 0029) shows a sign-in. The desktop app and embedded
surfaces bring their own credential and open on the first frame
(`sign-in/SignInGate.tsx`). The screen is one small card on the paper
background: the muted "Gezel" wordmark, a serif heading ("Create your
account" or "Sign in"), fields laid out label, input, hint, and one filled
key. Rules:

- **Say the next step, never the mechanism.** "The setup link is in the
  log" and "Someone who can sign in can set a new password in Settings,
  then Accounts", not token, session or 401.
- **One wrong answer for both mistakes.** A wrong name and a wrong password
  read the same: "That name or password is not right."
- **A session that ends mid-use returns here** with one line, "You were
  signed out. Sign in again.", never a wall of failed requests.
- **Where people are added, say what they get.** Settings → Accounts says
  "Everyone here can do everything you can, including open a terminal."
  until roles exist, and the Add an account dialog says it again.
- **Settings → Accounts opens on what accounts are for**, in the people
  section's description: signing in from a web browser, one name and
  password each, never needed by the desktop app or the command line.
  People and browsers are ruled lists (a name, one muted line, the row's
  actions at its end), never boxed cards. Add account is the page's one
  filled key; each person's ⋮ menu holds Set a new password, Stop them
  signing in, and Remove, which asks first. Adding someone and setting a
  password open dialogs, so no form sits open on the page.

### The welcome

The first thing a new person meets is the meester, not a setup page. Home
renders the workshop from the first settled frame; the meester's empty
conversation opens on `MeesterWelcome`: the meester full-figure on the
plank (`MeesterFigure`, the same figure the greeting band stages), a serif
time-of-day line ("Good afternoon. I'm Florian — I run things here."),
and the meester's lines in the chat register (serif body). Rules:

- **One thing at a time.** The welcome has two stages. While the tools are
  still to be fetched, connected or retried, it is only the meester, the
  greeting, the ask and the privacy line. What to make, the interest picker,
  the film and the helpers arrive once the download is running, when there
  is time to read them. Shown together, they put six things to read beside
  the one thing to press. The check that runs between "downloading" and
  "ready" holds the stage on screen, so the welcome never folds away under
  someone watching the film; a download that fails or is paused returns to
  the ask. A phone, which draws its own model list, keeps one stage.
- **Setup is the meester asking for tools.** The one thing the app cannot
  run without, an AI model, is asked for in the meester's voice ("Before we
  start, I need my tools…") with one accent key that says how much, **Fetch
  my tools · 15.3 GB**. How long depends on the connection, so that is a
  muted sentence under the key, not a number on it: "About 30 minutes on a
  fast connection, longer on a slow one. You can keep using this computer,
  and I'll pick up where I left off if it stops." A minute count on the key
  read as a promise, and on a slow connection it was off by hours. A
  download that stopped part way offers **Resume fetching my tools · 3.2 GB
  of 15.3 GB done**, with the time for what is left. Nothing downloads
  before that tap. Quiet muted links sit beneath: "Use one already on this
  computer" (opens a small tray of the models on disk) and "Connect a cloud
  account instead". A cloud provider that is not connected gets one key,
  **Connect an AI**, into Settings. A phone draws its own model list in the
  same place.
- **Everything else is a default, with one muted line.** No posture tray,
  no preference switches, no media downloads. The security posture, names
  and poppetjes, the relevance check and social mode keep their first-run
  defaults; one `--text-xs` line says what that means and links to Settings
  → Security & compliance ("Change what I'm allowed to do"). Optional media
  models live in Settings → Artificial intelligence.
- **One surface per message.** While the tools arrive, progress is one
  quiet line under the meester (a thin bar, then "Fetching my tools · 1.2 GB
  of 15.3 GB · about 12 min left"), not a banner. It counts in amounts, not
  a percent: "8%" says nothing about how much is still to come. A quiet
  **Pause** link sits beside the line while bytes are arriving and returns
  to the Resume key. The time left comes from the measured speed, and only
  once that speed has been watched for twenty seconds (`steadyBytesPerSecond`):
  the first pieces arrive in bursts, and twelve seconds in the line once said
  "about 10 h 20 min left". The size on the key counts everything the
  download fetches, the model's vision file included, so the key and the
  progress line name the same total. When the measured rate puts the end more
  than two hours away, one muted note says so ("This connection is slow, so
  this will take a while. You can leave it running."), never beside the quiet
  or stalled notes. The composer is open for a draft throughout. Until the
  download starts Send is held, and a held Send always says why: a
  `--warning` dot and line on the toolbar beside it (`.chat-composer-held`),
  "**Can't send yet:**" plus where setup stands. In the meester's thread
  that is the welcome's own state ("download tools (an AI model) first",
  `composerWaitingStatus`); elsewhere it is the running download in the same
  words ("downloading the AI model · 42%", `modelInstallStatus`), else "no AI
  model is downloaded", with a **Get started** key to Home. A dimmed arrow
  alone read as broken. A
  failure is one plain sentence with **Try again** and quiet escape links; a
  report link only for real failures.
- **The first request does not wait for the person to come back.** Once
  the tools are on their way (downloading, setting up, getting ready), Send
  and Enter in the meester's own thread hold the request instead of
  refusing it (`sendWhenReady`), and the welcome says so in place of "Or
  tell me in your own words": "Write your first request below and press
  Send. I'll start on it the moment my tools arrive." Nothing is refused, so
  the toolbar line drops the warning tone for the muted one
  (`.chat-composer-held--queued`): "**Sends when ready:**" plus the status,
  then "**Queued:** sends when the AI model is ready · downloading the AI
  model · 42%" with a quiet **Don't send** link. The draft stays editable.
  Erasing it, picking a first project, or changing thread or recipient
  withdraws the queue: only the words the person pressed Send on may go out
  unasked. The queue survives a reload during the download
  (`gezel:home:send-when-ready` in localStorage; the draft is already on
  disk), and the request is sent once, when the model can answer.
- **No page swap.** When the model lands the same surface says "I'm ready.
  What shall we make?", or sends the request it was holding. The greeting
  band and the folder step stay away for the rest of that visit; they
  arrive on the next.
- **The title bar is quiet during first run.** Brand and search only;
  Activity, the engine, indexing, quota and tempo controls describe a
  running workshop and join once there is one.
- **Static, never a model turn.** The welcome is written copy, so it is on
  screen before anything can answer and never puts words in the meester's
  mouth. The helpers made at boot (the Scribe, the Librarian) are
  introduced by name in one small line, so no name in the sidebar is a
  stranger. The tour ("Take the 1-minute tour") opens in place.
- A conversation that already has history when the model goes missing keeps
  it, and the meester's ask for tools sits at its foot as a bordered note
  (`MeesterSetupNote`), above the composer.
- **First run lasts until the work can run.** On llama.cpp the engine is
  fetched lazily, so a model already on disk is not enough: the welcome
  shows "Setting up my workbench · N%" until the engine is in place, and
  only then says it is ready. Tapping **Fetch my tools** fetches the engine
  beside the model.
- **The model offered is one that will start.** First run picks against the
  memory free when it runs, as the launch check will, not against the
  machine's size alone: a 21 GB model offered to a 12 GB laptop with 8 GB of
  RAM free was refused on the first chat turn. A 1-bit quant ranks at half
  its curated score and a 2-bit one at four fifths, so a newcomer is not
  handed a model that only fits because most of its precision is gone.
- **Nothing scheduled runs on a new install.** The night shift waits under
  the same hold as background indexing (first half hour, and until a model
  can answer), and Home's conversation leaves out scheduled runs' sessions
  altogether, so an install after 22:00 still opens on the welcome rather
  than a failed overnight review.
- **First projects, not openers.** Up to four stacked keys (`gz-key--stacked`,
  title over a one-line hint), chosen by `firstProjectsFor` from
  `FIRST_PROJECTS` in core. A typed one is a goal a project type carries end
  to end with one lead and a board (a trip, a celebration); a craftbook one
  arrives in the composer with its book attached, and with the book's
  bundled sample when it has one, so Send starts it with no meester turn
  and nothing of the person's own. A key prefills an editable sentence and
  never sends it. A first project that needs the person's own details
  (a trip's place and dates, who owes them money, this month's news) carries
  an `ask`: the meester asks its question under the cards, the composer gets
  only the opening words with the caret after them ("Plan a trip to "), and
  one way to finish the sentence shows as "For example: …". "Send an
  invoice" once wrote an illustrator's two clients into a baker's box. The
  opening alone must route the request to its project type
  (`first-projects.test.ts` in core and the catalog). "Or tell me in your own
  words" sits beneath when no question is asked. They are
  held back while the welcome asks for tools. A first
  project joins the pool only after it passes its evals (`first-project-*`
  scenarios: 2 of 3 on Gemma 4 E4B, 3 of 3 on Gemma 4 12B, Lockdown); a
  phone offers only the ones that also passed on the phone (`phone: true`).
- **The welcome asks what the person wants help with.** A new install (a
  `firstUseAt` within the week) that has not answered sees the interest
  picker under the meester's question, "What would you like help with? Pick
  any." (`InterestPicker`, checkbox cards with bare
  labels, several can be ticked, none required; see
  [Controls: checkbox cards](#controls-checkbox-cards)). It is never asked
  beside the ask for tools: it appears once the download is running, as
  something to do while waiting. When the model is
  already on the machine the same picker sits inline above the first
  projects. Each tick saves at once and the first projects re-order under it;
  the picker stays for the visit rather than vanishing on the first tick, and
  "Not now" (or "Done") puts it away. While the tools download, one line
  sits between the picker and the first projects: "While tools are
  downloading, let's get ready for our first conversation. Here are some
  ideas for things I can help you with." Once the picker is put away,
  that line moves up and leads the welcome. An established install is never
  interrupted to ask; Settings → General → What you use gezel for holds the
  same picker, with each area's hint.
- **The intro plays from the download on.** Once the welcome is past its
  ask for tools, in any first-run state (downloading, setting up, getting
  ready), "While we wait, here is a bit more about Gezel:" and the "What is
  gezel?" Help article as a video
  (`IntroHandboekArticle` `variant="player"`: the player alone at the
  video's own 16:9 height with its controls over the frame's foot, standard
  closed captions, never autoplaying, Open in Help beneath) sit under the
  first projects. Keying
  it to a running download made it come and go with page reloads and models
  already on disk. It stays for the visit after the tools land, so they never
  pull the video from under someone watching; the lead-in then reads "Here
  is a bit more about Gezel:", since nothing is being waited for. The "Take
  the 1-minute tour" link is left out while it is there. Past first run the
  intro waits behind that link. A phone, which draws its own model list,
  does not show it.

### The first request: crew, working notes, the finished thing

What the meester's thread shows after the person asks for something:

- **Internal prompts stay in debug mode.** System-authored task instructions,
  page reactions (such as a game's board state), and hidden retry prompts stay
  out of ordinary chat, including queued previews. Debug mode reveals them for
  inspection. The model still receives them; the person's messages and the
  gezel's replies remain visible in both modes.
- **The crew arrives as cards** (`CrewIntroCard`, a `crew-introduction`
  message carrying `crewIntroduction`): a headshot, the name in the serif,
  their role in plain words ("Trip Planner", "Crew Lead"), what they do
  (the first sentence of their description), and **Say hello**, which opens
  their chat. The lead and
  whoever starts the work are introduced as the task begins; a gezel hired
  for a later step is introduced when they start. Someone hired in
  conversation, with no task behind them ("find me a copywriter", or a
  delegation that had to recruit), gets the same card once the reply that
  hired them has finished, so it follows the words that name them
  (`postHireIntroduction`; before 2026-11-10 they joined the roster without a
  word). Each gezel is introduced
  once per thread. Neither the card nor the introduction's text names the
  step they start on: `Minji (Office Administrator) starts with "First
  draft"` read as a schedule in the plan's own words, and a small model
  repeated it to the person. The text says who joined and as what ("Your
  crew for this: **Minji** (Office Administrator)."). A crew member hired
  moments ago is not in the roster the thread read, so the thread reads it
  again; until it answers, the portrait is a quiet empty tile
  (`GezelIcon` `pending`), never a letter that turns into a figure a moment
  later. The tracker's line does the same for its lead.
- **The crew's work folds into one line** (`WorkingNotes`) in every
  conversation, not only the meester's Home thread: "Mira is working…" with a
  breathing dot, then "Mira's working notes". The worker's transcript,
  thinking, tool calls, hand-offs and any failure banners are inside. A
  stopped worker shows "Mira stopped: …" on the line in the warning tone,
  never as a red banner in the person's conversation. A worker waiting on
  the person is the one exception: the line reads "Mira has a question for
  you" in the warning tone and the fold opens, so the question card is in
  view. Debug mode shows the full session tree instead. A task's own chat
  starts at the worker's session, so there is nothing above it to fold into.
- **The finished thing is last.** The wrap-up renders after the fold, not
  above the work that made it, and closes on the finished-work card
  (`DeliverableCard` with `maker`): "Mira made this for you" with a small
  portrait, a cover of a written document's first lines in the serif, then
  **Open · Make changes · Show in folder**. Make changes opens a chat with
  the maker. The card is named for what the person asked for ("One-page
  catering proposal for Harbor Books"), with the file's name on the small
  line beneath; see "Work that made something ends on the thing it made".
  When the deliverable is the data a project type's Output page
  reads (`view: 'output-page'`), the card names the project and opens it:
  the board is the thing to look at, never the JSON behind it.
- **The result gets the stage beside the conversation.** Where the rail has
  room for a side pane, a finished file is the one the pane shows when it
  arrives, unless the person picked a file themselves in this visit; with
  nothing finished and nothing picked the pane shows the file seen last,
  never the first one of the visit. Opening the result from its card widens
  the pane to 0.62 of the rail for the visit (the conversation keeps at
  least 360px), so a document reads at page width and not in a column under
  400px. One key in the pane's header, **Wider** / **Narrower**, switches
  between that and the stored width; dragging the grip hands the width back
  to the person, and the wide state is never stored. A path linked inside a
  message opens at the stored width: it is one file among many
  (`ResultStageContext`, provided by `ChatReferences`).
- **The finished card owns the screen when it lands.** A fresh wrap-up
  scrolls to the top of the view (the thread stops following the bottom),
  and nothing is appended beneath it during that visit: the folder question
  used to arrive with the wrap-up, and the view followed it down until the
  first finished result had left the screen for a folder picker. While the
  thread shows a task's finished card, the chat rail leaves the deliverable
  off that task's card, so the board does not appear twice side by side.
- **Open opens the board, full window.** Opening a project-type deliverable
  takes the project's Output page to fill the workspace (`requestOutputPaneFullWindow`).
  The main project sidebar stays visible on its configured side, at its current
  width and expanded or collapsed state. Each project remembers its page mode
  (closed, open beside the conversation, or fullscreen) across navigation and
  restarts, so a project can reopen directly into its app. Maximize and restore
  keep the same page mounted. Expanded pages hide their own toolbar and bottom
  screenshot strip; the main titlebar keeps the restore control. A project with
  one page shows no page
  picker: a select with one choice is a label pretending to be a control.
- **The board reads like the plan, not like the tool.** A type page labels
  what the person would: "Day 1" when there is no date yet (and the date
  beneath once there is one), each day as plain lines with no
  "Anchor: / Options: / Slack:" scaffolding, counts in words ("1 day", "7
  days", never "day(s)"), and who is going when the person said ("4
  travellers"). The trip planner (gilde `trip-planner` 1.0.3) is the
  reference.
- **The task says what the person asked, and no more.** A typed kickoff's
  description is the person's own request, not the meester's expanded brief,
  so a lead running in the default posture is not handed hotels, dining and
  a budget it cannot research. The lead makes what was asked and offers the
  extras in its reply.
- **Then, on Home, the folder question.** Which folders to look after and
  whether to work at night (`FolderOnboardingStep`) is asked on Home's
  greeting, under the headline and in place of the tip, and never in a
  conversation. In the thread it was appended under the first result and
  scrolled it off the screen. It waits until the person has opened a
  finished result from its card (Open, Show in folder or Save a copy…,
  stamped once as `onboarding.firstResultOpenedAt` by `result-opened.ts`),
  so it never competes with the first thing the crew made, and it never
  appears during first run. The greeting is rolled up while the person is
  talking, so the question is seen on the next visit to Home. Nothing is
  ticked and neither overnight key is latched: the person chooses, or skips.
- **A request with work behind it gets one tracker** (next section). Outside
  debug mode it stands for the cards, introductions and finished card above;
  the crew still arrives as cards once, at kickoff.

### Every project has a main crew member

A project is assigned one crew member (`voormanGezelId`, whatever the
project's shape). What they do there differs, and the words follow what they
do:

| Project shape | What the main crew member does | Called |
| --- | --- | --- |
| Crew (`mode: 'crew'`) | Leads a crew and hands the work out | Crew lead |
| Solo (`mode: 'solo'`) | Does the work alone, start to finish | Their own role: Builder, Writer |
| A project type with its own title (`leadLabel`) | Whatever the type says | That title: Opponent, Coach |

Nobody is asked which shape they want. A new project the Meester starts,
or one made with New project, takes the shape the default AI model works best
in: a crew when that model does best step by step, one crew member alone
otherwise (`resolveNewProjectMode`, in docs/generalist-mode.md §4). A folder
is always worked by one Builder. The project keeps its shape when the model
changes later. Its main crew member is someone the person already has
whenever there is one, so one Builder runs several projects and the crew does
not grow by one for each.

Working alone is the common shape, so never write "crew lead" for a
project's main crew member without checking the shape. The picker in project
settings is labeled **Crew Lead** on a crew project and **Main crew member**
on a solo one (`crewLeadLabel`); the crew list shows the star and then
"crew lead" or the person's own role (`mainCrewMemberSubtitle`). "builder"
under a Writer's name on a document project is what this replaced.

**The star marks the main crew member in both shapes.** It sits before
their line in the project's crew list and beside their name in that
project's chats, in the bubble header and the pinned header alike
(`roleGlyph`, `speaksAsMainCrewMember`). It follows the project, never the
role: a Builder who runs a project alone carries it there, and a crew lead
speaking in a project they do not run does not. The Meester keeps the drawn
top hat in chat. Default and the shared library have no main crew member.

### One request, one tracker

The bakery's first invoice put three craftbook cards, five introductions, a
silence banner, a task id and two "ready" rows in front of its owner. Now each
person message with work behind it gets one `RequestTracker`, closing the
thread rooted at that message. Its model is core's `RequestTrack`
(`resolveRequestTracks`, served at `/api/requests` on both hosts), keyed by
the message (`<sessionId>@<at>`); every task the request caused carries the
key as `Task.requestRef`.

- **Four fixed stops**: Got it → Making it → Checking it → Ready. A step's
  stop comes from its `stage` (gilde step field), else `stepStage`'s reading
  of its name and position. The stop is the furthest any step has reached,
  so a review that sends work back never moves it left.
- **One line in the lead's voice**: "Dejan is drafting the invoices". The
  lead is the project's lead, else the thread's gezel; the crew is under
  **Who's helping?** (`CrewMemberCard`). The phrase is the step's
  `personLabel`, else its name with the verb turned, else the stage's phrase;
  a name holding a file name, a template token or a word for the machinery
  gets the stage's phrase. Waiting says why ("is waiting for another chat to
  finish", from the engine's structured `hold`).
- **An honest estimate**: "About 4 minutes left" from this computer's own
  finished runs (per step, then per stage), "First time here: about 8
  minutes" from shipped seeds. A step past half again its time and three
  minutes more reads **Taking longer than usual** with **Keep waiting** and
  **Stop** (behind a confirm). The tracker's states replace the silence
  banner for the work it tracks.
- **Stopped work says so in one sentence, with the way back beside it.** A
  task the runtime paused reads "Dejan stopped before this was finished",
  then why in plain words ("Gezel tried this step several times and couldn't
  finish it. What it made so far is kept.") and **Try again**. One the person
  stopped reads "is waiting for you to go on" with **Carry on**. Never "has a
  question for you": that line is for a question the person can answer. The
  engine's own error (a model id, how much graphics memory was free) stays
  inside the Working notes fold, whose line reads "Dejan stopped before
  finishing", and only while the request itself is stopped: a failed turn
  the runtime retried leaves the fold reading "Dejan's working notes" under
  work that went on or finished. A busy engine is retried quietly, with a
  growing wait, before anything stops.
- **Ready is the file.** The finished card moves from the wrap-up into the
  tracker, credited to the lead and named for the request
  (`RequestTrack.title`, the task's title unless that is only the plan's
  name). The tracker's last stop and the card say the work is ready, so the
  wrap-up does not say it again: "Ready" read three times over one result
  when the wrap-up also opened "Your Word document is ready: …". A wrap-up
  with a deliverable keeps only what the card cannot say: what was checked,
  the maker's open question, and what to do next ("Open your Word document
  to review, or tell me what you would like changed.", named by kind so the
  thread's preview line still says what it is about). A request that is
  Ready while the meester still writes says "is wrapping up" and never flips
  back to working.
- **What it stands for stays out of the thread** outside debug mode:
  launch cards, joined-crew introductions, queued-task receipts and rail
  cards for its tasks. **Open the task** under the disclosure is the way in.
  Debug mode shows all of it again, and the tracker adds who really holds
  which step and the task id. A folded introduction still introduces: the
  tracker names whoever joined the crew for the request, in the lead's words
  ("Dejan brought Noor (Researcher) onto your crew for this.",
  `RequestTrack.joined`), with their cards under **Who's helping?**.
- **Not tracked**: task-scoped sessions and plain replies with no work.
  Activity folds a request's tasks, shards, sessions and receipt into one
  `request:<key>` row, drawn as the compact tracker, whose key opens the
  person's thread.
- **The lead speaks for the crew everywhere the person looks.** A gezel
  joining later is announced in the lead's words ("**Dejan** asked **Noor**
  (Omroeper — social posts) to help with **October invoices**"); the
  Working notes fold under a tracked request is "Dejan's working notes"; the
  title bar's engine key reads "Dejan · drafting the invoices" while a turn
  works on the request; and the finished-work notification names the lead.
  Who really made the file stays on disk (`makerGezelId`) and shows in debug
  mode.

### Start work from Home

Home's intro starts with the greeting tab, named for the time of day like the
headline inside it (**Good morning**, **Good afternoon**, **Good evening**),
followed by **Night shift** when a review is available, **Create**, and
**Help** with the "What is gezel?" article. The greeting tab shows the
current status report when available, otherwise the tip of the day; the report
has no separate tab. The named tabs remain visible when the intro is collapsed,
and selecting any of them expands its content, including the already-selected
tab. Selecting the tab whose panel is open rolls the intro up, like the chevron.
A collapsed intro shows no tab as selected, since no panel is showing.
The intro is a pull-down shade, so its tabs are connected tabs (see
[Patterns](#patterns)): the tab row is a rail one step darker than the paper
(`--home-rail`), the open tab takes the sheet's paper and erases the seam
under it, and the sheet ends in a bottom rail of the same tone that rides up
with it when it rolls. The rail is the shade's pull bar: the whole width is
one key that rolls the intro up, with a small pull in its middle that lifts
on hover. It is 20px tall, 28px on a phone. It can also be pulled: the sheet
follows the pointer, and letting go once it has risen a quarter of the
sheet's height (at least 48px) rolls the rest of the way up; short of that it
drops back open. Unselected tabs carry no
chrome until hovered. Unlike dense project tab rows, this small set never
drops labels at narrow widths, and it never wraps onto a second row either: a
tab on an upper row would have no seam to join. A long label breaks inside
its own tab instead. The date belongs inside the greeting tab, not in
a tab label. The header stays
above the conversation. When open, its content overlays 90% of the chat area's
height, the same height the startup screen draws, so the handover never
jumps. The strip below it is a plain invitation in the paper ("Write to
Florian"), laid over the conversation and its composer: as a gray shade over
the composer itself it sliced the placeholder through its letters, and the
front door read as disabled and broken. The conversation keeps its full
layout and draft behind the sheet. Clicking the strip rolls the sheet up to
the tab bar and puts the caret in the composer; that click never activates a
chat control underneath. Escape rolls it up and returns focus to chat. The
roll takes 160ms and skips motion when reduced motion is requested. Tab
content scrolls inside the sheet; The Create tab uses the full content width
without the figure.

Home's **Create** tab offers six broad starting points: Research
report, Word document, Slide deck, PDF report, Website, and Animated slideshow.
Each key has artwork, a plain name, and a short description of the declared
output. **See all** opens the full plan gallery, whose **Start here** shelf
uses the same starter set. Use the existing tray and radius tokens; these
are square-ish keys, never pills.

Beneath the plans, a **Start a project** shelf offers up to six catalog
project types in its own tray. A key opens New Project straight on that
type's form (`initialTypeId`; the dialog stays hidden until the catalog
answers, so the gallery never flashes first), and the shelf's own **See all**
opens the whole project type gallery. A type this host cannot run is left
out, as a plan is. Below both shelves, **Integrate Gezel into other apps…**
opens Settings → Integrations, on hosts that have daemon settings.

Every key is one size. A first-project plan's catalog description runs to a
paragraph, so its key shows only the opening clause (`planShortDescription`:
the first sentence, up to a colon, then up to the last comma that fits),
clamped to two lines, and every tray row is as tall as the tallest. The
whole description belongs to the launch sheet, not the key. The trays use
`auto-fill` columns, so the shorter project shelf keeps keys the size of the
plans above it instead of stretching them.

Each Create key is an ordinary **key** of the theme (`--key-bg`,
`--key-border`, `--key-shadow`), holding the book's 64px mark as a
`--radius-md` tile on its category ground (see Workshop Marks below). The
tiles carry the color, so the card stays quiet and never uses a fixed light
paper in dark mode. The name and description use the theme's text colors, and
hover lifts the key and colors its border.

The starters live inside the intro tab. The folder step waits until the
welcome is over: on a later visit it keeps its own bounded area above the
conversation and yields to the draft on short touchscreens. The intro tabs
remain reachable while the native keyboard is open.

A Home key opens a compact launch sheet with the main field focused.
The person adds a topic, then chooses **Start now** or **Tonight**. Use the
most recently visited project, or Default when none has been chosen. Derive
the title from the topic and choose the crew automatically. Required inputs
stay visible; optional inputs, additional fields, Title, Assign to, and step
roles live in a closed **More options** disclosure. Plans with nothing to
ask show a single confirmation. Keep launch errors beside the action keys.
Enter in a field always means **Start now**: Tonight is a plain button, never
the form's default. Offer **Tonight**, here and on the composer's task strip,
only while the Night Shift is on and the host can work in the background; a
task queued for a shift that never runs is a silent failure.

Output summaries come from declared output files, including publishing steps
before a final Finish step. They stand in for the description only on the six
starters; every other plan card shows its own description (on a Home key,
its opening clause), and its
**You'll get** line appears only for a deliverable the type names (a deck,
document, PDF, video or GIF). A scratch `.md` or `.html` file says nothing
about what the person receives. **Usually about N minutes here** appears only
when this install has completed runs of the same plan. Use the median elapsed
time, ending at the last completed step; exclude overnight waits, recurring
hosts, and child tasks. Do not infer time from a later task edit or collect
telemetry. Example images and catalog-wide estimates are future work.

Words we show wherever a person starts or follows work: starter cards, launch
forms and their errors, the composer strip, task cards and receipts ("Plan
started"), pause cards, the project command rail, search results, lookout
actions and report actions:

| Internal term | Visible wording |
| --- | --- |
| craftbook | plan |
| default assignee / entry-step role | Choose automatically |
| voorman | crew lead, when relevant |
| boekwachter | Librarian |
| a gezel (in general) | Gezel |
| a gezel (a particular one) | their name |
| gezels, gezellen (the roster) | crew, crew members |
| Meester | Meester |

**The word is plan everywhere in the app; a craftbook is the file a plan is
written in.** People pick, start, follow, write and edit plans, and the area
that lists and edits them is **Plans**. "Craftbook" stays under the covers:
file and folder names, the `gezel craftbook` commands, tool names, deep
links, and documentation for people who write them. No other synonym
("book", "recipe", "template") stands in for plan, and plan means only this:
a kind of project is a project type, never a plan.

**Lead with the result, not with the plan.** "Pick a plan", "Choose a plan"
and a bare "Plans" headline sell a subscription in most software. A screen
that offers plans asks what the person wants made ("Choose what to make, add
a few details, and Gezel gets to work"), and keeps "plans" for shelf labels
and search.

Paths are implementation details. Derive output destinations from the task's
working folder; use file pickers for source material. A starter's main field
asks what the person wants made, never for a prompt, title, or filesystem path.

### Task progress: stops on a route

The task bench, chat rail, craftbook receipts, and craftbook editor share
`StepTracker`. Use the same circular stops at both sizes: sage filled checks
for completed steps, a larger terracotta stop with a play glyph and outer ring
for the current step, and quiet outlined circles for upcoming steps. A gezel
portrait may fill the current stop, but its ring stays visible. The warm route
passes behind each stop's centre; completed segments turn sage. Avoid wooden
beams and upright pegs. The active halo breathes gently, with no animation under
reduced motion; size, glyph, ring, and an explicit Active label also carry state.

Opening a task centres its current step, and advancing or resizing recentres
it. The left edge then snaps to a column boundary (`snapRouteScroll`), so no
caption is cut at its start: a long name is ellipsized at its end, never
read as "rite the Markdown docu…". Manual scrolling remains free until one of
those changes. Selecting a step
to inspect is separate from progress: underline its label and, on the full
bench, dock its caption into the panel. Assignees remain above the full route;
step names and status stay below. Both sizes use the shared semantic palette.
While hovering the route, wheel down moves right and wheel up moves left;
horizontal trackpad gestures keep their direction. At either end, unused wheel
movement can scroll the surrounding page. Drag the route or its scrollbar thumb
to pan; touch uses native swiping. A drag must not select a step or select its
caption text. Assignee pickers and the craftbook editor's drag-to-reorder keep
their own interaction, and pinch/Ctrl-wheel zoom is left to the browser.
The bench and step-details assignee pickers share one control. When poppetjes
are enabled, show a 20 × 20px portrait beside the name in both the selected
value and menu options, including a resolved default assignee. Keep every row
on one line; disabling poppetjes returns these pickers to text only.

**A schedule's bench shows its runs, not its own step.** A recurring task
(`isScheduleHost`) never works its placeholder "Wait for schedule" step, and
showing that lone step with an Add step stop read as a plan stuck before it
began (squisq/18). `ScheduleRunsTracker` puts the same route to work instead:
one stop per run, oldest to newest (the latest twelve; the Task tab lists
every run), each captioned with when it started and where it stands
("Finished", "Step 2 of 5", "Paused at step 1 of 5", "Waits for the Night
Shift"), and selecting a stop opens that run. The route ends in a dashed
**Next run** stop, inert because it is a promise rather than a control, with
its time above and its day beneath ("Tonight", "After this run", "On hold").
One sentence under the route gives the cadence and why the next run starts
when it does, beside a **Run now** key. `scheduleNextRun` in core mirrors the
scheduler's own rules, so the page never promises a fire the scheduler would
skip, and `scheduleRunsSummary` decides the wording. A night-shift schedule's
half-hourly check is machinery: it never appears as the schedule or as its
next run. A schedule opens on Task, since it has no chat of its own.

In a task's Chat tab, keep the composer at the bottom of the available pane
and scroll the conversation above it. The task header and bench stay visible.
This holds both when opening a task directly and beside the Tasks list;
the Task overview and step details keep their normal page scrolling.

The craftbook editor uses the same tab column: **Overview** and **AI assist**
sit to the left of its steps, and together with the steps they form one set of
tabs. A book opens on its entry step.

AI assist is a conversation about improving that one book, not a general chat.
It shows only the book's own threads and reopens the newest. The gezel there can
change the book and look at other books and roles, but cannot run it, start
work or write files. Each message the person sends carries the book as it
stands and a short checkup, so "what would make this better?" starts from the
book itself. Those threads never appear among a gezel's ordinary conversations
or recent-thread pills, and a message to the gezel is never delivered into one.

### Activity: what’s going on

The header’s **Activity** key opens one non-modal panel for work and questions
across projects. It stays available when quiet. **Needs you**, **Working**,
**Ready**, and **Next** separate decisions, current execution, finished
results, and waiting or scheduled work, in that order: a decision leads, then
what is running now, then what is finished, and the waiting and scheduled work
closes the panel. Ready once sat last, under every scheduled job, so the
results were the furthest thing from the top.

**The panel is a list of rows, not a stack of cards.** Sixteen things once ran
three screens deep (2,450 px in an 840 px panel), because every entry was four
lines or a full card at one weight. Five rules keep it to about one screen:

- **One row shape.** Every piece of work is a mark (who is on it, or the kind
  of file it made), the work in bold, one quiet line of who, where and what is
  happening, and at most one key. The engine's own rows take the same columns
  and lead with the work, not the gezel's name
  ([ActivityRows.tsx](../packages/ui/src/components/ActivityRows.tsx)).
- **A row with somewhere to go is one target.** Clicking it opens its task or
  conversation; its accessible name says which ("View task details for …").
  No row repeats a "View task details" link beneath itself.
- **Only a decision opens into a card.** A question shows its choices and
  text field inline. Finished work is a row: its name, its file, **Open**, and
  a quiet × that puts it away.
- **A section folds its long tail.** Past two rows, scheduled work is one line
  under Next (**Scheduled for later · 6**). Finished requests whose result was
  put away are one line under Ready (**Finished earlier · 12**), so a result
  never leaves the panel for good. Neither is what is going on now; both open
  in place. Finished-earlier rows are a record and are not counted in Ready.
- **Say each thing once.** A request is one row, so the engine's rows for the
  sessions working on it are left out and its row carries **Stop**. A paused
  task's sentence drops the title and the "open the task" pointer that the row
  already shows (`taskPausedCardDetail`), and its way in is an **Open task**
  key between **Try again** and **Dismiss**, not a link in the title line,
  so all three moves sit in one tray. One engine has no heading; the
  title bar's engine key names it. The panel's scope ("Across all your
  projects") is said only when it is held to one project.

A task’s saved “active” lifecycle is not
evidence that it is running; runtime queue and conversation facts decide that.
Link the task, handoff, and conversation by identity so they appear as one job;
a person's request goes further and is one row for everything working on it
(see "One request, one tracker").
Work parked until a time (a recurring schedule, the Night Shift window) is listed
under **Next** but never counted on the key: the Meester's nightly review is
always waiting, so a count there would only send the person looking for nothing.
The key uses the title bar's sage face, cream ink, and subtle border, matching
its neighboring status controls in both themes. A small indicator light carries
attention in amber; the whole key does not change color when something needs you.
Activity owns crew identity and work across local and cloud models. When no
question needs attention, a working gezel's portrait, name, and three dots
replace the generic working count. Attention and unavailable status take
precedence. The Activity label also disappears while the working gezel is shown;
the accessible name still identifies the control as Activity. Parallel work
shows up to three stacked portraits and the first name followed by `+N`, counting
distinct working gezels rather than jobs. The engine key describes the device's
phase, progress, and health; it has no crew portrait or name and stays hidden
for cloud-only work when no local engine is active.
The header reads every running queue owner, including background indexing jobs
without a chat session. Waiting jobs never enter the portrait stack. If work
has no known crew identity yet, show **Working…** and the thinking dots;
never fall back to **Activity · N working** in the visible key.

Background scanning, studying, reviewing, and digest progress belongs here too,
never in a separate Librarian key. Live index work joins **Working** and the
crew portrait stack, with its project and progress in the panel. A finished
scan briefly appears under **Ready**, labeled finished rather than continuing
to pulse as working. Batch-only progress and completion messages fade after
eight quiet seconds; a scan with an explicit start stays working until it ends.
Index rows open their project or Librarian.

Question choices and text fields are visible inline. Keep drafts when the panel
closes or changes project, keep cards in a stable order during refresh, and
leave an answer receipt in place until the panel closes. Answering the last
question does not close the panel. Project attention links open the same panel
scoped to that project, with a clear way back to all projects.
Home's **ready for you** and **waiting on you** keys open the matching Activity
section, scroll it into view, and move keyboard focus to its heading. Refreshes
must not pull the person back to that section after they start reading elsewhere.

A human assignment can carry its own plain-language expectation (`assignee.instructions`):
the specific action the person should take and how to confirm they are ready.
Show that expectation ahead of general step prose in Activity and owner review
cards. Task and step authors should provide it when handing work to the user.

A task waiting on a human step must show the current step, its instructions,
and a **What should happen next?** textbox even when it has no question card.
Place **Pause task** and **Cancel task** above that textbox; neither requires a
reply. Keep the draft on failure and disable all actions while one is pending.
**Continue task** saves that direction before advancing through the normal
completion checks. Keep the draft and explain any failure inline; never send
the person away with “Open the task to continue.” Task navigation elsewhere
is labelled **View task details** so it describes what opening the view does.

Status failures retain the last known work and label it stale. Never turn a
failed fetch into “All quiet.” Engine, quota, and activity-setting keys remain separate.

**Working** opens with the work on an engine right now, one row each with its
gezel's figure, its task or conversation, and **Stop**. **Next** opens with the
work waiting for a slot, in dispatch order, with move up, move down, and cancel.
These are the QueueMeter's rows, and each row replaces its activity entry so a
job is listed once; they are grouped under an engine's name only when more
than one engine has work. A person's request is the exception: its tracker
stands for every session working on it, so those sessions have no row of their
own. Row controls stay visible here, not
on hover only: the panel has room, and touch has no hover. Paused tasks, and
tasks in a paused project, are not listed. They will not run until someone
resumes them, and listing them buried live work under every paused shard.
The Tasks view is where paused work lives.

**The panel wears the three status colors.** Each section that holds work is
a zone of tinted paper in its status color (see "Three status colors"):
**Needs you** is ochre, **Working** is the accent and **Ready** is sage, the
workshop's green rather than `--success` mint. **Next** is work that is only
scheduled, which is not a status, so it stays on plain paper with a quiet
light: the nightly review is always waiting there, and a permanently lit
honey zone said something needed reading when nothing did. A small
indicator light leads each heading and each section key, and is lit only when
that section holds something. An empty section is one quiet line with no
outline, its heading and its note ("Nothing needs your attention.") side by
side: two empty boxes once stood between the person and the first thing with
work in it, repeating counts the section keys already show. So color on the
panel always means something to read. Working's light breathes like
the titlebar dot.

**The zone is the only box.** What a zone holds are flat rows parted by a
hairline of the zone's own tone. A question card inside it has no border,
fill, or inset strips of its own: a zone used to hold bordered cards that held
inset strips, three boxes deep. Keys and text fields inside a lit zone take a
paler tint of the zone instead of the panel's tan. A zone's wash, edge and
rule are mixed from its one status color in
[styles/activity.css](../packages/ui/src/styles/activity.css); the panel has
no colors of its own.


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

**A model list shows what each row is.** A provider sends a short model `name`
and, when the name alone does not say what the model is for, a one-line
`description`. The picker shows that line beside the row (`Select.Item`'s
`trailing`), never in the closed control, and the name never carries it as an
em-dash suffix. When a list mixes aliases that choose a model for the person
(Claude Code's `default` and `best`) with the models themselves, each row carries
a `group`. The picker heads each group with a `Select.Label` and sets the unset
row ("Gezel default") and Other… apart with separators, so no choice reads as a
heading. Models are listed from fastest to most capable, never alphabetically
by id. A badge every row would carry, such as " · reasoning" when every model
reasons, is dropped.

**Native `<select>`s share one face.** Every single-choice native select
takes the recipe in [styles/foundation.css](../packages/ui/src/styles/foundation.css):
brown with cream text in light mode, a panel-colored field in dark mode, and a
chevron we draw in a reserved right gutter, so a long value ends in an ellipsis
before the arrow. Never fall back to the platform's own select: Chromium on
Windows paints its arrow over a value too long to fit. A surface rule may change
a select's width or margin, but not its chevron, right padding, or colors; the
recipe's selector outranks ordinary `.surface select` rules for that reason.
Re-theme it through the `--select-*` tokens.

**Connected tabs, for a switch that fronts the surface below it.** The
default tab bar (`gz-tabs-trigger`) marks the current tab with an accent
underline and is right for a row of peer destinations. When the choice
instead swaps the *surface directly beneath the tab* — the project
composer's `@ Chat` / `> Terminal` switch, which replaces the whole compose
stack under it — use the connected treatment: top-rounded corners only, the
tab hanging off the bottom edge of its host row onto a seam, and the
selected tab erasing the pixel of seam it stands on so tab and panel read as
one surface. Selection is carried by that break alone. No accent stripe on
the tab's top edge: it reads as generic generated UI, and the join already
says which tab is open. A latched key fill defeats the whole effect, because
the panel the tab merges into is not tinted. Unselected tabs stay recessed
(`--tray-bg`) and keep all four edges. The seam is not optional — fill alone
cannot join anything when the tab's own row and the band below share a
background, which is how the first attempt read as a chip parked in the
address line. Reach for this only when the tab genuinely sits on the seam of
what it switches; a tab floating above unrelated content has nothing to
connect to and should be an underline tab or keys instead. Home's intro tabs
are the larger reference: there the host row is tinted a step off the panel's
fill, so the open tab reads as the top of the panel, and unselected tabs are
bare labels rather than recessed keys, which suits a row of named
destinations better than a two-way switch.

**A tab's scope picker sits beside that tab.** When one tab's content is
scoped by a choice the others ignore — the gezel screen's Chat, scoped to a
project — the picker goes in the tab row right after that tab, unlabeled, and
only while that tab is open. It does not get a row of its own above the
content. It keeps a fixed width so the tabs after it stay put when the choice
changes; a long value ends in an ellipsis.

**Tab rows fit by shedding labels, not by scrolling.** A tab row that
names where you can go must show every destination at once. The project
section tabs and the compact conversation tabs (Chat / Task / Skills /
Files) render through `FittedTabsList`, which steps down in three
stages as the row narrows: every label; icons with the current tab still
named beside its icon; icons alone. Labels win whenever they fit, so a
desktop window never shows an icon row it has room to spell out. An
iconified tab keeps its label as visually hidden text (its accessible name
never changes with width) and shows it in a tooltip on hover. The fit is
measured, not guessed from breakpoints: a hidden probe row lays out each tab
in all three faces with the live classes. So owner CSS styles a face through
the trigger's `data-face`, never the list's `data-fit`. Glyphs come from
`SectionIcon`; Tasks and Settings reuse the navigation rail's drawings so
one concept keeps one picture. To keep every section on a phone, an
iconified project tab may narrow below 44px wide, down to WCAG's 24px
minimum. It keeps the 44px height.

**Developer tabs belong to code projects.** Tools, Workspace and Artifacts
show by default only for a codebase (core's `projectHoldsCode`: a code
folder, a code-category type, a coding type, or a linked repository) and in
debug mode. The Views tab shows when a view fits a codebase, a watched
folder, or debug mode. A bakery's invoice project showed `package.json`,
prompt drafts and a code-city map beside its board, none of which it needed.
Hiding is only a default: an explicit choice in Project Settings → Project
tabs always wins (the boxes show the default), and the tab a person is on
stays visible, so opening a file into Artifacts never lands on a missing tab.

**The Connections tab holds what the project reaches outside itself.** Its
Connections section (the outside sources mirrored in, with the Lookouts that
act on a camera) and its Toolsets section (the tools every gezel here can
use) are drawn with the settings-page recipe. It shows for every project,
like Chat and Settings, because any kind of project can take a mailbox or a
toolset.

**Activity lists what happened to the work.** The Overview's Recent activity
and the History view ask for `audience: 'person'` outside debug mode: project,
document and task milestones, questions, proposals, reports and lookouts, and
the person's own threads, never the step sessions a task's crew worked in
(core's `PERSON_FACING_HISTORY_KINDS`). Tool calls, compiled prompts,
workspace writes and routing stay in the log, and History's kind menu offers
only the kinds it lists. Picking a kind shows that kind whatever it is, and
debug mode shows everything. The bakery's Overview had opened on eight rows
of tool calls and prompt sizes.

**Activity lines read as sentences.** The log's summaries are written for the
History view and the crew's `search_history`, so they carry task refs,
catalog versions and full folder paths. The Overview words them for a person
outside debug mode ([project-activity-line.ts](../packages/ui/src/views/project-activity-line.ts)):
"Finished "First draft"", "Set up as Freelance Office", "Project created for
the folder "Bakery"". The log keeps its own wording. An Overview promises the
map, folder notes and architecture summary only to a codebase (core's
`projectHoldsCode`): the bakery's invoice office was told they would appear
once indexing ran.

**Settings shows the developer areas an install uses.** Ollama, the OpenAI
Codex and Anthropic Claude CLIs, Remote servers and Shared Toolsets are listed
in debug mode, or once this install uses them: the provider is the default,
the night shift's, has a default model or saved settings; a server is paired
or this device shares its models; a shared toolset is installed. Nobody loses
a setting they rely on, and a bakery owner's Settings no longer opens with
seven engines. DwarfStar is listed only where the daemon can run it, from the
same facts its tab reads. Integrations always shows: Office and LibreOffice
setup is for everyone. Scripts joins the navigation with **Show advanced
features** or in debug mode.

**A tab can name its current choice and carry a menu.** The project
**Views** tab holds several views of one project (Village, and the views that
join it), so it reads as the view it last showed — "Village view" — with a
small decorative chevron after the label. Clicking it while another tab is
current only selects it, so it opens straight onto that view; clicking it
again, or pressing Enter, Space or Down while it is current, opens a
`.app-nav-menu` of the views with a check on the current one and a one-line
hint under each name. The tab stays a plain `Tabs.Trigger`: the menu
positions against `DropdownMenu.AnchorTrigger`, an inert span inside the tab,
because composing a Radix menu trigger onto a tab overwrites the tab's
`data-state`. The chevron is drawn in the label and both faces and in the
probe row, so the fit measurement includes it; icon faces drop it. With only
one view on offer the tab is a plain tab and opens no menu. On a phone, where
the tab shows only its icon, the panel under it names the view in a
"Showing" picker instead. The choice is saved on the project
(`selectedView`, like `outputPaneVisible`), never in localStorage; a view id
this build doesn't know falls back to the project's default rather than being
rewritten.

**Every view shares one inspector.** Selecting a file in any project view
opens the same right-hand pane (`FileInspector`) beside it: the name and path
with an Open key, the file's summary, the facts the view already knows (plus
chips only that view can say — the Village's town style, a pull request's
change), the findings tray, the Librarian's review card with its tracked
`BW-n` issues, and the file itself. A view adds to the pane through its
extras, never by forking it. The selection belongs to the Views tab, not the
view, so switching views keeps the file selected. The split is a fraction
with a grip (see Resizable splits); on a phone the pane covers the view as a
sheet with a way back that names the view.

**The Guide is the Village read aloud.** The **Guide** view, offered wherever
the Village is except picture folders, shows the index's overnight codebase
map (`GET /api/projects/:id/index/codebase-map`, the same data as
`reports/codebase-map.md`) as a reading surface. It has three parts: the
architecture note under "What this project is", a folder tree under "Where
things live" with each folder's purpose beside its name, and "What the rest
leans on", the most-imported files with "imported by N". Folder rows use the
Knowledge topic tree's disclosure (a chevron column that rotates a quarter
turn, `aria-expanded`, hover and selection on the whole row), and top-level
folders start open. An open folder lists its key files first, then its mapped
subfolders, and never repeats a subfolder as a file. Paths are set in mono at
`--text-xs` and purposes in muted sans, wrapping beneath the name on a narrow
pane. Selecting a file opens it in the shared inspector. Until the map is
written, the view says so in a sentence and doesn't show an empty tree.

**The Diagram draws what each file uses.** The **Diagram** view, offered
everywhere but picture folders, draws the project's files as boxes and their
imports as arrows, left to right from the file that uses to the file used.
Folders are the unit of reading:

- **Boxes.** A closed folder is one box that says how many files it holds,
  drawn with a second box behind it so it reads as a stack. An open folder is a
  frame around its files and subfolders. A chevron opens and closes either, and
  so does a double-click on a closed folder. A chain of folders holding only
  one subfolder (`packages/core/src` under `packages`) is one folder, and a
  package root takes its package name.
- **Opening.** Before the person chooses, folders open level by level, the
  shallowest first, while the drawing stays near 40 boxes: a small project
  opens all the way, and a monorepo opens onto its packages, few enough to read
  at a glance. What the person opens is remembered per project in this
  browser; Reset goes back to the default and Collapse all closes everything.
- **The camera.** A folder opened or closed stays where it was on screen while
  the drawing rearranges around it, so the person never loses their place. A
  whole new picture (Focus, a new focus file or depth, Code · Documents, Tests,
  Collapse all, Reset) fits itself to the canvas once it is drawn.
- **Arrows.** One arrow stands for every import between two boxes and grows
  thicker with how many it carries. Dashed means type-only imports, which
  vanish at build time. Two arrowheads mean the boxes use each other. Amber
  means the arrow is part of an import cycle, and a closed folder hiding a
  cycle takes the amber border.
- **Less to read.** A line a longer path already shows is hidden (the Hide
  shortcuts key), and a box nearly everything uses leaves its incoming lines
  out, says "Used by N" on the box, and is named in the status line. Neither
  hides a box.
- **Focus.** Double-clicking a file, or the Focus key with a file selected,
  shows that file with what it uses and what uses it, each followed 0–3
  steps. A box whose neighbors were left out carries "+k".
- **Toolbar.** Keys in trays: Overview · Focus; the focus depths; Code ·
  Documents (imports, or links between documents); Tests and Hide shortcuts;
  a Find box that keeps matching boxes bright and selects the first on
  Enter; Fit, Collapse all and Reset. A muted status line under it gives the
  file count, cycles, hubs left out, shortcuts hidden, and whether the index
  has resolved more than relative imports yet.

A file's box opens it in the shared inspector, and a file selected in another
view is brought into sight, inside its closed folder when it is closed. The
canvas is squisq's `DiagramViewer` (`@bendyline/squisq-react/graph`), themed
through its `--squisq-graph-*` properties from the app's tokens in
[diagram-view.css](../packages/ui/src/styles/diagram-view.css); the layout runs
in a worker, so a large drawing never freezes the window.

**Reports read in place.** The **Reports** view, offered on every project,
lists every report in the project's artifacts drawer — the codebase map, the
nightly codebase, documents and photos reports, code reviews, digests, and
what tasks wrote — grouped by kind with the standing map first, newest first
within a kind, each with a relative date and its count of suggestions. The
reader beside the list is the same document view Home's night review uses,
suggested actions live. A file a report names opens in the shared inspector
whether it is a link or a path in inline code; paths read as dotted-underlined
links and take the keyboard. **Write … now** runs a model-free report writer on
request, replacing the day's report, so a project never waits for its first
night; a folder that suits several reports gets the first as the key and the
rest in its menu. A report with nothing to say writes nothing and says so in a
muted line. On a phone the list becomes a picker above the reader. **Issues for
review** (the night shift's suspected problems, laid out for a coding app to
answer) sits right after the map and carries a key tray above the reader:
Copy, Save…, and Import answers…, with the import's outcome in one muted line
("12 answers imported, 2 not applied, 3 left empty").

**A gallery is shelves, not a wall.** The **Gallery** view, offered on every
project, shows the files as shelves of cards rather than one endless grid, so
a folder of thousands reads as a dozen groups:

- **Grouping.** Keys in a tray: Outings · Folders · Types, only the ones the
  folder supports. A picture folder opens on its outings (photos split
  wherever three hours pass without one), a code folder on its folders, and
  everything else on types. The choice is remembered per project in this
  browser.
- **Special shelves come first.** In a photo library, **Exact copies** (with
  the space they could free) and **Look-alikes** (bursts and retakes) lead,
  then each outing named by its day ("Sunday, July 14, 2024") with its hours
  underneath.
- **Cards.** A photo is its picture, square, with nothing printed over it.
  Any other file is a card: its type in muted small text with the file icon,
  its title (a document's own title, else its name), the first lines of what
  the index says about it, and its folder and age. The selected card takes the
  accent border.
- **Narrowing.** Filter keys (All · Photos · Documents · Data · Media · Code)
  show only families the folder holds, and a Find box keeps the files whose
  path, title, type or summary carries every word typed.
- **A page at a time.** A shelf shows two dozen cards and a **Show N more**
  key; more shelves come with **Show more groups**. A card opens its file in
  the shared inspector.

**The Timeline shows what changed when.** The **Timeline** view, offered on
every project, is a row of bars, one per week, month or year (Weeks · Months ·
Years keys; the default follows how long the history runs). A git repository's
bars count its commits' file changes, stacked by area of the project, at most
seven areas plus "Everything else"; any other folder's bars count its files at
their own dates, a photo when it was taken, stacked by kind. A muted line says
which. The colors are a fixed categorical palette named in a legend under the
bars, so color is never the only label: every bar's name says its stretch and
its counts. The bars open scrolled to the newest, take the arrow keys, Home and
End, and the newest busy stretch is chosen at first. Below them, the chosen
stretch lists its commits (time, subject, and the files each touched as links)
and then the files it changed most as Gallery cards; each opens its file in the
shared inspector.

**Integrations go out; Connections come in.** Settings → Integrations is
where Gezel is put to work inside other apps (editors, Office, command-line
tools). A project's **Connections** brings outside data, such as a mailbox,
into that project. Keep the two words to those two directions, and don't
call the Settings page "apps": that word already means Gezel's own AI Apps.
The apps that hold a grant are still "connected apps" in a sentence and in the
**Connected** list on the Overview tab.

**A settings page of several integrations gives each its own tab.**
Settings → Integrations opens on **Overview** (the master switch and the
apps already approved), then one tab per integration. Each tab shows that
integration's setup without a card frame, because the tab is already the
container (as on the flat provider pages). Anything waiting on the person,
such as a pending approval or a load error, sits above the tab row so every
tab shows it. Hiding
a warning behind an unselected tab is the regression tabs invite, so every
panel stays mounted and a tab whose setup needs action carries a small warning
dot (a true circle), with the state in its accessible name ("Codex, needs
attention"). Each tab leads with the product's own mark
(`ConnectedAppTabIcon`): in its brand color where it has one, and in the tab's
ink where the mark is black. A product with no published mark gets a plain
drawn glyph, never someone else's. The row wraps rather than shedding labels,
because several marks (OpenCode's block, pi's π) don't name their product on
their own.
Copy that points at another tab names it ("on the Overview tab"), never
"above" or "below".
An integration that works in both directions keeps one tab and stacks two
setups on it, each with its own heading and state chip: **Gezel's models in
Codex** (the app uses Gezel's models) above **Gezel's tools in Codex** (the app
uses Gezel's tools). The tab's dot reports the worse of the two. Their buttons
name what they act on ("Set up Gezel's tools…"), so the two setups never offer
the same label on one tab.

**Split buttons.** Use a split button when one creation action is the clear,
frequent default and two or three closely-related variants should remain
available without crowding the toolbar. The wide left key performs the default
immediately; the narrow attached right key opens a `DropdownMenu`. Join the
halves on one straight seam and keep `--radius-md` only on the outside corners.
Menu items should name the variant and may carry one short hint line. The Tasks
screen's New task / scheduled / Night Shift control is the reference.

**A menu never runs off the window.** Radix flips a panel to the other side
when it doesn't fit, but a list taller than *either* side — the chat rail's
Files menu grows with every file a gezel touches — still spills past the
edge, because Radix measures the room and leaves the clamping to CSS. The
shared `.app-nav-menu` panel takes
`max-height: calc(var(--radix-popper-available-height, 100vh) - 0.75rem)` and
scrolls; a menu that opts out of that class owes itself the same pair. Vertical
scrollers keep the native bar, so nothing else is needed — except in a Select:
Radix hides its viewport's scrollbar and opens scrolled to the selected row,
so in a short panel (a phone with the keyboard up) the rows above the
selection disappear without a trace. A Select that leads with actions passes
`openAtTop` to `Select.Content`; the compact thread picker does, which is what
keeps New thread on screen.

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
snap, never a sliver — never leave a pane too narrow to read. A collapse
reached only by dragging is one nobody finds, so the pane's own header also
carries a collapse key (a left chevron, "Hide … files"). The Workspace /
Artifacts file tree is the reference. A split may also hold a width for one
visit that it never stores: the chat rail's side pane goes wide for a result
opened from its finished-work card, with a **Wider** / **Narrower** key in
its header, and a drag of the grip starts from the width on screen and
returns to the stored fraction (see "The first request").

**A file opened from a link arrives with the tree folded.** A chat reference,
the night shift report, or a search hit names the one file the person came to
read, so the Workspace / Artifacts tab opens on the document with the tree on
its rail. The fold lasts one visit (`collapseTreeRequest` on
`FileBrowserPane`): it never writes the stored preference, expanding the rail
answers it, and leaving the tab or the project drops it. Picking a file in the
tree itself leaves the tree as it is.

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
issue badges, triage lists, and Librarian pane off the shared panel without
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
results marks the semantic ones with a small sentence-case **Related** badge
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

**A working document reads as a document, not a web page.** Squisq's
`LinearDocView` defaults to its page register: a centered cover hero set at
display size, the first paragraph lifted into a subtitle, and headings
auto-promoted into numbered bands and stat callouts by what their body looks
like. That suits an article; it turned a one-screen review into four
screens, with each `###` set at a different size depending on whether a
table or a list sat under it. Anything a gezel wrote for someone to read and
check (an artifact or file in the References rail, a task note, a night
review, a status report, a plan or a report attached to a question, the text
under transformation) renders with `variant="document"`. That gives a
left-aligned title over a hairline, one heading scale that follows the
markdown levels, a rule above each top-level section, the author's own lists
and tables, and a 15px base that every size scales from in `em`. A surface
that needs a smaller size sets one `font-size` on `.squisq-linear-content`
(task notes use `--text-sm`), never per-element overrides. The page register
stays where it is the point: Help and Knowledge articles and the Home
intro (all `.gezel-article-view`).

**A chat reply stays at chat scale.** A reply (`RenderedMarkdown`'s `chat`
register) renders in the document register too. The page register sizes in
`rem`, so the bubble's 15px base never reached it: a heading in a reply came
out near 32px, and a numbered list as a typed section with "01 / 02"
numerals. In a bubble a heading (levels 1 to 3) is one step of the type scale
above the reply's own text, 17px over 15px (`--text-lg` over `--text-md`,
written as 1.1333em so a gezel's font scale still applies), and deeper levels
are text-sized; 1.25em still read as a document title inside a bubble. List
numerals are the size of that text, a list the gezel wrote is a list, and a
top-level heading keeps the bubble's spacing with no rule above it
(`.msg-body-rendered` in
[styles/shared-content.css](../packages/ui/src/styles/shared-content.css),
pinned by `readability-guards.test.ts`). `RenderedMarkdown`'s `report`
register is unchanged.

**The pinned header covers what scrolls under it.** The sticky header at the
top of a conversation (the prompt being answered and who is answering) is
opaque, on the bubble's own paper. At 96% with a blur, the reply underneath
still read through it as a second, fainter sentence.

**A page's companion chat is that conversation only.** The chat a page
places beside its board (`PageChat`) shows the crew
member's ordinary threads and leaves out their task and plan threads
(`ProjectTimeline`'s `ordinaryThreadsOnly`). The project's kickoff task is
worked by the same crew member, and its thread opened the companion chat on a
"Step complete" card and a link to the page's data file.

**A board's dialog dims the companion chat; it never empties it.** The chat
is drawn by the shell above the page's frame, so a page dialog's backdrop
cannot reach it. The page reports the open dialog (`chat-position`'s `modal`),
and `PageChatSlots` lays the page's own backdrop color over the chat, cuts the
dialog's area out of it so the dialog is never covered, and lets clicks fall
through to the page until it closes. Hiding the chat instead left an empty
panel beside a dimmed board, which read as the conversation being lost.

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

At 560px and below, a gallery dialog shows as many rows as the screen allows.
Search goes through the shared `GallerySearch`
([components/GallerySearch.tsx](../packages/ui/src/components/GallerySearch.tsx)).
The field folds to a magnifier key, then opens on its own row when pressed,
and stays open while it holds a query. The header subtitle and the picker's
footnote drop out. Each card becomes one row: a 2rem mark, then the name,
then a single line of description, with the "Soon" stamp in line. Wider
dialogs keep the full cards and the always-visible field.

A starting point this host cannot run (a project type above the device's
model, or one that needs desktop-only tools) stays in the gallery, disabled,
with its reason in place of the description and an "Unavailable" stamp. Never
hide it: a person who saw it on the desktop should learn why it is missing
here, not wonder whether it exists.

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
from reading as two different dialogs: the full gallery keeps its size and
footer bar across both steps, the selection
survives going back, and nothing is created until the second screen (the
picker's footnote says so, and Enter in the search field must not submit the
form). Home starts skip the gallery and use the compact sheet described
above; a plan with nothing to ask also uses that single confirmation.

**Step 2 goes to one centered column when there is nothing to read.** Two
columns are for a selection whose brief earns one — a craftbook's steps, a
project type's crew and tooling. A built-in project kind's brief is a
sentence and two lines (`data-lean`), and New Task's blank card has none at
all (`data-blank`); a full-width column beside either leaves two-thirds of
the dialog standing empty. Both stack into one centered column instead, at
the same dialog size.

**A project type's questions never answer themselves.** A typed answer's
schema default is the stand-in the type's text falls back to ("the
business", "our home"), so the field starts empty with that default as its
hint, and a field left blank still creates the project with it
(`project-type-params.ts`). Prefilled, "the business" read as the person's
own answer. A currency is a list of codes with their names, starting on the
type's default, never a three-letter code typed from memory. Choices,
numbers and dates keep their defaults as values.

**A craftbook's input is a source picker, not a text field.** When a book
works *on* files (see [craftbook-inputs.md](craftbook-inputs.md)), its input
params come out of the generic parameter form and render above it, under a
"Works on" eyebrow, as `CraftbookInputField`
([components/craftbook-input/](../packages/ui/src/components/craftbook-input/),
`.gz-cbi-*` in [styles/project-surfaces.css](../packages/ui/src/styles/project-surfaces.css)).
Required sources go first because they are what the book works on. Optional
sources are inside More options. It is
a keys-in-a-tray choice — **In this project** / **From your computer** —
over one body:

- *In this project* opens an indented list of the workspace's folders (or,
  for a single-file input, its accepted files) with a filter once it is long,
  and answers a pick with one muted line: "notes — 37 files · 2.1 MB".
- *From your computer* is a recessed well — dashed border, `--radius-lg`,
  the same inset tone as a tray — holding *Choose folder…* / *Choose files…*
  keys, and it doubles as the drop zone; the border takes the accent while
  something is dragged over it. The upload starts at once, with a thin
  accent `<progress>` bar, and **Create waits for it** rather than racing it.

Files a book cannot use are never an error by themselves: they are left out
and counted in a collapsed "5 files left out" disclosure that lists each
with its reason. What *is* an error — nothing usable, or more than the book
can take — says so in one sentence and names the fix. The picker refuses an
oversize pick outright rather than quietly taking the first N files. A
scheduled launch disables *From your computer* with a tooltip saying why
(a schedule re-reads the project each run).

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

**Interests order; they never hide.** The person's interest areas
(`config.interests`, read through `useInterests`, mapped by
`interestAreasForCraftbook` / `interestAreasForProjectType`) put their work
first wherever work is offered, and every item stays reachable:

- New Task leads its rail with **For you** (the books serving the person's
  areas) and opens on it, except inside a project whose type recommends its
  own shelf. All plans stays one click away. The shelf is ordered for
  someone starting out, never by the alphabet (`orderForYou`): the welcome's
  first projects for those areas, then books ready to try (a starter, a
  sample), then the rest, and last what needs setup (a toolset to install, a
  connector to bind). Inside each group the first-picked area leads, and a
  book written for that area alone beats one that serves it through its
  category. Alphabetical opened a bakery owner's shelf on "A/B Ad Copy
  Variations" and "Audit Evidence Pack".
- A book's input picker adds a third key, **Try a sample**, when the book
  carries a sample for that input, with one muted line saying it is made-up
  example data. Never preselected, and never offered to a recurring run.
- The welcome offers **Browse plans for …** under its first projects when
  none of them serves an area the person picked; it opens New Task on For you.
  It disappears once a first project serves every pick.
- New Project orders its category rail and its sections by area, orders the
  types inside each section, and lands on the first category that serves the
  person. **All** is the first key of the rail.
- Home's Create tab draws its cards from the starters and the
  `first-project` books, the person's areas first, with one place kept for
  another area (`pickWithRange`) so a single pick never makes gezel look like
  it does one thing. Its project shelf picks catalog project types the same
  way.
- Knowledge offers **Suggested for you**: up to two catalogs per area, smallest
  first, each with its size and an **Add** key. Nothing downloads before the
  tap, catalogs about one place (a region's travel guide, one state's case
  law) are left to the full list, and the row is absent while the security
  policy keeps the app offline.
- The navigation rail's Workshop group starts open when the areas include
  `software`. That is a default only: the group is on the rail either way,
  and the person's own open or closed choice replaces it.

**The Plans area is for using plans first.** It lands on the person's own
plan when they have one; otherwise nothing is selected and the pane says what
a plan is and how to start one. An open plan's primary key is **Start a
task**, which opens the same launch form New Task does on that plan; **Copy
to edit** is secondary. A project's own plan runs only inside its project, so
it starts from that project's New task, not from here. The area used to open
on the catalog's alphabetical first plan in its step editor, with Copy to
edit as the only key.

**A plan this host cannot run is shown with its reason.** New Task lists a
craftbook the phone cannot run as a disabled card whose description is the
reason (`craftbookHostGap`: "Splits into many smaller tasks, which needs the
desktop."), the way New Project already treats a type. It never becomes a
launch that fails, and it is never one of Home's suggestions or the For you
shelf.

**Questions with an attached document.** When a pending question carries a
document — a night-shift report, a draft plan — the document is not a
ten-line teaser stacked above the answer keys. `PendingQuestionCard` lifts
it into its own right-hand column (`.pending-question-split*` in
[styles/project-surfaces.css](../packages/ui/src/styles/project-surfaces.css)):
the card and its actions on
the left, the whole document as a portrait page on the right, scrolling in
place. `.pending-question-splitwrap` is a named `question-card` query
container, so the same card falls back to one column in a narrow chat
bubble and the panel keeps its own scroll there. Three rules travel with the
pattern: the document's own `#`/`##` headings are pulled back to panel
scale (a report title must not out-shout the question it belongs to); an
*answered* card — which collapses to one line — stays single-column,
because a full-height panel beside one sentence reads as broken; and the
page fills its frame. Squisq paints its own reading surface, so the page
reaches the frame's edges under the header row (`Artifact · name · Open`)
and keeps its margins inside, never as frame padding that shows tan bands
beside the page. The same holds for the previews in the context strip and
the draft plan card.

**A question card has one filled action.** Submit is terracotta; Skip,
Open in chat and Pause task take the secondary face
(`.pending-question-skip`, `.pending-question-open`), and Cancel task takes
the danger face (`.pending-question-cancel-task`). The task steers sit behind
a hairline as their own group. A card that rendered five equal terracotta
buttons made ending the task look as ordinary as answering.

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

**A task rides above the message, not in the toolbar.** When a message will
start a craftbook task — because the person picked one, or because the
daemon's route preview proposed one from the text — the composer shows it as
a strip spanning the composer directly above the To line
([`ComposerTaskBar`](../packages/ui/src/components/ComposerTaskBar.tsx),
`.chat-composer-task-bar*` in
[styles/shared-content.css](../packages/ui/src/styles/shared-content.css)):
the craftbook's artwork in a small `--radius-md` tile, an uppercase eyebrow
(**Task**, or **Suggested task** with the routing spark), the book's name, a
one-line readout of its parameters (`topic: France · audience: executives`,
at most three entries then `+N more`, inputs first as `source: Notes (3
files)`), and one dismiss key. The strip's face is a button: it reopens the
New Task dialog on that book's configuration with every value restored. A
suggestion draws the same strip **dashed**, so a proposal reads as tentative
beside a pick, and dismissing it is remembered for that text — the daemon is
told not to re-derive the route when the plain message goes. This retired the
read-only sparkle chip in the toolbar, which showed the route and could not be
acted on.

**A direct image gezel's settings ride above the message the same way.** When
the composer is addressed to a direct (fixed-function) image gezel, the image
strip
([`ComposerImageSettingsBar`](../packages/ui/src/components/ComposerImageSettingsBar.tsx),
`.chat-composer-image-bar*` in
[styles/shared-content.css](../packages/ui/src/styles/shared-content.css))
sits where a task strip would, in the same frame. The image strip holds:

- a compact tray of shape keys, each a ratio label beside a small rectangle
  drawn in that ratio (1:1, 4:5, 3:2, 16:9, 9:16), with "More" for the rest;
- a Draft / Standard / High tray;
- a model picker when more than one model is installed;
- a Style picker, starting at "No style", only when the chosen model has a
  style installed; picking another model drops a style it lacks;
- a one-line readout of what will render (`9:16 · 768×1344 · FLUX.2 Klein`),
  ending with the style when one is picked.

Shapes and tiers, never pixel fields: a person thinks "phone wallpaper", and
the daemon turns it into the model's own trained size. The strip follows four
rules:

- **Picks persist.** They persist through a send, so a set of wallpapers
  needs no re-picking, and they ride on the prompt draft.
- **Settings the message names win.** When the message itself names a
  setting ("9:16", "as a phone wallpaper", "hi-res"), the strip latches it
  and turns **dashed** with the eyebrow *From your message*, because the
  daemon will read the same words. A **Use as typed** key sends the words as
  part of the prompt instead. Pressing any key also counts as the person's
  answer.
- **High never offers a render that won't fit.** It is disabled, with the
  reason in its title, when the larger size will not fit this machine.
- **No strip in a task thread.** The direct gezel's About tab sets the same
  shape, size and model as defaults, with the raw JSON behind an *Advanced*
  disclosure.

**The tools beside Send are flat toolbar keys.** Narrate, the sparkle key,
its Undo, and Task wear Squisq's toolbar face (`.squisq-toolbar-button` plus
`.chat-composer-tool-btn`), the same flat key as Insert image and Attach file
at the row's other end: no border or fill at rest, a wash on hover. Send is
the only raised key on the row. A held key dims; a key busy with its own work
(`aria-busy`) keeps its face. Each is a glyph with `title` + `aria-label`,
except Undo and a busy label, which take the word variant
(`.chat-composer-tool-btn-word`).

**The sparkle key rewrites the draft, never the thread.** Beside Task and Send
sits the sparkle key (`.chat-sparkle-btn`, the routing spark as its face) that
opens a small menu:

- *Make it clearer*, *Shorten*, and *Fix spelling and grammar*;
- *Review my message*;
- *Shape for <model>*, only when the message goes to a direct image gezel whose
  model reads sentences. Shaping for a tag model (Animagine) lost counts in
  the image bench, so it is not offered there.

Every action lands in the composer, where the person reads and edits the
result before pressing Send themselves. Nothing is sent and nothing reaches
the transcript. The key's face reads *Rewriting…* while it works. After a
rewrite an **Undo** key beside it puts the words back, until the
person types again. A review changes nothing on its own. Its two or three
suggestions appear in the task strip's frame above the To line
(`ComposerReviewStrip`), with *Rewrite with these* and a dismiss key. A
failed or unusable answer leaves the draft as it was and says so in the
composer's error line. An answer identical to the draft is not a failure. It
shows a muted *Already reads well. Nothing changed.* beside the key until the
next edit. The prompt text and parsing live in core `prompt-assist.ts`.

**The strip names a sample and offers the person's own file.** A starter that
launches on a book's bundled sample reads `source: a small shop's monthly sales
(sample)`, the book's own title for it, never a generic "the sample", and that
entry is never clipped, so "(sample)" always shows. An input that a sample
fills, or a required one that nothing fills yet, gets a `gz-key` beside
Tonight: **Use your own file…** / **Choose file…** (*folder* for a folder
input). It opens the system picker filtered to the types the plan reads and
uploads into the task's input staging, exactly as the dialog's "From your
computer" does. It is not the composer's paperclip, because message
attachments never reach a task's inputs. While it uploads, the key counts
progress and Send waits. A refused pick replaces the readout line with the
reason. A source the person chose themselves gets no key; they change it in
the dialog.

**Task is a glyph key beside Send, offered only on a fresh thread.**
Its face is the checklist the Tasks area uses in navigation
(`AreaIcon area="tasks"`), so a task looks the same wherever it is offered.
The key attaches a craftbook to the message; it never fires one. Send stays
the single terracotta glyph, and with a task attached it still means *this
draft goes now*: the task starts, the message becomes its brief (the words
land in the thread with a Plan-started receipt), and an empty draft is
allowed because a configured book is a complete request on its own. The key
(`.chat-task-btn`) never appears
on a reply to an existing thread, inside a task pane, or mid-turn — a task is
how a conversation *starts*, not something bolted onto one in progress. Which
is why the Meester home opens on a fresh thread at launch rather than
auto-picking the newest one: the front door has to show the key. A thread the
person was just in (a navigation away and back) is still restored. The
dialog's compose mode ("Task for this message", submit **Use in chat**) shows
the message so far as a read-only *Brief · from your message* block: the chat
box is the one place the words are edited.

**Enter submits; Shift+Enter adds a new line.** Chat and terminal share the
same primary-key convention: Enter commits the draft, while Shift+Enter keeps
the cursor in the composer and inserts a line break. Each composer says so in
the primary key's `title`. Chat delegates the split to Squisq's
`submitOnEnter` hook, which preserves the editor's mention-picker handling and
lets Shift+Enter reach the normal paragraph-break behavior.

**The draft can take the window.** An icon key at the right end of the To
line — past the recipient picker and immediately before the compose-mode
tabs, so the frame's size control sits with the frame's other keys rather
than crowding Send — toggles the composer between its two-line strip and
the top ~80% of the chat column, because a brief or a PRD is unreadable
through a slot and scrolling it inside the slot loses the shape of the thing
being written. The size belongs to the frame, not to the mode: terminal mode
carries the same key on the same pixels of its toolbar, and flipping between
chat and terminal keeps the frame expanded or collapsed as it was.
It is a size change, not a mode: the To line, the toolbar, and every key
stay exactly where they were, the transcript keeps the remaining fifth
rather than disappearing, and the draft, its attachments, and its autosave
are untouched by the flip — so the toggle is never a decision, only a
preference for the next minute. Expanded, the editor *fills* its frame
instead of growing with the text; an empty box that filled as you typed
would put the caret somewhere different on every keystroke. The glyph is
chevrons pushing apart, closing back together once expanded, and carries
`title` + `aria-label` + `aria-pressed` like every other icon key. It and the
recipient picker's **+** are flat keys, like the tools beside Send: no fill
or border at rest, a wash on hover, and the wash stays while the picker is
open or the draft is expanded.

**At rest the draft is two lines.** Collapsed, the editor rests at about two
lines (`minHeight` 104px with its toolbar, and the terminal's command entry
matches it through `--compose-entry-height`) and grows with the text up to
half the window. At three lines a 1280x720 window gave the composer about
200px and the conversation about ten lines.

**One hint per place, and it names the crew member.** The empty draft's
placeholder is one fixed sentence for each kind of conversation
(`pickChatPlaceholder`): the meester's front door, a project's crew lead, any
other crew member, and a direct generator's directive copy. It is never a
random pick: re-rolled each time the recipient's details loaded, one Home
visit showed five different hints. Hints and empty-thread lines use the
crew member's name and no pronoun, because a gender that had not loaded yet
made the same meester "them" in one hint and "her" in the next.

**An unsent starter is not a thread.** While the composer holds a draft that
no thread owns yet (a welcome starter, say), the thread picker's trigger says
**New thread**, where the message will go. It used to show the draft's row,
"Plan a trip to Kyoto… · 1m ago", which read as a conversation already had.
The draft keeps its row under *Not sent yet* in the menu.

**A held composer says the same thing everywhere.** While the first model
downloads, a crew member's chat reads the daemon's install list and says
"Can't send yet: downloading the AI model · 42%" in Home's words
(`modelInstallStatus`), with **Get started** still leading to Home. It used
to say "no AI model is downloaded" while Home said the download was running.

**Take photo is the camera's one door.** The composer toolbar's camera key
sits between Insert image and Attach file and inserts `![Photo](…)` into the
draft, like the other two. A phone opens its own camera
(`<input capture>`): the system camera is better than anything we could
draw, and the person already knows it. A desktop gets a small viewfinder
dialog ([`CameraCaptureDialog`](../packages/ui/src/components/CameraCaptureDialog.tsx)):
live preview, one shutter press, then a still to Retake or Insert. The key
appears only where a camera exists. The camera runs only while its preview
is on screen: it stops on the shutter press, so the indicator light never
outlives what the person can see. (A camera connected to a project to *watch*
a room is the deliberate exception; see "Watching cameras" below.) Photos are capped at 2048px on the long
edge and re-encoded, which also strips a phone photo's GPS metadata before it
reaches a prompt. When the model cannot see images, the message carries a
warning saying so; never let the person assume a gezel saw a picture it only
had the name of. On a phone the photo is read on the device before the model
runs (labels and text always, a description where a describer is ready), and
the warning names what was missing: only labels, or nothing. Settings → AI →
Photos is where a describer is fetched; a chat turn never starts a download.

**Watching cameras.** A camera connected to a project (Connections → Webcam)
watches continuously, so watching must always be visible and stopping it is
one click. While any camera is on, the titlebar shows a "Camera on" pill
(`WatchingIndicator`, using the titlebar key recipe with a danger-red dot);
its menu pauses each camera where the person noticed it. The camera's card
shows a small live view that refreshes only while the card is on screen and
is served from memory, a status line in plain words ("Something is in view.",
"Paused.", "Another app is using the camera."), and Pause/Resume, Settings,
Remove. Setup uses keys in trays for *What to keep* (stacked keys with
hints) and *Motion sensitivity*, a range for the 1–60 s interval, and plain
checkboxes for the two consent-shaped switches (recognize what's happening;
let cloud AI see the pictures, off by default). Removing a camera says that
its saved pictures go with it.

**Lookouts are sentences.** A lookout is built as the sentence the person
would say — "When [Mud room] sees [Anything moving | A person | A pet |
Something specific], then [tell me] [play a sound] …" — never as a trigger
form. The watch-for choice is a tray; *Something specific* opens a yes/no
question field with "only when it is clearly happening". Actions are
checkboxes, each opening its own small field (a clip tray, a line to speak,
recipients). Names and limits sit in a closed disclosure. A lookout row reads
back the same sentence, then a `role="toolbar"` tray of verbs (Turn off ·
Test · Snooze 1 hour · Edit · Remove; Approve in accent ink for a gezel's
proposal). The *Recently* list pairs each firing's keyframe with what each
action did and, when held, why — in plain words — plus *Not this*.
A lookout alert while the app is open is a bottom-right toast with
*Stop sound* when a sound is playing; it never replaces the OS notification
when the window is not focused.

**Mid-turn composer actions.** While a gezel is working, the composer keeps
accepting text. With an empty draft the toolbar shows only the quiet
secondary `■ Stop`. The moment there's a draft, two actions join it:
**Nudge** (primary — reuses the Send recipe so terracotta stays on the one
primary) queues the text for delivery when the turn ends, and **Interrupt**
(secondary) stops the turn and sends immediately. The send gesture
mid-turn means Nudge, Escape means Stop. Queued nudges render in the timeline as the
existing dashed ghost bubbles ("⋯ nudge") with Edit / Discard / Cancel
current turn actions — editing swaps the preview for an inline textarea in
the same dashed not-yet-sent vocabulary and never opens a dialog. A user
message that was delivered from the queue carries a small **Nudged** badge
(`--text-2xs`, `--radius-sm`, sentence case) after "You". Stop never
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
small **Automatic** badge (the neutral sibling of Nudged — same
`--text-2xs` / `--radius-sm` recipe, `--border` instead of terracotta) and
drops to the panel tone, because the terracotta fill *is* the signal that
words came from the user. The rule travels to every author label, not just
the bubble: the sticky scroll header renders the same verdict, and a new
one must too. Cross-gezel messages are a separate case already answered by
`from` — they keep the "Aldric → Maya" handoff bubble.

**What a delegate made travels with its reply.** A delegation's reply reaches
the sender's chat as words, but a picture the delegate made belongs to its own
tool call. The relay carries it as `relayedImages`, and the handoff bubble
shows it in the same media strip a tool call uses, with the same menu, so the
person sees it in the chat they are in rather than only in the delegate's
thread.

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
few cards into one counted line rather than burying the conversation. Its
key reads **Open task**; the task's id appears only in debug mode.

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
(`advance_task_step`) — or the composer launches an attached task directly,
which the daemon records as a synthetic `craftbook-launch` assistant turn
shaped like that tool call — the transcript renders an inline card under the tool
row ([`ToolCraftbookCard`](../packages/ui/src/components/ToolCraftbookCard.tsx),
`msg-tool-card-*` block in [styles/chat.css](../packages/ui/src/styles/chat.css)):
the craftbook's workshop-mark artwork in a small `--radius-md` tile, a
sentence-case eyebrow in the accent ink (Plan started / Step complete), **one sentence**, the
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
and its action **deep-links to Settings → Security & compliance** — a
security switch is never flipped from inside chat.

**One card per task per conversation.** A model that re-invokes a plan it
already started gets an idempotent "already running" receipt each time, and
every step advance stamps another card; one invoice request read as three
identical "Formatted Report is underway" cards in a row. Outside debug mode
the earliest card shown for a task stands for it
([craftbook-card-dedupe.ts](../packages/ui/src/components/craftbook-card-dedupe.ts)).
Later cards for the same task keep only their plain row inside Details. The
earliest wins so that a bubble the person already read never shrinks above
them. A Working notes fold keeps its own cards, because it is the full
transcript, and debug mode shows every card. The chip reads **Open task**;
the task's id is debug-mode text.

**Work that made something ends on the thing it made.** A PowerPoint run
used to end on prose: a wrap-up listing six paths newest-write-first, and a
reviewer's reply naming `powerpoint/task-13/deck.pptx` as unlinked code. The
deck the person asked for was the fifth item, under "…and 3 more". The
deliverable is now a card
([`DeliverableCard`](../packages/ui/src/components/DeliverableCard.tsx),
`.deliverable-card*` in
[styles/shared-content.css](../packages/ui/src/styles/shared-content.css)). It
has a format tile, an uppercase eyebrow naming what the file is ("Your
PowerPoint deck"), a main line at reading size, and a muted line beneath. The
card names the work, not where it is stored. With a `title` (what the person
asked for, core's `taskPersonName`; the request tracker passes
`RequestTrack.title`) the main line is that title and the muted line reads
"report.docx · 15.8 KB · 2m ago". Without one the file's name is the main line
and the muted line is its size and age. A catering proposal used to read
`report.docx` over "In the artifacts drawer · tasks/2 · 15.8 KB". The path is
never text on the card: it is the file name's tooltip, and *Show in folder*
answers where the file is. A board's main line is its project's name and its
muted line reads "Opens in the project". **Open** is the one filled key. *Show
in folder* and *Save a copy…* are secondary keys, shown only where the desktop
shell provides them; with a title, the save dialog offers the title and the
file's extension as the name (core's `saveCopyFileName`, run again by the
shell), not `report.docx`. The whole
face opens the file too: it is the big link. The card closes the wrap-up
bubble and sits under the task tracker in the chat rail. On the task page it
sits directly above the Task/Chat tabs in their narrow column, to the left of
the step tracker, so each tab joins directly to its panel. The card stays within
the two tabs' combined width, with a smaller format tile and file name; the
size, timestamp, and repeated extension label are hidden. Open keeps
its label; Show in folder and Save a copy use icon buttons with tooltips and
accessible names. On a receipt that finished its task, it shrinks to a one-line
chip beside the task chip. The task page's overview lists every other file the
task made under **Other files** (**Files** when there is no deliverable), one
row each that opens it, folded after eight: the Ready card's "…and 3 more"
sends the person there. The wrap-up beside the card leaves the deliverable,
its path and every working file to the card and the task page; it says only
what was checked, what the maker asked, and what to do next (see "Ready is
the file"). A bakery's wrap-up once read "All done — **Formatted Report** is
finished" followed by three paths. The card's main line is the person's own request: a task
started from chat is titled with it (core's `deriveTaskTitle`, "Write a
one-page catering proposal for Harbor Books…" is the task "One-page catering
proposal for Harbor Books"), where it used to carry its plan's name. The
title is the thing asked for: it ends at the first colon or comma,
loses a closing date ("on December 12") before any word of its subject, and
is cut with an ellipsis only past 72 characters. A task title
that is only the craftbook's name is never said (core's `taskPersonName`): the
wrap-up, the Updates card and a step's closing line fall back to the file's
kind or "It is complete." Three rules keep it honest:

- **The daemon decides what the deliverable is, and only a file that exists
  gets a card.** The resolver lives in
  [task-deliverable.ts](../packages/core/src/task-deliverable.ts). It picks the
  most finished-looking file the book's own gates name, prefers later steps,
  and never picks a working paper like `outline.md` or `review.md`.
- **A running task's copy is a draft.** It gets a dashed border and the eyebrow
  "PowerPoint deck · in progress", because the tracker may point at the product
  before the last step signs it off.
- **A path in prose links only when the daemon has verified it.** The same holds
  in chat replies, in task notes, and in question cards (Activity, Home, chat).
  When a reply names a file the workspace index has not caught up with, the
  daemon checks it directly on disk, within a fixed limit; a card's paths are
  always checked that way. It never guesses from a same-named file. A file
  opened from a card opens in its own project (a finished card filed in the
  meester's thread lists the task's files), and a host floating over the app,
  Activity or the project questions dialog, closes so the file is in view.

**Finished work is "in the project".** One result was "in the artifacts
drawer, tasks/2", "in the project folder" and "on the project's Output page"
in three places a person read it. Where a person reads about finished work
(the card, the wrap-up, the Updates card, a review card's file list) it lives
in the project, and nothing names the drawer: a board's card reads "Opens in
the project", its Updates card "is ready to look at in the project", and a
listed path is a link that opens the file wherever it is. Which drawer holds
a file is the model's business, so the note a wrap-up leaves for the model
still says "(in the project folder)". A written document's cover shows its
words, not its markup: a table row reads as its cells ("Monday · Ovens"), and
rules, table dividers, comments, code and pictures are left out.

**A cited fact shows its source; an unsourced one is said out loud.** A
gezel writing in factual mode (see [factual-writing.md](factual-writing.md))
cites its evidence as `[n]`. In the bubble each marker is a small raised
link, like a footnote mark, so a cited paragraph still reads as prose.
Clicking a marker opens what it names: a knowledge passage in the Knowledge
area, a web page in the browser, anything else in the reply's **Sources**
row. That row is one collapsed line under the reply ("2 sources · 1
statement to check, marked above") and opens to the numbered sources with
their excerpts. A reply's sources are counted and numbered from what that
reply cites (`replySources` in `citation-linkify.ts`): the first source it
cites reads [1], one file is one source however many of its passages were
cited, and what the turn read but the reply never cited is not listed. The
daemon numbers evidence across the whole session, so a first answer about
one file read "[13]" under "13 sources". A reply that cites nothing lists
what its turn read. Statements no source showed sit at the top of it in a
quiet warning tray, as plain words without markdown or `[n]` marks, with the
missing detail named, never in red. They are a reason to check, not an
error. A marker whose number is not a source stays plain text, because a
link to nothing is worse than no link.

**A reply's machinery waits behind Details.** Outside debug mode, the step
count, step timings, thinking and attempted-call expanders do not head a
reply: the reply's action row carries a **Details** key that shows them and
stays accent-tinted until it puts them back. The row's keys are icons with their
words in the tooltip and the accessible name: Copy (two squares), Details (a
list of steps), Save (a floppy disk), and, once saved, Open (the artifacts
drawer, where the reply went). What the person needs stays in view without
the key: media, cards, and a failure the turn never recovered from. Debug
mode shows everything, as before, and open conversations follow the switch
at once rather than when they are next opened. A task's id (`lisbon-trip-planning/1`) is
debug-mode text too: the hand-off, craftbook and queued-task cards' keys
read **Open task**, the chat rail's task card leads with its title, a
session divider leaves off "· task …", and no reply carries a "Tasks:" row
outside debug mode. A wrap-up never carries a "Files:" row either. Its
finished card, in the bubble or in the request's tracker, already opens the
deliverable, and the row only added the drafts that went into it; a wrap-up
without a deliverable links what was made in its own words. Status chips that remain (a task's
**Complete**, **Draft**) take their colour from `--success` / `--warning`
mixed into the surface, never a pale grey that reads as disabled.

**A live turn follows the same rule.** While a reply is still being written,
its thinking, tool rows, the call being written and the "· N tools" count
stay behind the live bubble's own **Details** key outside debug mode. Long
local turns used to stream all of it into the conversation for minutes,
which made the machine room the progress signal. What remains is the
status line, the thinking dots, and one plain line for a call being
written ("Writing file…"; a tool with no curated label reads "Working…",
never its slug). Cards, media and an unrecovered failure sit above the
body, where the finished reply keeps them, so nothing moves when the turn
commits. A failure whose reason is a machine payload (a JSON envelope, a
stack trace) reads "didn't finish. The steps have the full response." The
raw text stays behind Details. Audio a folded reply produced joins its media
strip, so hiding the steps never hides a recording.

**A thread is titled from the sentence.** A thread's title is the person's
first sentence with its lead-in ("Can you", "Please", "I'd like you to")
dropped, cut at a clause or a word boundary with an ellipsis: "Plan a trip
to Lisbon next spring for the four of us", never "Lisbon spring four trip".
A page reaction keeps its page's name as a prefix ("Checkers: Your opponent
played c3-d4"). See [thread-title.ts](../packages/core/src/thread-title.ts).

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
[styles/catalog.css](../packages/ui/src/styles/catalog.css)):
an instruction
field, a "Transform with {Scribe}" row that shows the Scribe's poppetje
pulsing plus a quiet live metacommentary feed while the model works, and a
result area toggling (bare key tray) between an editable Before/After view
and a Monaco diff. Nothing touches the document until the user presses
Apply; Cancel/Escape discards everything. With no selection the dialog is
in insert mode — the instruction becomes required and the result is added
at the cursor. This is the pattern for any future "AI proposes, user
disposes" text surface: preview + explicit commit, never in-place mutation.

**Catalog artwork: Workshop Marks.** A craftbook's or project type's mark is
one bold cut-paper subject that names the job: a sieve for a data-quality
audit, a card-catalog drawer for a data dictionary, merging rails for a pull
request review. It is built mainly from cream papers with charcoal details and
dull brass where the object is metal, with nothing under it: no book, card,
clipboard or magnifier. Gilde ships it as a transparent 512×512 WebP with the
subject trimmed and scaled so its longer side is 88% of the tile, which leaves
the same clear margin on every mark. The app paints the ground: `CatalogArtwork`
takes a `ground` from `catalogGroundFor` (core
[catalog-ground.ts](../packages/core/src/catalog-ground.ts)), which maps the
item's category to one of nine `--gezel-ground-<tone>` papers. Every code
shelf has its own tone, other shelves share a tone with a distant code shelf,
and dark mode deepens each tone. A shelf in the rail therefore shows one
ground, and the subject alone tells its books apart, so subjects are chosen
per shelf so no two neighbors share an object. The ground goes on the image
element, so the caller's size, radius and clipping still apply, and an older
opaque mark simply covers it. Marks must stay recognizable in the 44px gallery
crop. Catalog image renderers must replace missing or failed assets with the
surface's category glyph or initial; never expose the browser's native
broken-image placeholder. In a card grid, an item with no mark of its own
(a built-in card, a type Gilde ships without art) paints its glyph in cream
on its category's ground, through `catalogMarkProps` in
[CatalogArtwork.tsx](../packages/ui/src/components/CatalogArtwork.tsx), so the
grid stays one family of full-bleed painted squares. A pale tile with a thin
terracotta line icon beside the painted marks read as two products in one
row. Each rail shelf keeps its own glyph; three shelves sharing the sprout
made the rail's icons say nothing.

**Knowledge catalog artwork: Reference Marks.** Knowledge catalogs get the
Workshop Marks' sibling: the same cut-paper construction, built as a single
paper-crafted emblem of the subject (a loaf and pitcher for Food & Drink, a
ringed planet for Astronomy), on the marks' own parchment ground.
The subject alone fills about 80% of the tile, with nothing under or behind
it. These marks are drawn at 24 and 56 px, and an earlier version that stood
the subject on a cloth-bound book left the subject unreadable at that size. The
subject carries the catalog's one muted accent. No magnifier: that is the
craftbook shelf's tool. Gilde ships
the mark as the catalog's `logo.webp`, with an `art.json` recording the subject
and accent; the service passes it to installed catalogs as
`KnowledgeCatalogStatus.logoUrl`, and the bundled Help's mark ships with
the UI. `KnowledgeCatalogMark` is the one rendering: a `--radius-md` tile at
24, 34, or 56 px, with a book glyph for catalogs that have no artwork. The
Knowledge rail shows the 56 px mark beside the catalog's name and the 24 px
mark in each picker row, which is why that picker is the Radix `Select` and
not a native `<select>`.

**Knowledge opens on the person's catalogs; Help has its own door.**
The Knowledge area lands on a catalog the person added before the bundled
Help (`preferredKnowledgeCatalog`), and on its overview: the topic rail
and list beside a reader that says how to search and read it. Only the
Help area opens Help on its welcome article, and that area never
writes the Knowledge door's remembered place; they share `KnowledgeView`,
and reading Help used to make Knowledge open on "What is gezel?".
With only Help installed, the overview offers **Browse knowledge
catalogs**. An article's title is shown once, in the reader's header: a first
`#` heading that repeats it is dropped (`withoutRepeatedTitle`).

**Catalog management opens over the Knowledge browser, not in Settings.** The
rail's add key opens `KnowledgeCatalogsDialog`, which hosts the same
`KnowledgeCatalogManager` that Settings → Knowledge shows. Changing what is on
the shelves is part of using the library, so it should not move the person to
another area. Installs announce themselves, and the rail picks each one up
while the dialog is still open.

**A long directory scrolls as one list, with an A–Z index pinned beside it.**
The Knowledge document list has no "Show more" step to press: pages load as
either edge comes within reach, so the list can open in the middle and still
scroll to both ends. It opens on the article being read (returning to the
view, or to the list on a narrow screen, lands where the person was) and on
the top of a topic they just picked. An alphabetical listing longer than a
page gets `.knowledge-letter-index` down its left edge: `#` then A–Z as plain
`--text-2xs` letters, not keys, since it is a ruler rather than a choice.
The column's header and the index stay put; only the list moves. A letter
with nothing under it stays in place, dimmed, so the ruler keeps its shape,
and the letter at the top of the viewport takes `--accent-text`, which is
the landing cue for a jump. Curated listings (Help's) are not
alphabetical and get no index.

**A media hit says what matched and opens on it.** A search hit on a photo, a
clip or a recording reads `Photo`, `Video · 1:30–2:00` or `Sound · 0:00–0:30`
(`mediaSpanLabel` in core, the one wording for every surface). In the titlebar
it leads the muted subtitle; in the Knowledge results it is its own muted line
under the title, and a photo also gets a 3rem `--radius-sm` thumbnail beside
the text. Opening a hit lands on the moment: a workspace file's player starts
at the matched window, and a catalog hit opens its article with the media in
a bordered `--radius-lg` figure above it, the asset's credit in the caption.
Players start where the hit matched, never at 0:00 with the time left for the
person to find.

**Unreviewed catalog entries say so.** The toolset catalog mixes a handful of
entries Gezel ships and reviews with thousands imported automatically from
the public MCP registry, and the two must never look like more of the same.
A community-tier item (`sourceId === 'community'`) carries a small
**Community** badge after its name — the neutral badge recipe shared with
search's Related and chat's Automatic, never a warning colour, because
an unvetted entry is usually fine and the badge is provenance, not alarm —
plus a "Shared by *maintainer*" line, since "install only what you trust"
is meaningless without a name to trust. Three rules travel with it. Reviewed
entries rank ahead of community ones in every list
(`reviewedBeforeCommunity`), while community entries stay searchable. The
explanation is visible text, not only a tooltip: any list showing a
community entry carries one muted line saying what the badge means. And the
moment a community toolset asks for keys — its config form — repeats the
caution as a `warning` line, because that is where a wallet tool would ask
for a private key. The helpers and copy live in
[catalog-provenance.ts](../packages/ui/src/components/catalog-provenance.ts);
`CommunityBadge` is the one rendering of the badge.

**Embedded Help pages.** When a surface needs explanatory copy that
also belongs in the documentation, don't hardcode the prose — embed the
Help article (`LinearDocView`/`DocPlayer` + `createHandboekMediaProvider`,
with the shared `GEZEL_LIGHT_SURFACE` overlay in light mode) so the pitch and
the docs never drift. The Home "What is gezel?" embed
(`IntroHandboekArticle`) is the reference implementation: a cream page
resting on the card, a Read/Watch key tray, and an "Open in Help →"
link that lands on the same article.

**Loading states.** Routine view transitions, local reads, and lazy-loaded
editors stay wordless while pending. Use an empty surface or retain the pane's
frame; don't flash "Loading…" prose or show an empty-state claim before the
request has answered. Keep refresh and pagination button labels stable while
their controls are disabled. Use `aria-busy` on retained surfaces and keep
screen-reader-only status text where it helps. Longer operations such as
downloads, model preparation, and generation still need meaningful progress;
prefer inline `muted` text over blocking spinners. A pulsing icon (see
`.gezel-icon--pulse`) is the canonical "this thing is working in the
background" signal. When a surface needs to tell two working *phases* apart,
it may use a small themed glyph per phase — a quiet 16px figure on the
muted ink with a single moving accent stroke, animation stilled under
reduced motion. The index popover's phase spinners
(`.project-index-phase-spinner`: a ledger page with a sweeping read-line
for the file scan, a quill writing a line for the AI tiers) are the
reference; don't reach for a generic rotating ring.

**A live tally is a glyph with an exponent, not a parenthetical.** A
streaming chat bubble counts the engine chunks that arrived with nothing
visible (keepalives, bare framing, streamed tool arguments) as the crew's
hammer with the count as its exponent (`WorkChunksCount`), in the status line
and beside the thinking dots. A bare "(4)" reads as a footnote; the hammer
says work landed. The head is the Crew activity drawing (`HAMMER_HEAD`), so
the hammer has one shape across the product. It stays still, because the
thinking dots beside it already carry the motion. Hover text and the
accessible name say what the number means in words.

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

**One row per thing, and a place for what it holds.** A bakery owner's
"invoice" listed each invoicing plan twice (the plan and its generated
Help article), offered "Investor Pitch Deck", and left out the project
that held the invoices. So the name catalog drops a plan's Help article
when the plan itself is listed; a scattered match may skip letters inside a
word or jump to the start of a later word, never into the middle of one
(`fuzzyScore`); a project matches on what it is for (its description and
type) as well as its name; and a project whose files, tasks or mail matched
is listed below them as "Holds invoices.json".

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

On a phone a thread row names only the model that answered ("Qwen 3.5 2B"),
never "This Device": every conversation there runs on the device, so the
label says nothing. Phone model ids are opaque store keys, so a row whose
model has no known name shows no engine at all rather than the id. On the
desktop a thread row names only the engine ("This Mac", "Claude"); the model
id that answered ("This Mac (qwen3.8-27b-q4)") is debug-mode text, like a
task's id.

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
A bare time of day (Home's dateline, "tonight at 10:00 PM") goes through
`formatClockTime`, the locale's own short clock, so it matches the time in
`formatAbsoluteTime`. Never force a 12- or 24-hour clock: Home's "13:01" sat
one click from History's "12:31 PM".

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

**A status sits beside its heading.** A readiness pill or setup state goes in
the same `.settings-card-header` row as the heading it reports on, at every
level: a card's own header and a section header inside a card alike (Audio's
speech engines). Under the heading, it read as the first line of the section.

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

**A first scan that has not run yet is not an error.** The index chip shows
red only for an index that exists and is out of date. A new project, or a
new install whose background indexing is still holding, reads "Not scanned
yet" beside a neutral dot, and its panel says the crew can still open the
files. The bakery saw a red "Not indexed" under an answer drawn from those
very files.

**A project's settings fold into one compact status key.** The project
status bar shows the current lifecycle label followed by its colored light
("Active", "Stable", "Read-only", or "Inactive") on a 1.5rem-high key.
The key opens `ProjectControlsOverflow` upward, keeping status choices and
the write grant together, with their explanations as tooltips. The write
grant stays a plain toggle there ("Stop workspace edits" / "Allow workspace
edits"). A read-only project also keeps its writes control inline, because
"gezels cannot edit here" is the state that explains why nothing changed.

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

**A missing tool is a setup step, not a failure.** When a CLI-backed provider
(Codex, Claude CLI) is simply not installed yet, the Connection row shows one
short colored word ("Not connected", `.provider-connection-state`) and the
reason plus the fix go in a `.provider-connection-callout` beneath it: body
ink, a `--danger` left rule, numbered steps in muted type. No red ✗ and no
paragraph of red text. Settings that only make sense once the tool answers
(default model, reasoning effort) stay hidden until the probe succeeds, so a
first-time user sees only what they can act on.

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

**"Not enough memory" offers the model that would start.** A capacity denial
asks the daemon (`GET /api/sessions/:id/model-fit`) whether the session's
model would start with the memory free now. Retry appears only when the
answer is yes, because the person closed something or chose another model;
until then it could only fail the same way. When a model already on this
computer would start and the session follows the install default, the
primary key switches to it and runs the turn again: "Use Gemma 4 12B instead
· already on this computer". The name drops the quant ("Gemma 4 (12B, Q4)"
reads "Gemma 4 12B"), and the note in the key says why this one will work.
The card asks again when the window regains focus or the config changes.
[CapacityDeniedActions](../packages/ui/src/components/CapacityDeniedActions.tsx)
is the reference.

**A model's label agrees with whether it will start.** Settings' model rows
judge a model with the same arithmetic the launch check uses, against the
memory free now (`GET /api/system/models-fit-now`, `launchFitsNow` in
[recommendation.ts](../packages/core/src/recommendation.ts)). A model the
launch would refuse reads "won't start right now" with what to do, never
"good match for this machine"; a dense model that fits on the graphics card
gets no "may respond slowly" caution, because nothing about it is slow.

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

**Selected navigation items stay inside the rail.** The current destination
has a canvas-colored fill and a solid border around all four sides, with
`--radius-md` corners. Leave a 0.75rem gutter to the main panel in the expanded
desktop rail; selection never bridges across its edge. Row-level status/actions
sit inside the same rectangle.
The main panel casts a narrow, soft shadow into the rail, mirrored when the
sidebar changes sides. Reserve the outline for the destination currently shown;
hover and expand/collapse states remain flat in the rail.

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
A notice the person can act on also appears where the action lives: a GPU
backend Gezel switched off after it crashed several times in a row while
starting shows on that engine's Settings tab as the same `.settings-notice`,
with a plain "Try … again" button beneath the disclosure, and the rail copy
names that tab. Such a notice carries its `settingsSection`, and the rail line
opens that tab rather than About. The same holds for an engine that is not
using the GPU the machine has — a CUDA build the NVIDIA driver cannot run
(restart, update the driver, or reinstall it), or a GPU build that started
without its GPU. Its rail label names the fix when there is one ("Restart to
use your GPU", "Update your NVIDIA driver"), and its copy says the engine
returns to the GPU by itself once the cause is gone, because it does. An
event rather than a condition — Linux's out-of-memory killer stopping the
engine — never takes the rail: the failed chat already said so, and the
engine's tab keeps a count for whoever comes looking.

**A project's app updates on its own; only an update that needs the person
asks.** A project made from a project type moves to a newer version of it
(same major) without a word when nothing of the person's is affected: the
Output page reloads in place, and the Overview's activity reads "Shift Roster
was updated". No banner, no toast, no version number. An update that would
replace a script changed in the project, add crew, connect a tool service,
start a recurring run, write into a folder Gezel holds no grant for, or that
came from an AI App file waits for the person. It shows as one muted
`.file-flat-notice` line over the Output page ("An update for Shift Roster is
ready." with an **Update…** key) and as the "Set up as" row in the project's
Settings → Preferences. **Update…** opens a plain `Dialog` that says what the
update does and what stays the same, in sentences; versions appear only in the
builder view (`useBuilderView`). The pieces live in
[ProjectTypeUpdate.tsx](../packages/ui/src/views/projects/ProjectTypeUpdate.tsx);
the rules for what an update keeps are in docs/project-types.md ("Upgrades").

**The titlebar sheds words before it sheds pills.** The status cluster is
open-ended — one engine pill per busy on-device engine, one queue chip per
busy provider — so on a crowded bar something has to give. Never a pill:
each one is a live process the user needs to see, and a squeezed pill is an
unreadable smear rather than a smaller pill. Drop *text* instead, in one
ladder measured for the whole cluster at once so every pill compacts on the
same beat: first the machine name ("This Mac" — every local engine wears it,
so it stops distinguishing anything the moment a second pill appears) and the
queue chip's activity phrase, then the gezel's name in Activity. What
survives is what is unique to that pill: the engine, the phase, the model, the
count. Nothing is lost outright — every dropped string stays in the pill's
tooltip and its popover, which is the price of being allowed to drop it. A
named engine ("DwarfStar", "Video") is not a machine name and never goes.
[header-density.ts](../packages/ui/src/components/header-density.ts) owns the
measurement; a plain width media/container query cannot see this, because the
bar overflows from *how much is happening*, not from how narrow the window is.

**A control for a passing state lives in the titlebar only while the state
does.** The stop-narration key appears at the head of the status cluster while
a gezel is being read aloud, the way Output's restore key appears only while
that pane is maximized. It wears the queue chip's recipe (`.narration-stop` is
added to those selectors rather than styled on its own), says "Stop narration"
beside its speaker glyph at full density and drops the words with the rest of
the cluster, and becomes a 44px key in the compact bar. A state that flickers
must not make its key blink: the voice goes quiet between two sentences of a
streaming reply, so the key outlives it by about a second rather than shoving
its neighbours in and out. Stopping silences the rest of that turn — a reply
still streaming would otherwise start the voice again at its next sentence —
while the next turn is read as usual; turning narration off stays in Settings.

**A list of things set up in Settings is rows, not bullets.** Connected apps,
paired servers, and project connections share `.settings-list` with
`.connected-app-row` rows: a bordered `--radius-md` row naming the thing on the
left (`.connected-app-name` over a muted detail line) and its actions on the
right, wrapping under it when narrow. A bare `<ul>` in a settings panel renders
browser bullets and strands its buttons on their own line — Remote servers
shipped that way. Facts about the install (About → Version) use
`.settings-facts`: muted label, value beside it.

**Connecting two devices works like a game's LAN lobby.** Settings → Remote
Servers puts sharing first (one switch, the address this device is reachable at,
**Add a device**) and connecting second: gezel devices found on the network as
rows with a **Connect** key, connect-by-IP in a closed disclosure for the device
that isn't listed, and the servers this device remembers, each marked "on your
network now" when discovery sees it. Connecting asks for the 8-digit code the
other device shows, in one numeric field formatted `4821 0937` as it is typed.
A code a person types beats one they compare: people confirm a comparison
without reading it, and a typed code also stands in for an Approve click on the
other screen. The code is shown only on request, in the large spaced
`.device-code` recipe with its countdown, because it is read off one screen and
typed into another. Port, interface, limits, and the identity code older
versions still compare sit in **Advanced**. A remembered server that can't be
reached is a state, not an error: its row says "not reachable — crew members answer
without it until it's back", pickers keep its models listed as "(offline)", and
a reply that ran on the fallback carries one line saying which server was away
and what answered instead.

A phone is only ever the connecting side, so it gets the second half of the
lobby alone: Settings → Artificial intelligence → **Another device**, below the
phone's own model. Nearby computers, the code field, and connect-by-address sit
in the same order, and each connected computer lists its models as **Use …**
keys, the one in use marked "in use". Choosing one does not replace the phone's
own model. That model stays chosen above, labelled as the one that answers
while the computer is away, and **Use this phone's model** switches back.
Leaving the network is the normal case on a phone, so the reply's fallback line,
not an error, is how a person learns about it.

**A label travels with its control.** In a wrapping row of labelled controls —
the gezel header's Model, Context, Sandbox — wrap each label and its keys in one
non-wrapping group (`.provider-override-group`), so a line never ends on
"Sandbox:" with its keys starting the next.

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

**Adding a folder says what will happen before anything does.** A folder a
person hands the crew is the product's main promise, so every door to it —
the meester's folder question after the first finished task
(`FolderOnboardingStep`), the add-folder sheet
(`AddFolderSheet`, opened by `openAddFolder()` from the New Project dialog's
Existing Folder card, the File menu and the Home tip) — shows the same three
things first: what the folder holds ("12,480 photos · 1,204 only in iCloud",
counted without reading a file), the read-only promise in plain words, and
the night work from `describeFolderNightWork`. In the add-folder sheet, a native
checkbox sits to the left of "Work on this folder during the night shift",
above the work preview. Show "During the nightshift, Gezel will" and the work
list only while that checkbox is checked. The folder question's choices are
checkbox cards, not keys, because several may be picked at once, and none
starts ticked; its overnight question is a two-key tray with neither key
latched until the person answers. A folder gezel refuses (a home folder,
a drive root) is explained with `forbiddenFolderPlainName`, never an error
code, and the add key stays disabled.

**A folder's Overview opens on a first look.** `FirstLookCard` sits above
everything index-derived once the first scan lands: one line of what the
folder holds, what was left in the cloud, what the crew does tonight with a
first-night estimate when it runs to hours, and the "Work on this folder
overnight" switch. That switch is the folder's one off-switch for night work;
there is no second place to look for it.

**The morning leads with decisions.** A night earns a review card when it
made something (a proposal sealed, a report written, a task finished) or when
it was held back for a reason the person can fix (on battery, the quota
reserve), and the same reason is not repeated until a night has run. An
ordinary quiet night (the computer slept, gezel was closed, nothing to do)
earns nothing: a card every morning saying nothing happened teaches people to
ignore the card. A newer card retires an older unanswered one only when it
repeats it (an older quiet card, or one showing only proposals, which stay
on every card until decided); a card with reports or finished work stays until
dismissed, because no later card lists that night again. While the card
is unanswered, Home opens on **Night shift** once per card per launch,
whatever the band's saved collapse, and the tab stays until the card is
dismissed — an unread night does not expire. The card leads (proposals, then
reports, then what finished, the held night's reason with its one fix), then
the main report reads in place, then what is already queued for tonight. One
desktop notification announces a night that made something, titled for what
is on the card; a quiet card never notifies, and the renderer never raises a
second.
Both the unanswered review and the recent night summary use the available width beside the
Meester's figure. The review uses the intro's 90% overlay, leaving the shadowed
chat strip available to return to the conversation. Keep the tabs and collapse
key above a single scroll area for the review, including its reports and actions.

**Photos are prints on a table.** A photo anywhere in the app is a
`PhotoThumb`: a square-cropped tile with `--radius-sm`, loaded when it scrolls
into view from the daemon's thumbnail cache, with the file's initial standing
in when this machine cannot read the format (never the browser's broken-image
glyph). Several photos are a `PhotoGrid`, an `auto-fill` grid that shows a
page at a time behind a "Show N more" key rather than rendering a library at
once; captions and a pick's reason go under the tile only where they were
written for it. An album proposal is a `--radius-lg` card with its cover,
title, span and count; the card opens the album's Squisq slideshow in the
document editor (after its photos are stored with it), where the person plays
it, edits it and exports video, and a quiet "Copy to a folder…" link under the
card opens a small dialog that copies the full-size originals into a folder
they name and says plainly nothing is replaced. A photo folder's Overview gains
**Albums** and **On this day** below the first look, and the morning view
shows last night's albums and this day in earlier years; a folder without
either shows nothing extra. Titlebar search gives a workspace photo hit a 3rem
tile beside its text, like Knowledge results. The chat rail's Files menu shows
an image as a 2rem tile in place of its file glyph (from the workspace, the
artifacts drawer or the library, by `PhotoThumb`'s `kind`); once a menu holds
one, every glyph sits in a 2rem square so names stay aligned, and a format the
cache cannot shrink keeps its glyph.

**A file says what it is, one line above it.** When the Librarian has
summarized a file, its project viewer and the Documents area show that
summary's first prose paragraph as one muted line above the file
(`FileAboutLine`): "About this file · …", truncated to the line, the whole
summary on hover. A file not yet read, or edited since, shows nothing rather
than a stale description.

**A file shows as it is, and a viewer that only reads offers no pen.** A
`.txt` file keeps its line breaks: a pane that only reads it (the chat
rail's file pane, the file inspector) sets it as typed in the reading font,
and the project's file editor opens it in Source, because the document
editor would join its lines into one paragraph (`isPlainTextFile`). Those
panes, and the file editor on a file Gezel may not change, show no
formatting or Insert keys. A file pane's header keeps its path on one line
and never breaks inside a word or an extension: the folder gives way to an
ellipsis first, then the name, with the whole path on hover.

**A proposal that moves files reads as where things go.** Moves, copies and
new folders in a change proposal have no diff, so the review lists them after
the edits as rows — "Move `from` → `to`", "Copy …", "New folder …" — under one
header that says they apply after the edits and never replace a file. Past a
dozen, the rows group by destination folder, each a disclosure row with its
count, so a tidy-up of a thousand photos reads as a handful of folders.

**Social mode is one switch, and off means today.** Settings → General
carries a single *Social mode* checkbox,
beside — never merged with — *Show names and poppetjes*. On, gezels
speak with their character, growth (the Growth tab and level badges) is on
display, and opening a chat shows what is waiting. Off reproduces the plain
register exactly: no character block in any prompt, no growth surfaces, no
card. It defaults on for phones and off for the desktop until the person
chooses; `useSocialMode` is the only reader in the UI.

**A character is edited as rows of keys, with its effect in plain words.**
The gezel's Appearance panel (social mode only) shows Temperament, Quirk,
Style and Sociability, each a `gz-tray` of `gz-key`s that saves on click (no
Save button, like every autosave editor). Under the rows, the exact lines the
model will read are shown, so nothing a choice does is hidden. A key's title
carries that value's line; there is no second description to drift.

**Notifications are earned, and there are few of them.** A notification
says that something happened: a gezel asked a question, work the person asked
for finished, a gezel reached a level (social mode only), the night's review
landed, or a project's own script worked out that something is due (a
flashcard). Nothing fires on the clock alone, no "haven't seen you in a while".
What arrives within a few seconds becomes one notification ("3 things are
waiting"). Nothing is said while the person is looking at the app, and at most
`notifications.dailyCap` a day (default 3). The cap is a row of keys in
Settings → General (*Off · 1 · 3 · 5 · 10*), saved on click. Held items still
sit in Updates and their chats; the cap only limits interruptions. The policy
lives once in core `notifications`. Electron's main process raises desktop
notifications, so they arrive with the window closed. The phone's UI raises
its own through the native bridge, and asks the OS for permission the first
time something worth a notification happens while the person is in the app.
The renderer never raises one on the desktop.

**A chat opens on what is waiting, never on a greeting.** In social mode,
opening a gezel's chat (and a just-chat project) shows at most one
`.visit-card` above the thread: an open question that gezel asked, else work
it finished in the last three days. It is read from questions and tasks on
disk, never written by a model, so an empty moment stays empty. It is
dismissible per item and sits outside the timeline because it is not a
message.

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

**Figure lists in articles.** A Help list whose items lead with a
poppetje — what `::handboek-gezel-roster` expands to — renders as a card
per figure: portrait, name, role, and the role's one-line summary, in an
`auto-fill` grid on the article's own surface tokens
(`--squisq-page-bg-alt`, `--squisq-page-radius`). A row of bare portraits
makes the reader match faces to a name list somewhere else; the nametag
belongs on the figure. The item's *shape* is the CSS hook — squisq's
markdown carries block attributes on headings only, so a macro cannot
class the list it expands into — which means any figure-first article
list gets this treatment, and should.

**Surfaces inside another app are guests.** The Office task pane and the
LibreOffice panel live in someone else's window, about 320px wide. They carry
one slim header row (project name, a read-only annotation when the folder is
read-only, the gezel picker, an "Allow edits" checkbox, and a status dot)
over the embedded chat, and nothing else: no navigation, no titlebar pills.
Everything wraps rather than truncates. The read-only annotation is the
sanctioned non-interactive capsule; the status dot is a true circle; the
app picker in the Office setup card is a plain group of checkboxes, not a
tray, because the choices are independent rather than mutually exclusive.
Before the chat loads, every stopping state (connecting, the one-time
connection code, declined, expired, Gezel not running) is a short title, one
sentence, and the next step as a button. The connection code is set large,
selectable, and beside a Copy button.

**A guest chat is about the document it sits beside.** The Office pane opens
on one conversation about the open document, not on the project: a single row
with the document's title and a quiet **Show project** key, over the thread
and its composer. The thread picker lists only that document's threads; task
threads, other gezels' chats and the project tabs stay out of it. The project
is one key away and comes with a **Back to <document>** key, so the person
never loses the way back. Gezels that run background services (the
Librarian, the Scribe) are not offered as someone to write with.

**A narrow conversation gives up the role first.** Wherever a chat timeline is
narrower than 560px — the pane, a side panel, a phone — a bubble header drops
the gezel's role and tightens its spacing, so the name, the live status and
the cancel key keep the row. The role moves to the name's hover text. The
rule keys on the timeline's own width (the `chat-timeline` container on
`.chat-timeline-viewport`), never the window's, so a cramped panel in a wide
window narrows too.

### App demos: the companion works the page

A Gezel app's website demo shows the page and its companion side by side, as
the app looks in fullscreen. The conversation is scripted by the app
([sample conversation](handboek/technical/gezel-page-apis.md#the-sample-conversation))
and follows the chat's own look: serif replies, the visitor's turns in the
terracotta bubble, a quiet step row with a check for each tool the companion
uses. Three rules keep it honest and legible:

- **Say it is scripted, once, quietly.** One muted line under the composer
  ("Sample conversation. In Gezel, replies come from the model you choose.")
  and a companion that answers anything off-script by saying the preview
  follows a few sample requests. Never imitate a model's free answer.
- **Show cause and effect.** Every suggestion does real work through the
  app's tools; the page text that changed glows briefly in the accent, and a
  change below the fold scrolls into view beside the conversation. A long
  reply anchors at its start, so the name row stays on screen.
- **Phones stack, they do not shrink.** Below 900px the conversation sits
  under the page and its suggestions become one scrolling row of keys.

## Poppetjes: painted wooden crew

Poppetjes are the app's character system, not generic avatars. Their visual
language is small hand-painted, lathe-turned wooden figures: simple faces,
warm asymmetric light, rounded volume under a soft satin sheen, quiet grain
below the paint, and stable silhouettes that survive icon crops. Avoid flat
clip-art shading, literal wood texture, and glossy plastic highlights. The persistence invariants, rendering
stack, application-crop rules, and PNG quality workflow are documented in
[poppetje-rendering.md](poppetje-rendering.md).

## The Village: a codebase as a settlement

The **Village view** of the project Views tab (`FileMap` in code) draws a
folder tree as a settlement from roughly **1890–1925** — never a modern skyline. Its architecture
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

Roof slopes shade the roof material, never the wall color: a slate roof over
brick must not acquire a purple slope. Brick, limewash, and weatherboard own
the facade color, with only a trace of language tint. Separately seeded front
details (stepped shop gables, pediments, sash windows, shutters, bay windows,
and striped canvas awnings) distinguish neighbors without reshuffling their
architectural families. Symbol buildings need habitable-looking storeys and
steep roofs, with culling and picking using those same heights. Their shared
courtyard is worn paving inside a low stone curb, not a colored platform.
Street trees use layered broadleaf, columnar, and cedar silhouettes; cobbles
use staggered courses and lamps use small framed lanterns. All fine detail
stays in the street tier and out of the age lens.

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

### Which edges the Village sees

Roads, storeys, landmarks and downtown all follow the import graph, so a
better resolver would move every village the day it shipped. Instead each
village records the graph it was founded on (`edgePolicy` in the village
file). A village that existed before the resolved graph stays on relative
imports only. A new village is founded on the resolved graph, which sees
workspace packages, tsconfig paths, and Python, Go, Rust and C dependencies
([ADR 0024](decisions/0024-resolved-file-edges.md)). When the resolved graph
would add at least a tenth more roads, the Village header shows a quiet
**Update the village** key whose tooltip says how many roads it would draw.
Pressing it is the only way a village changes graph. Buildings stay where they
stand, while roads, downtown and landmarks follow. The committed file gains the
one `edgePolicy` field. Document links are never roads.

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

Below the findings tray, a reviewed file carries a **Librarian review card**
on the same tray recipe but a neutral surface: the 1–10 health score with its
one-line reason, the reviewer's cliffs notes as read-only markdown prose, and
durable issue rows identified by a short project-scoped reference (`BW-12`).
Selecting a current line reveals it in the source; after the file changes, the
old location is explicitly labelled **Previously line N** and **Needs recheck**
instead of pretending it is still exact. Rows support read/unread, a verdict,
resolve, and reopen. **Give a verdict** (a scale icon) opens a small form in
the row rather than a popover: a key tray of Not a bug · Not worth fixing ·
Confirmed real · Fixed, a second tray of reasons when it is Not a bug (Wrong
about the code · Handled elsewhere · On purpose), an optional note, and Save.
"Not worth fixing" is a separate key on purpose: a true but minor lead is not
the reviewer being wrong. A judged issue shows one muted line under its
message naming the verdict and who gave it ("Not a bug · Claude Code — …"),
with "(unconfirmed)" when "fixed" came with an unchanged file. An issue in a
category the project's verdicts have set aside carries a muted **Low
confidence** item in its meta line; it stays in the list but out of the file
tree's badges and issue total. Reopen is the one-click override. With project editing enabled, **Fix** opens a
confirmation dialog and creates an assigned terminal task; the row stays in
progress and links to that task until completion resolves it. Review severities
(info / minor / major) are a deliberately separate vocabulary from security
severities and never borrow their colors or badge treatment. The card closes on
a one-line reminder that these are leads from a background model pass — an
opinion, not a verdict — and a muted provenance footer naming the model, gezel,
and date. A file the Librarian hasn't reached yet gets one muted "not reviewed
yet" line, no spinner.

The findings tray and the review card are sections of the shared file
inspector (see "Every view shares one inspector"), so a file opened from any
view shows them the same way; the Village adds only its own chips.

Past street zoom, miniature symbol buildings may gain compact floating tags.
These use small-radius plates with short rooftop leaders, prioritize functions
and methods when labels collide, and appear progressively as each building gets
large enough on screen. Keep the ordinary street view unlabeled and preserve
hover details as the fallback for tags suppressed by density.

## Social preview cards

Every published Help page carries a 1200×630 Open Graph card, rendered at
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
  `#b0724c` — the same tokens as the Help page it previews, so the card and
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
