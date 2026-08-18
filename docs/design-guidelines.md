# Gezel — Design Guidelines

A distillation of the design language used in the Gezel desktop app, written so
it can be applied to the marketing site, decks, social cards, and any other
surface carrying the brand.

This is the shareable summary. The authoritative, implementation-level source is
`docs/ux.md` in the product repo; the tokens live in
`packages/ui/src/styles.css`. Where this document and those disagree, they win.

---

## 1. The essence

Gezel is a local-first desktop app for assembling a **team of AI agents** —
*gezels*. The name is Dutch for "companion" or "journeyman." The product's
entire framing is a **craft guild**, not a SaaS dashboard: users hire a crew,
give them a bench, and watch them work.

Three words should describe any surface we make:

1. **Organic** — human, warm, a little imperfect. Not factory-flat. Gentle
   curves, generous whitespace, colors pulled from wood, parchment, and ink
   rather than from a corporate palette. Transitions fade and settle rather than
   pop.

2. **Classic** — it should read like a well-made tool you'd keep for years, not
   a product surfacing the month's design trend. Typography, proportion, and
   materials over novelty and chrome. Nothing that would look dated in 2031.

3. **Historic** — Gezel is a guild. The vocabulary (*gezel*, *meester*,
   *voorman*) is Dutch apprenticeship terminology, and the visuals should echo
   the world those words come from. A guild hall, an apprentice's bench, a
   master's ledger.

**What this does not mean:** kitsch, pastiche, sepia washes, or literal
skeuomorphism. If a first-time visitor can't quite put a finger on *why* the
brand feels different from every other AI product, we've done it right. The cues
stay subtle — color temperature, border weight, corner radius, the pacing of a
transition.

The one sanctioned physical cue is **things you press**. Gezels are workers at
craft tables, so controls may read as tools set into a bench: keys resting in
trays, expressed through light and depth (gradients, bevels, inset shadows) —
never through textures or ornament.

### The second pillar: approachability

Alongside the craft framing, Gezel exists to make AI accessible to people who
aren't technical. The word "gezel" is itself the thesis: users work with
*craftspeople*, not with the cold and technical "agents." Design and copy should
both carry that. Warm nouns over jargon. A named character over an abstract
capability. Plain sentences over feature bullets.

---

## 2. Color

The palette is parchment, ink, sage, and terracotta. Warm throughout — there is
essentially no blue in the brand except where blue carries data.

### Foundation palette (light)

These are the authored primitives. Everything else derives from them.

| Token | Hex | Role |
| --- | --- | --- |
| `--gezel-paper-canvas` | `#eae5d6` | The page. Warm parchment. |
| `--gezel-paper-workshop` | `#efe6dc` | Workshop/hero surfaces |
| `--gezel-paper-panel` | `#f3eddf` | Cards — elevated paper on the canvas |
| `--gezel-paper-reading` | `#f1e9e1` | Long-form reading surface (mushroom beige) |
| `--gezel-paper-inset` | `#ddd3bd` | Pressed-in surfaces: inputs, trays, wells |
| `--gezel-ink` | `#1c1c1c` | Body text |
| `--gezel-ink-muted` | `#666666` | Secondary text |
| `--gezel-ink-warm` | `#2a2520` | Warm ink on parchment |
| `--gezel-ink-warm-muted` | `#5a4f42` | Warm secondary |
| `--gezel-ink-warm-quiet` | `#8b7e6b` | Warm tertiary |
| `--gezel-sage` | `#667f62` | **Brand green.** The titlebar / masthead. |
| `--gezel-sage-deep` | `#5c6a4a` | Deeper sage |
| `--gezel-sage-forest` | `#3d4d3a` | Darkest sage — logotype on light |
| `--gezel-sage-soft` | `#d6dec6` | Sage tint |
| `--gezel-terra` | `#b0724c` | **Accent.** Terracotta. Interactive + selected. |
| `--gezel-terra-hover` | `#996142` | Accent hover |
| `--gezel-terra-deep` | `#9a4e30` | Deep terracotta |
| `--gezel-terra-soft` | `#f0d4bf` | Terracotta tint |
| `--gezel-cream-ink` | `#f3ede0` | Text on sage |

### The two brand colors

- **Sage green **`#667f62` is the *identity* color: the masthead, the logotype,
  the thing you see first. It is a place, not a control.
- **Terracotta **`#b0724c` is the *action* color: links, selected state, focus
  rings, the pressed key. It is never used as a large field.

Never invert those roles. A sage button or a terracotta header both read as a
different product.

### Semantic roles

Component styling should consume these, not the raw primitives:

