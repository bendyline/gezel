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
whats-new/       Release notes — one article per release, newest first
assets/          Images referenced by articles (incl. assets/poppetje/*.svg)
```

`whats-new/` is written by the `release-note` skill (`.claude/skills/release-note/`), which reads the commit range since the previous tag and drafts the article. Read that skill before hand-writing one — the voice is deliberately different from the rest of the Handboek, and the ordering convention below is easy to get wrong.

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
- `order` — sort key within the area, ascending (generated articles sit at 10).

  `whats-new/` inverts this to get newest-first: a release article's order is

  the negated calendar line, so `1.26223` carries `order: -26223`, and the

  section index sits at `-999999`. Nothing else needs touching when a release

  lands — the next article simply sorts above the last one, and the index

  picks it up through `::handboek-whats-new-list`.

- `summary` — one line for the TOC. In `whats-new/` it is also the whole of

  the release in the section's own list, so it is required there and capped

  at 200 characters (enforced by the content lint in

  `packages/service/src/handboek/engine.test.ts`).

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
| `::handboek-whats-new-list{limit=12}` | Every release in `whats-new/`, newest first, each with its one-line summary. Identical in all three modes. |

## Conventions

- Second person, warm, plain language — the Handboek exists to make gezel approachable for non-technical people. Explain a Dutch term the first time an article uses it.
- No emojis (repo-wide rule).
- Don't hard-wrap prose — one paragraph is one line. The squisq renderer keeps a single newline inside a paragraph as a real line break, so 80-column wrapping shows up as ragged breaks in the app. The engine folds soft breaks defensively (`packages/service/src/handboek/unwrap.ts`, for prose that comes from gilde), but sources here stay unwrapped so diffs stay readable.
- Relative links between articles and to `assets/…` only; the link checker (`scripts/check-markdown-links.mjs`) runs over this tree.
