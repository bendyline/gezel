# Handboek content

This tree is the hand-curated half of the **Handboek** — gezel's built-in documentation. It ships with the app (the service build copies it to`dist/handboek-content/`), is served through `/api/handboek`, rendered in the Handboek tab, exported as static HTML for gezel.com by `gezel handboek export`, and consulted by gezellen through the `how_do_i` tool.

This README is the authoring contract. The engine lives in

`packages/service/src/handboek/`.

## Layout

One folder per area — the folder is authoritative for an article's area:

```
conceptual/      Concepts — what gezel is, the crew model, projects, memory
gezel-roles/     Role articles (curated leads; generated bodies fill gaps)
craftbooks/      Usually generated; curated overrides welcome
project-types/   Usually generated; curated overrides welcome
technical/       Architecture, files on disk, security, CLI
assets/          Images referenced by articles (incl. assets/poppetje/*.svg)
```

## Article format

Squisq-flavored markdown with YAML frontmatter:

```markdown
---
id: welcome
title: What is gezel?
order: 1
summary: The crew model, and why your data stays on your disk.
---

# What is gezel?

Body prose…
```

- `id` — stable article id. Optional; defaults to the filename stem. Use the

  `role/<roleId>` form to shadow a generated role article with a curated one

  (curated ids always win).

- `title` — TOC + tab title. Falls back to the first `#` heading.
- `order` — sort key within the area (generated articles sit at 10).
- `summary` — one line for the TOC.
- `defaultDuration` — optional seconds-per-block override for the video

  playback mode's timing.

- `siteVisible: false` — exclude the article from the gezel.com static export.

Plain markdown renders fine everywhere. Squisq heading annotations (`## Heading {[pullQuote]}`, `{[statHighlight]}`, …) are progressive enhancement for the video/social playback mode — see the squisq SquigglySquare docs for the template vocabulary.

## Autoannotation macros

A macro is a leaf directive on its own line. The engine expands it into plain markdown **before** rendering, per mode (`app` = personalized for this install, `site` = generic for gezel.com, `agent` = compact for the `how_do_i`tool). An unexpanded macro silently disappears from the rendered doc — the`no-surviving-directives` test in `packages/service/src/handboek/` catches typos, so run `pnpm --filter @bendyline/gezel-service test` after editing.

| Directive | What it expands to |
| --- | --- |
| `::handboek-gezel-roster{role=meester}` | "You have two meester gezellen: Alice and Jack" + their poppetje figures. Omitted on the site. |
| `::handboek-meester-card` | Who the current Meester is, with figure. Generic description on the site. |
| `::handboek-role-summary-table` | Every built-in role: summary, model floor, default craftbooks. |
| `::handboek-role-about{role=researcher}` | The role's default about.md from its gilde template. |
| `::handboek-role-tools{role=researcher scope=default}` | The role's toolset kit as a table. `scope=device` / `scope=tiers` tailor it to installed models / model tiers. |
| `::handboek-toolset-groups{ids=memory,web}` / `{role=…}` | Reference sections for built-in tool groups. |
| `::handboek-craftbook-steps{id=research-report}` | A craftbook's step table, triggers, and required toolsets. |
| `::handboek-craftbook-list{role=…}` | Table of craftbooks (optionally the role's defaults). |
| `::handboek-installed-models` | Models installed on this device with engine and tier. |
| `::handboek-project-type-composition{id=…}` | What a project type sets up: crew, craftbooks, toolsets, schedules. |

## Conventions

- Second person, warm, plain language — the Handboek exists to make gezel approachable for non-technical people. Explain a Dutch term the first time an article uses it.
- No emojis (repo-wide rule).
- Relative links between articles and to `assets/…` only; the link checker (`scripts/check-markdown-links.mjs`) runs over this tree.
