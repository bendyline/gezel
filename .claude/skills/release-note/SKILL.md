---
name: release-note
description: Write the Handboek "What's new" article for a gezel release — read the commit range since the previous tag, work out what actually changed for a person using gezel, and draft it in plain human language. Use when the user says "write the release notes", "we're cutting a release", "add a what's-new article", or names two versions to describe the difference between.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion
---

# release-note

Produces one article under `docs/handboek/whats-new/`. That section is the running record of gezel releases, rendered in the Handboek tab and exported to the site — so the audience is **the person using gezel**, not the person who wrote the code.

This is the only place in the repo where you write outward-facing prose about engineering work. Getting the voice right matters as much as getting the facts right.

## Phase 0 — Establish the range

1. **Previous release.** `git tag --sort=-creatordate | grep '^v1\.' | head -5`. The newest `v1.*` tag is the baseline unless the user names one. `native-v*` tags are engine binaries, not app releases — ignore them.
2. **This release.** `node -e "import('./scripts/calver.mjs').then(m => console.log(m.calVerPrefix()))"` gives the calendar line for today (`1.YYDDD`). The published tag will be `v1.YYDDD.<build>`, where the build number is assigned by CI — **do not invent one**. The article is identified by the calendar line only.
3. **Confirm the range is what the user means.** If the previous tag predates the last few merges, or the user names a version that is not the newest tag, say so in one line and use theirs.
4. If an article for today's calendar line already exists, you are **updating** it, not adding a second one.

## Phase 1 — Gather evidence

Do not write from the commit subjects alone; they are mostly `fix: <area> updates` and will produce a useless article.

```bash
git log <prev>..HEAD --format='=== %h %s%n%b'      # bodies carry the real detail
git diff --stat <prev>..HEAD | tail -3             # scale
git diff --name-only <prev>..HEAD | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn | head -40
git diff --name-status <prev>..HEAD | grep '^A' | awk '{print $2}' | grep -v test
```

New **non-test source files** are the strongest signal of a new capability — a new `packages/service/src/<feature>/` directory or a new `packages/ui/src/components/<Thing>Card.tsx` almost always means something a user can now see or press. New `docs/` files tell you what was considered worth explaining.

Then **verify before you describe**. For every change you intend to claim:

- Read enough of the new code or its doc to state what it does correctly. A wrong claim in release notes is worse than an omitted one.
- Confirm user-visible changes are actually reachable — grep `packages/ui/src` for the control. If a capability exists only as an HTTP route with no UI, either say so plainly or leave it for the developer section.
- Never describe a feature you could not find. Silence is fine; invention is not.

## Phase 2 — Decide what belongs

Rank by **what changes for the reader**, not by engineering effort. A one-line default change that removes a daily annoyance leads; a 4,000-line refactor that no one can perceive gets one clause under "smaller things", or nothing.

Sort every candidate into:

- **Leads (2–5).** New capability, or a limit that is gone. These get their own `##` section with a couple of paragraphs.
- **Smaller things.** A flat bullet list. One sentence each, no section of their own.
- **Developer-only.** Package layout, SDKs, endpoints, test infrastructure. Group them under a section that names them as such so a non-technical reader can skip cleanly.
- **Omit.** Internal refactors, lint, test churn, dependency bumps with no visible effect. Dependency bumps get at most one bullet naming the versions.

Security hardening always ships. Describe it as *what is now impossible*, not as the internal mechanism — and say plainly whether anything the reader does changes (usually it does not).

## Phase 3 — Write it

Create `docs/handboek/whats-new/<calver>.md`:

```markdown
---
id: whats-new/1.26224
title: 1.26224 — 12 August 2026
order: -26224
summary: One line naming the two or three things that matter most.
---

# 1.26224 — 12 August 2026

Opening paragraph: the span covered, and the single sentence a reader could stop after.
```