| Role | Light | Dark |
| --- | --- | --- |
| `--bg` (page) | `#eae5d6` | `#141517` |
| `--panel` (card) | `#f3eddf` | `#1c1d20` |
| `--surface` (inset) | `#ddd3bd` | `#1f2124` |
| `--text` | `#1c1c1c` | `#f0f0f0` |
| `--text-muted` | `#666666` | `#999999` |
| `--accent` | `#b0724c` | `#c0875d` |
| `--accent-hover` | `#996142` | `#d5a07a` |
| `--border` | `rgba(127,127,127,0.25)` | same |
| `--success` | `#27ae60` | `#6ad38f` |
| `--warning` | `#e67e22` | `#f0a04b` |
| `--danger` | `#c0392b` | `#e74c3c` |

Note the light-mode inversion that most systems get wrong: `--surface`** is
darker than the canvas, not lighter.** Inputs and wells read as *pressed into*
the parchment. Dark mode uses ordinary additive elevation.

The step between canvas and card is deliberately small. It should feel like
nested paper, not a contrast boundary — never a stark white card floating in
cream.

### Rules

- **Everything derives from the foundation.** A nearby tone via `color-mix()` is
  fine; starting a parallel palette is not.
- **Hardcoded color is reserved for content that carries data** — diffs,
  terminal output, illustration, the character figures. Never for chrome.
- **Dark mode is a real mode, not an afterthought.** The dark canvas is a cool
  near-black (`#141517`) and the accent lightens to `#c0875d` to hold contrast.
  Design both.
- **Focus is visible and terracotta:** a 2px page-colored ring plus a 2px accent
  ring, so it reads on any surface.

---

## 3. Typography

A **two-font system**, both self-hosted WOFF2 — no CDN, no runtime fetch.

| Role | Family | Where |
| --- | --- | --- |
| Sans (`--font-ui`) | **Hanken Grotesk** | The default for *everything*: chrome, controls, body, labels, buttons, links |
| Serif (`--font-display`) | **PT Serif** | The editorial register: headings and long-form prose only |

**The one rule that keeps a surface consistent:**

> Headings carry the serif. All other text — body, labels, helper text, buttons,
> inputs, and links — is sans.

Two things to actively watch:

- **Links stay sans even inside a heading.** A link that inherits its font
  inside an `<h3>` will pick up the serif. That's a bug — force it back.
- **PT Serif ships only 400 and 700.** Asking for 500/600 on a serif heading
  synthesizes a weight and looks wrong. Leave headings at their natural bold, or
  set 400 for a lighter editorial look. Hanken Grotesk has 400/500/600/700, so
  sans text can use the full range.

### Size scale

A small, deliberate set — use it instead of ad-hoc values. Ad-hoc sizing is most
of what makes a panel look "off."

| Token | Size | Use |
| --- | --- | --- |
| `--text-2xs` | 0.72rem (~11.5px) | Badges, pills, uppercase eyebrows |
| `--text-xs` | 0.8rem (~12.8px) | Helper / caption text |
| `--text-sm` | 0.85rem (~13.6px) | Dense controls, secondary body |
| `--text-md` | 0.9rem (~14.4px) | Default UI body |
| `--text-lg` | 1rem (16px) | Emphasized body, sub-headings |
| `--text-xl` | 1.1rem (~17.6px) | Section headings |

Long-form editorial surfaces are the deliberate exception: marketing prose,
article bodies, and hero copy set their own comfortable reading size (1rem and
up) and don't draw from this scale. **A marketing site is mostly editorial**, so
expect to live above this scale more often than the app does — but keep the
ratios and the serif/sans split intact.

### Density

Moderate. Not Linear-tight, not Notion-loose. Comfortable line-height; ~0.5rem
between related controls. The spacing scale is `0.25 / 0.5 / 1 / 1.5 / 2 rem`.

---

## 4. Shape, depth, and materials

### Corners are mostly square

| Token | Radius | Use |
| --- | --- | --- |
| `--radius-sm` | 4px | Badges, chips |
| `--radius-md` | 6px | Keys, buttons, inputs |
| `--radius-lg` | 10px | Trays, small surfaces |

Panels and dialogs may go a step larger. **Never perfectly square, and never
capsule-shaped for anything interactive.** Fully-rounded (`999px` / `50%`) is
reserved for true circles — dots, avatars, scrollbar thumbs, switch knobs — plus
one exception: non-interactive **status badges** are true capsules, precisely
because the capsule silhouette is what stops them being mistaken for buttons.

**There are no pill buttons.** A capsule-shaped control is a bug, not a variant.
If you're reaching for `border-radius: 999px` on something with a text label, it
should be a small-radius key or chip.

