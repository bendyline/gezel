# Poppetje rendering strategy

Poppetjes should look like small, hand-painted, lathe-turned wooden people:
warm, physical, and individually recognizable without becoming miniature
portraits. The visual direction is a simple wooden character from a gentle
video game, with the generous proportions and clear painted shapes of a
Small World-style toy ensemble. The renderer is intentionally parametric SVG. Raster or generated
character art would weaken the local-first model, make rerolls inconsistent,
and lose the crisp crops needed across the desktop UI.

## Load-bearing architecture

- `poppetje.json` persists every identity slot explicitly. Catalog or odds
  changes must never alter an existing character.
- `key` is the stable material and face-variation seed. Rerolls change slots,
  not the underlying individual.
- The renderer consumes one struct and draws one content tree. `full`,
  `headshot`, and `icon` are viewBox crops, not separate illustrations.
- Schema and catalogs live in `packages/core/src/poppetje/`; rendering lives in
  `packages/ui/src/poppetje/`; persistence stays with `PoppetjeManager`.
- Hats, accessories, patterns, and physical features remain independent slots
  with deterministic overlap rules.

These choices are sound and should remain. The visual-quality problem belongs
in the material and lighting layers, not in a new identity model.

## Visual target

The target is painted wood seen in soft window or studio light:

1. A broad, asymmetric light source from the upper left.
2. Rounded edge falloff that describes a turned head and torso.
3. A shallow contact shadow where the head meets the body.
4. Clearly varied wood fibers and whorls visible through paint, softened as
   if below a finish. Material families must remain distinguishable at the
   compact sheet's 88px figure width, not just in a large close-up.
5. Broad satin lighting rather than a separate white highlight dot.
6. Generous heads, shorter turned bodies, rounded shoulders, and a continuous
   curved foot. The base meets a soft ground shadow without a floating disc.
7. Simple painted facial marks that remain legible at 16–40px.

Avoid literal lumber texture, outline-heavy clip art, airbrushed 3D character
rendering, photorealistic faces, and per-slot lighting directions. Grain is a
supporting material cue; silhouette, color, and face geometry carry identity.

## Rendering stack

The drawing order is deliberate:

1. Ground shadow and turned base lip.
2. Body silhouette with a cylindrical paint gradient, vertical depth glaze,
   and clipped garment paint.
3. Head/body contact shadow and body-level garments.
4. Head with radial volume, deterministic grain, and a soft satin bloom.
5. Hair and hats using the same light direction and material vocabulary.
6. Face, facial hair, wearables, marks, and the foreground hood.

The default `wavy` grain uses displaced, directionally softened noise at
controlled opacity beneath the paint. Material contrast is deliberately lower than
the garment and facial marks; unpainted-looking stripes are not the target.
Within that finish, the stable gezel key selects one of four
material characters: fine straight fibers, broad flowing waves, nested
cathedral figure, or organic knots/whorls. It also varies width, opacity,
softness, and displacement inside that character, so a crew looks cut from
related but non-identical pieces of wood. Wider seeded opacity, fiber-width,
and softness ranges make the difference visible at ordinary figure sizes.
Sparse flow lines, open cathedral arches, and elongated torso knots supplement
noise so those families survive downsampling. Knots appear on both the turned
head and the side grain of the torso; their count and placement stay keyed to
the same individual. Exactly one quarter of keys are
knotty, preserving the established whorl invariant; half of those receive a
second knot. More forceful finish presets remain available for intentionally
strong character. Tiny icon crops below 36px skip turbulence entirely: the
texture is sub-pixel there, hurts face clarity, and needlessly multiplies SVG
filter work in long lists. Knots are also omitted at this level and when the
finish is `none`. Icon and headshot crops both accommodate hats, buns, braids,
and headphones; the surrounding app may clip the SVG.

## Hair styling

