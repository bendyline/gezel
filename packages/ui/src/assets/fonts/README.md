# Bundled fonts

These `.woff2` files are redistributed with Gezel. They split into three
cohorts:

1. **Gezel UX fonts** — Hanken Grotesk (sans, UI chrome) and PT Serif
   (display, brand surfaces). Always loaded.
2. **Squisq theme fonts** — every font referenced by a built-in Squisq
   theme (see the theme library in `@bendyline/squisq`). Bundled so that
   any Squisq-rendered surface using any theme (Documentary, Magazine,
   Cinematic, etc.) gets the intended typography without Gezel reaching
   out to Google Fonts at runtime.
3. **OpenMoji Color** — emoji glyphs, scoped to emoji codepoints via
   `unicode-range` so it overlays any of the above without disrupting
   Latin text.

All fonts are Latin subset only.

| File(s) | Font | Copyright | License |
|---|---|---|---|
| `hanken-grotesk-*.woff2` | **Hanken Grotesk** | Copyright (c) 2020 Alfredo Marco Pradil, with Reserved Font Name "Hanken Grotesk". | [OFL 1.1](./licenses/LICENSE-hanken-grotesk.txt) |
| `pt-serif-*.woff2` | **PT Serif** | Copyright © 2010, ParaType Ltd., with Reserved Font Name "PT Serif". | [OFL 1.1](./licenses/LICENSE-pt-serif.txt) |
| `playfair-display-*.woff2` | **Playfair Display** | Copyright 2017, Claus Eggers Sørensen, with Reserved Font Name "Playfair Display". | [OFL 1.1](./licenses/LICENSE-playfair-display.txt) |
| `source-serif-4-*.woff2` | **Source Serif 4** | Copyright 2014–2021 Adobe, with Reserved Font Name "Source". | [OFL 1.1](./licenses/LICENSE-source-serif-4.txt) |
| `inter-*.woff2` | **Inter** | Copyright (c) 2016–2020 The Inter Project Authors. | [OFL 1.1](./licenses/LICENSE-inter.txt) |
| `oswald-*.woff2` | **Oswald** | Copyright 2016, The Oswald Project Authors. | [OFL 1.1](./licenses/LICENSE-oswald.txt) |
| `roboto-*.woff2` | **Roboto** | Copyright 2011 Google Inc. | [OFL 1.1](./licenses/LICENSE-roboto.txt) |
| `merriweather-*.woff2` | **Merriweather** | Copyright 2016, The Merriweather Project Authors (Eben Sorkin). | [OFL 1.1](./licenses/LICENSE-merriweather.txt) |
| `lora-*.woff2` | **Lora** | Copyright 2011, Cyreal. | [OFL 1.1](./licenses/LICENSE-lora.txt) |
| `jetbrains-mono-*.woff2` | **JetBrains Mono** | Copyright 2020 The JetBrains Mono Project Authors. | [OFL 1.1](./licenses/LICENSE-jetbrains-mono.txt) |
| `ibm-plex-sans-*.woff2` | **IBM Plex Sans** | Copyright © 2017 IBM Corp. | [OFL 1.1](./licenses/LICENSE-ibm-plex-sans.txt) |
| `dm-serif-display-*.woff2` | **DM Serif Display** | Copyright 2019, Colophon Foundry. | [OFL 1.1](./licenses/LICENSE-dm-serif-display.txt) |
| `dm-sans-*.woff2` | **DM Sans** | Copyright 2014, Colophon Foundry. | [OFL 1.1](./licenses/LICENSE-dm-sans.txt) |
| `cormorant-garamond-*.woff2` | **Cormorant Garamond** | Copyright 2015, Christian Thalmann. | [OFL 1.1](./licenses/LICENSE-cormorant-garamond.txt) |
| `crimson-text-*.woff2` | **Crimson Text** | Copyright 2010, Sebastian Kosch. | [OFL 1.1](./licenses/LICENSE-crimson-text.txt) |
| `openmoji-color.woff2` | **OpenMoji Color** | © OpenMoji — Hochschule für Gestaltung Schwäbisch Gmünd. | [CC BY-SA 4.0](./LICENSE-CC-BY-SA-4.0.txt) |

Per-font upstream license text lives in [licenses/](./licenses/). Each is
the canonical OFL 1.1 or license text shipped by the font's own project.

Source projects:
- Hanken Grotesk — https://github.com/hanken-design/HankenGrotesk
- All other OFL fonts above were sourced via Google Fonts.
- OpenMoji — https://openmoji.org/

Gezel's sibling DocBlocks project uses the same set — when updating this
directory, the two repos should stay in sync.