### Keys in trays

The signature control treatment, and the most transferable idea for a marketing
site's interactive bits (plan toggles, tab switchers, filters).

A group of mutually exclusive options is a shallow **tray** routed into the
bench; each option is a raised, mostly-square **key**; the chosen key sits
**pressed and latched** in terracotta. Keys are `--radius-md`, trays are
`--radius-lg`, so their corners stay parallel.

The 3D is expressed through **light and depth only** — gradients a few percent
apart, a 1px top highlight, an inset recess. Never textures, never ornament. One
soft light source, from above.

- Selected = pressed *in*, not popped out: translate down 1px, take the accent
  fill, carry an inset shadow.
- Hover lightens the raised face; mousedown previews the pressed depth.
- Only a spectrum's extremes may recolor the latch (an "Off" end may latch
  danger-red). Middle options keep the accent. Never give every key its own
  color.

### Surfaces and shadow

Shadows are soft and low-contrast, modeling a single overhead light:
`0 1px 2px rgba(0,0,0,0.05), 0 6px 18px rgba(0,0,0,0.06)` in light, roughly 6×
the alpha in dark.

### Texture

Exactly one texture ships in the product: a **faint wood grain** screened over
the sage masthead and then knocked back to a whisper by a near-opaque veil. It
should be felt, not noticed. If a visitor can identify it as "a wood texture,"
it is too strong.

Do not add paper grain, noise overlays, or scanlines elsewhere. The warmth comes
from color and proportion.

---

## 5. Motion

Slow-ish and soft. **Nothing snaps or bounces.**

- Overlays and dialogs: **160ms ease-out** in, **120ms ease-in** out.
- Dialogs fade and scale from `0.98` with a 2% vertical drift — a settle, not a
  pop.
- Color/border/background transitions: **120ms**.
- "Working" is a slow pulse (1.2–1.8s ease-in-out), never a spinner where a
  pulse would do.
- Landing cues are transient: a ~2s ring that fades. Never a permanent
  highlight.

Honor `prefers-reduced-motion` everywhere — every looping animation in the
product has a no-motion variant.

---

## 6. Imagery and illustration

Three distinct visual systems, each with strict rules. Reuse them on the
marketing site rather than commissioning a fourth.

### Poppetjes — the crew

Every gezel is a **poppetje**: a small hand-painted, lathe-turned wooden figure.
These are the brand's characters and the primary way we show a "team." They are
parametric SVG, generated deterministically, so a given gezel always looks the
same.

The visual target is painted wood in soft window light:

- A broad, asymmetric light source from the upper left.
- Rounded edge falloff describing a turned head and torso.
- A shallow contact shadow where the head meets the body.
- Quiet wood fibers visible *through* the paint, as if under a finish.
- Satin highlights, never white plastic glare.
- Simple painted facial marks that stay legible at 16–40px.

**Avoid:** literal lumber texture, outline-heavy clip art, airbrushed 3D
character rendering, photorealistic faces, glossy plastic.

Their color world is its own small palette — sage, moss, terracotta, brick,
ochre, butter, indigo, teal, slate, plum, rose, leaf for garments; a full
eight-step range of skin tones; felt hats in brick red, mustard, forest, navy,
charcoal, mulberry. Body shape, skin, and hair mix freely across the cast and
are **never** bound to gender or craft.

### Workshop Marks — catalog artwork

Thumbnails and category art are quiet square still-lifes drawn from a circa
**1905–1915 bindery and small-letterpress** material language: laid rag paper,
woven bookcloth, lightly printed charcoal ink, dull oxidized brass. Parchment
and charcoal base, one muted category accent, one dominant artifact, at most one
or two supporting tools.

The historical cue stays in **material and construction, not decoration**. No
sepia wash, no distressing, no wax seals, no ornate flourishes, no steampunk, no
medieval props, no nostalgic clutter.

### The Village — a codebase as a settlement

The product draws a codebase as a settlement from roughly **1890–1915** — gabled
cottages, shopfronts and inns, civic halls with cupolas, brick workshops, rail
depots, sawtooth-roofed foundries, rendered in 2:1 dimetric isometric. Never a
modern skyline: no glass towers, no rooftop HVAC, no neon, no office campuses.

It's the most screenshot-able surface in the app and the strongest single visual
asset for a marketing site.

---

## 7. Voice

The visual rules have a verbal counterpart.

- **Dutch guild vocabulary is the product's own language**, used consistently
  and always glossed on first use: *gezel* (journeyman/companion), *meester*
  (the guildmaster who helps you hire the rest), *voorman* (the crew lead on a
  project), *handboek* (the manual), *gilde* (the catalog).