The appearance editor offers short, curly, bob, medium, long, extra-long,
bun, braids, shaved and bald hair. Length/style, bangs and hair part are
independent fields. Bangs can be absent, straight, side-swept, curtain or short;
parts can be none, center, left or right (from the viewer's perspective).
Older files default to no bangs and no part. These defaults do not reroll
other slots; new and edited choices are saved explicitly in `poppetje.json`.
Bald/shaved hair and hats hide styling, but retain saved choices for later.

`CarvedHair` draws crown, forehead edge and lengths as one closed silhouette.
A single head-coordinate gradient lights the whole shape, and carved channels
flow from the part into the locks. Braids gather at the temples and weave into
softly scalloped plaits with tapered tied ends. The part moves the hairline and
redirects the channels, while bangs reshape the forehead edge. Avoid separate
object-bounding-box gradients on each lock: they make attached pieces obvious.
Extra-long lengths extend down the torso in the full figure; portrait crops
keep the face at the same readable scale as medium/long cuts.

## Quality workflow

From the repository root:

```sh
pnpm poppetje:review
```

This runs the gallery, group capture, and evaluator in order using the existing
repository TypeScript loader and dependency read lease. It explicitly loads the
UI JSX configuration, so it works from the repository root and does not rely on
a `tsx` executable in the UI package. No dependency install is performed.
Individual stages remain available:

```sh
pnpm --filter @bendyline/gezel-ui run poppetje:gallery
node packages/ui/scripts/poppetje-review.mjs groups
pnpm --filter @bendyline/gezel-ui run poppetje:eval
```

Outputs land in `tmp/poppetjes/`:

- `index.html` / `overview.png` — the entire visual matrix.
- `sheet.html` / `diversity-sheet.png` — compact full-body catalog sheet.
- `hair-sheet.html` / `hair-sheet.png` - lengths, bangs and parts together.
- `manifest.json` — explicit structs, labels, groups, crop sizes, and PNG paths
  for every case; suitable for reproducing a specific figure.
- `groups/` — one reviewable PNG per catalog category.
- `tiles/` — full-body inputs to the deterministic image evaluator.
- `contexts/` — real icon/headshot crops on light and dark surfaces. These are
  visually reviewed but excluded from full-body occupancy metrics. Includes
  all skin tones at 16, 24, 32, 40, and 56px on both surfaces, plus every hat
  and hair silhouette in clipping icon/headshot frames.
- `eval-report.json` — readability, material, texture, separation, centering,
  and weak-case scores.

The matrix enumerates every catalog option, all skin/shirt/hair palettes, 32
seeded crew members, 12 identical outfits with different wood keys, and
explicit overlap cases. Hair rows additionally cover the complete 8-cut by
5-fringe by 4-part matrix. It is not the Cartesian
product of every possible slot. Controlled catalog rows pin the individual key
so changing a hat or shirt does not also change the face and wood grain.

Always compare the weakest samples, all skin tones, hats, garment patterns,
hard overlap combinations, and application crops. The numeric evaluator is a
regression guard, not an aesthetic judge: a smooth plastic cylinder can score
well, and noisy literal grain can increase edge metrics while looking worse.

## Review checklist

- Does the full crew look like one photographed product family?
- Are head and torso volumes readable without an outline?
- Are default grain families visibly different at compact sheet size while
  staying quieter than facial features and garment paint?
- Do pale and deep skin tones preserve facial contrast and modeled volume?
- Do hats read as objects resting on the head rather than flat decals?
- Do 16–40px icons retain eyes, mouth, hair silhouette, and skin/hair contrast?
- Are full/headshot/icon crops recognizably the same individual?
- Are filter IDs namespaced, and does every `url(#...)` resolve locally?
- Does every catalog option render distinctly and without overlap breakage?
- Do deterministic tests and the visual weak-case score hold or improve?

## Known limits and next investments

- SVG paint servers are defined per figure because colors differ per gezel.
  Small-icon grain LOD controls the largest list-view cost; profile before
  attempting a shared-defs cache that could reintroduce ID collisions.
- Standalone appearance-picker items intentionally use neutral flat fills,
  while items worn by a full poppetje inherit figure-specific material fills.
  If picker realism becomes important, give `PoppetjeItem` its own namespaced
  paint defs rather than duplicating item geometry.
- Edge wear, brush marks, and paint chips are tempting but should be rare,
  deterministic, and tested at icon size. They are lower priority than clean
  silhouettes and consistent light.
- Image metrics cannot validate emotional warmth or toy-like plausibility.
  Keep the PNG contact sheets in the loop for every material change.