`order` is the **negated** calendar-line digits (`1.26224` → `-26224`) so newest sorts first. The section index (`whats-new-index.md`, `order: -999999`) always stays on top. **Do not edit the index** — it lists releases through `::handboek-whats-new-list`, which reads the article frontmatter, so a new article appears there the moment it lands.

### The summary is the headline, not an afterthought

`summary` is the entire release as most people will ever see it: it is the line under the title in the section's Recent releases list and in the table of contents. Write it last, once you know what the leads are, and treat it as a tweet:

- **Name the two to four things that matter**, concrete nouns first. "Measured model scores, per-model memory controls, editable Office documents, and much stricter rules about what a gezel may install" — not "various improvements and bug fixes".
- **One sentence, no period-separated clauses, no version numbers, no jargon.** Someone who does not open the article should still come away knowing whether this release is interesting to them.
- **200 characters is the hard cap**, and the content lint fails the build above it. Aim for 120–160.
- A summary that could be pasted on any release is a summary you have not written yet.

### Voice

The Handboek exists to make gezel approachable for people who are not engineers. Release notes are where that promise is easiest to break, so:

- **Say what it means before you say what it is.** "Choosing a local model used to mean guessing. Now there is a scoreboard" earns the paragraph that follows.
- **Second person, active voice, ordinary words.** Not "the approval subsystem now performs content-bound validation" but "approving a command now approves that exact command".
- **Name the annoyance the change removes.** A change is only interesting relative to the thing that was worse.
- **Explain a Dutch or gezel-specific term the first time it appears** in the article — *gezel*, *gilde*, *craftbook*, *meester*, *voorman*.
- **Say when something is opt-in, and why.** Users trust software that tells them what it will not do without being asked.
- **No marketing.** No "delighted to announce", no "powerful", no "seamless". State the change; let it be good on its own.
- **No emojis** (repo-wide rule).
- **Don't hard-wrap prose** — one paragraph is one line, per `docs/handboek/README.md`.
- Keep an **"Anything to do?"** section at the end. Almost always the answer is "no, update when offered" — say it anyway, and point at the one or two settings worth a visit.

Length: a substantial release runs 60–120 lines. A quiet one runs 20. Do not pad.

### Linking

Relative `.md` links only, resolved by the Handboek renderer and the repo link checker. From an article under `whats-new/`, a link to the scorecard article has the target `../technical/model-scorecard.md`. Link to the Handboek article that explains a new capability rather than re-explaining it. Never link to a GitHub PR, issue, or commit — the reader is inside the app.

## Phase 4 — Verify

```bash
node scripts/check-markdown-links.mjs
pnpm --filter @bendyline/gezel-service exec vitest run src/handboek
```

The service handboek suite includes the content lint that fails on an unexpanded `::handboek-*` macro. Then re-read the draft once as someone who has never seen the codebase, and cut every sentence that only makes sense if you have.

Report to the user: the range covered, the leads you chose, and anything you deliberately left out.

## When the area itself needs changing

`whats-new` is a Handboek area like any other. Writing an article never requires touching any of this — it matters only if you are adding or renaming an area:

- `HandboekAreaSchema` in [packages/core/src/schemas/handboek.ts](../../../packages/core/src/schemas/handboek.ts) — the wire enum.
- `HANDBOEK_AREAS` (TOC order) and `HANDBOEK_AREA_TITLES` in [packages/service/src/handboek/content.ts](../../../packages/service/src/handboek/content.ts).
- `AREA_BLURBS` in [packages/cli/src/handboek-export.ts](../../../packages/cli/src/handboek-export.ts) — the site export's one-line area description. `Record<HandboekArea, …>`, so `pnpm typecheck` catches a missing entry.
- The area-order assertion in `packages/service/src/handboek/engine.test.ts`.

The section's own list is a macro, `whats-new-list`, in [packages/service/src/handboek/macros.ts](../../../packages/service/src/handboek/macros.ts). It renders from `MacroContext.releases`, which the engine fills via `listReleaseNotes()` in `content.ts` — a pure renderer over frontmatter, so nothing about adding a release touches code.