- **Warm nouns over technical ones.** A crew, a bench, a workshop — not "agent
  orchestration."
- **Plain and concrete.** Say what a thing is and what the person would do about
  it. The product's own copy rule: never claim something is "temporarily paused"
  unless it genuinely resumes on its own.
- **No emoji.** The product bans them in shipped UI (one sanctioned exception, a
  ⭐ on the meester). Marketing should hold the same line — the glyph vocabulary
  is drawn and typographic, not emoji.
- **Local-first is a promise, not a feature bullet.** Everything a user makes
  lives on their own disk as ordinary files they can open. Lead with that.

---

## 8. Quick do / don't

**Do**

- Warm parchment page, cards as slightly brighter paper, inputs pressed in.
- Sage for identity, terracotta for action.
- Serif headings, sans everything else.
- 4/6/10px radii; mostly-square controls.
- Soft 120–160ms fades that settle.
- Characters as small painted wooden figures.
- Design light and dark together.

**Don't**

- Pill buttons, capsule-shaped controls, or fully-rounded anything that isn't a
  circle.
- Stark white cards on cream.
- Blue — anywhere it isn't carrying data.
- Sepia, distressing, wax seals, gears, or any "vintage" costume.
- Bouncy, springy, or snappy motion.
- Emoji, stock photography of people at laptops, or generic AI iconography
  (glowing orbs, neural meshes, circuit traces).
- Gradients as decoration. Gradients exist here only to describe a light source
  on a physical surface.

---

## 9. Starter tokens

A drop-in block for the marketing site. Fonts are Hanken Grotesk and PT Serif;
self-host both.

```css
:root {
  color-scheme: light dark;

  --font-ui: "Hanken Grotesk", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-display: "PT Serif", Georgia, "Times New Roman", serif;

  /* Foundation */
  --gezel-paper-canvas: #eae5d6;
  --gezel-paper-panel: #f3eddf;
  --gezel-paper-reading: #f1e9e1;
  --gezel-paper-inset: #ddd3bd;
  --gezel-ink: #1c1c1c;
  --gezel-ink-muted: #666;
  --gezel-sage: #667f62;
  --gezel-sage-forest: #3d4d3a;
  --gezel-sage-soft: #d6dec6;
  --gezel-terra: #b0724c;
  --gezel-terra-hover: #996142;
  --gezel-terra-soft: #f0d4bf;
  --gezel-cream-ink: #f3ede0;

  /* Semantic */
  --bg: var(--gezel-paper-canvas);
  --panel: var(--gezel-paper-panel);
  --surface: var(--gezel-paper-inset);
  --text: var(--gezel-ink);
  --text-muted: var(--gezel-ink-muted);
  --accent: var(--gezel-terra);
  --accent-hover: var(--gezel-terra-hover);
  --border: rgba(127, 127, 127, 0.25);
  --success: #27ae60;
  --warning: #e67e22;
  --danger: #c0392b;

  --surface-shadow: 0 1px 2px rgba(0, 0, 0, 0.05), 0 6px 18px rgba(0, 0, 0, 0.06);
  --focus-ring: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent);

  /* Type scale */
  --text-2xs: 0.72rem;
  --text-xs: 0.8rem;
  --text-sm: 0.85rem;
  --text-md: 0.9rem;
  --text-lg: 1rem;
  --text-xl: 1.1rem;

  /* Space */
  --space-xs: 0.25rem;
  --space-sm: 0.5rem;
  --space-md: 1rem;
  --space-lg: 1.5rem;
  --space-xl: 2rem;

  /* Radii */
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 10px;

  font-family: var(--font-ui);
  accent-color: var(--accent);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --gezel-paper-canvas: #141517;
    --gezel-paper-panel: #1c1d20;
    --gezel-paper-inset: #1f2124;
    --gezel-ink: #f0f0f0;
    --gezel-ink-muted: #999;
    --gezel-terra: #c0875d;
    --gezel-terra-hover: #d5a07a;
    --surface-shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 8px 24px rgba(0, 0, 0, 0.35);
    --success: #6ad38f;
    --warning: #f0a04b;
    --danger: #e74c3c;
  }
}

h1, h2, h3, h4, h5, h6 {
  font-family: var(--font-display);
}
```

---

## 10. When in doubt

If a new piece of design is hard to build within these constraints, the answer
is usually one of two things: the shared vocabulary is missing something and
should grow, or the design is fighting the brand's grain and should be
rethought. Extending the system pays off everywhere; working around it erodes
the consistency we're building toward.
