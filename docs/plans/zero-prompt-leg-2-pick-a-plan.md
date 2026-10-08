# Implementation plan: "Pick what you want, get it"

Zero-prompt AI, leg 2. Written 2026-10-08 for an AI coding agent picking this
up with no prior context.

## Context

Gezel is a local-first desktop app with a crew of AI helpers ("gezels"). The
product direction is **zero-prompt AI**: a person never has to write a prompt.
It stands on two legs:

1. **Your folders, overnight.** The person points gezel at folders. A Night
   Shift indexes them, describes photos, summarizes documents and drafts
   fixes, and leaves results for approval in the morning. This leg is built.
   Do not change it in this work.
2. **Pick what you want, get it.** The person chooses a ready-made plan (a
   research report, a slide deck, a website), adds a few details such as a
   topic or an audience, and the crew makes it, now or tonight. **This plan
   covers leg 2.**

Vocabulary you will meet in the code:

- **craftbook**: a ready-made plan. Its content (steps, prompts, a parameter
  schema, gates) lives in the sibling repo `../gilde`, under
  `data/craftbook-templates/<xx>/<id>/`. The app pins a gilde version in
  `packages/catalog/package.json`.
- **task**: one run of a craftbook.
- **project type**: a ready-made project, such as a trip planner. It sets up
  a crew, starter files and an output page. There are 24, in
  `../gilde/data/project-types/`.
- **Meester**: the front-door gezel on Home.
- **gilde**: the content repo, and the catalog the app reads from it.

### Gate for this work

Starter plans need only a few details and finish reliably on a local model.
Newcomers find the right plan without help.

## Ground rules

- Read `AGENTS.md` and `CLAUDE.md` first. Read `docs/ux.md` before any UI
  change, and extend it in the same change when you add a control or pattern.
- **Do not run git**: no commit, branch, push or PR. The owner manages git.
  Leave changes in the working tree and report them.
- Schemas live in `packages/core/src/schemas/`. Disk state goes through
  `Store`. Log through the logger, never `console`. No emojis.
- **Gilde content:**
  - Edit content in `../gilde` and run against it with
    `GEZEL_GILDE_DATA_DIR=/Users/mike/gh/gilde/data`. Never publish gilde.
  - Edit `versions/<v>/craftbook.json`. Edits at a book's root are inert.
  - A changed book gets a new version folder with its `test.json` copied
    across.
  - Do not run `scripts/write-guardrail-books.ts`: it rewrites an
    already-released version of careful-mode.
  - After any change to a core Zod schema, run `pnpm gilde:export-schemas`.
- **No telemetry.** Estimates come from this install's own task history and
  from our eval runs.
- **Tests:**
  - Scope them to a package: `pnpm --filter @bendyline/gezel-ui run test`,
    or `npx vitest run <file>` inside a package. Also run `pnpm typecheck`.
  - Run biome on the files you changed, never whole folders.
  - Never rebuild the `core` or `client` dist while another test run is
    going: other runs read it.

## Current state (verified 2026-10-08; line numbers approximate)

**Entry points**

- **New Task dialog:** `packages/ui/src/views/tasks/NewTaskDialog.tsx`,
  opened from Tasks (`views/TasksView.tsx`). It has two steps:
  - **Pick:** a gallery with search, a project selector, 16 subject shelves
    (`taskLensesFor` in `views/tasks/new-task-meta.ts`), and a "General
    task" card.
  - **Configure:** the description, numbered steps with role names, Title,
    "Works on" pickers, Parameters, and "Assign to". Then "Create & start".
- **Chat composer Task key:** `components/ChatComposer.tsx` (~1894), with
  the attached-task strip `components/ComposerTaskBar.tsx` and the launch
  body in `components/composer-task-launch.ts`, which has the Tonight
  option. Only a fresh thread in `views/home/MeesterConversation.tsx` turns
  the key on.
- **Suggestions from typed text:**
  - `ChatComposer` calls `previewTurnIntent`.
  - `packages/service/src/chat/turn-intent-plan.ts` matches exact formats
    (pptx, docx, pdf, slideshow).
  - `packages/service/src/chat/craftbook-trigger-route.ts` matches each
    book's `triggers`.
- **Meester tools:** `suggest_craftbook` and `invoke_craftbook` in
  `packages/mcp/src/server.ts`.
- **Launch pipeline:** the shared launch rules are in
  `packages/core/src/craftbook-launch.ts`:
  - `launchFormParamSchema` and `withoutUnaskedParams` decide what a form
    shows.
  - `composeCraftbookLaunch` puts the message into the main parameter.
  - `mainContentParamKey` finds that parameter: a `fromMessage: true`
    property, else `topic`.

  Two service files run launches:
  - `packages/service/src/tasks/launcher.ts` (`TaskLauncher`)
  - `packages/service/src/http/routes/sessions.ts` (`launch-task`)

  File pickers are `components/craftbook-input/CraftbookInputField.tsx`.
  Contract: `docs/craftbook-inputs.md` and the CLAUDE.md section "Launching
  a craftbook from chat".
- **Recommended shelf:** comes from the project type's `craftbookTags`
  (`packages/service/src/http/routes/projects.ts` ~470–499). A General
  project has none.
- **Results:** `DeliverableCard.tsx` in chat and task detail,
  `ProjectOutputPane.tsx`, and Home's `views/home/MorningPanel.tsx`.
- **New Project:** `views/projects/NewProjectDialog.tsx`,
  `new-project-meta.tsx` and `NewProjectDetailPane.tsx`.

**Gaps a newcomer hits**

1. **No starts on Home.** Home has no "make me a…" choices. The full picker
   lives on the Tasks page, and the Task key appears only in a fresh Meester
   chat.
2. **Too many choices.** About 287 plans on 16 or more shelves, with plain
   substring search and no starter set.
3. **An extra step.** A plan with nothing to ask (for example
   `branding-website`, `research-report`) still opens Configure, because
   `selectBook` always goes there (~460–472). Title and Assign-to always
   show.
4. **Path fields.** `powerpoint-deck` asks for "Deck folder", "Workspace
   output path" and "Source file". This breaks the CLAUDE.md rule: never ask
   a person for a path; default it, derive it, or give it an input picker.
5. **Jargon.** The subtitle reads "Pick a craftbook — a proven recipe your
   crew follows…". Steps show role names, Assign-to says "Auto — the {role}
   for step 1", and crew cards carry a "voorman" badge.
6. **No preview and no time estimate.** The picker shows only the
   description and steps.
7. **Reliability unmeasured.** Nobody has measured how often the starter
   plans finish on a typical local model, or how long they take.

## Acceptance criteria

1. From Home, a newcomer gets a research report running with at most three
   clicks plus typing a topic. They choose no project, no assignee and no
   title.
2. No starter plan's launch form shows a path, folder or file-name field. A
   contract test enforces this.
3. A plan with nothing to ask starts from one click, or one confirm with
   Start and Tonight.
4. Every starter plan passes its eval at least 2 of 3 times on each
   reference local model, with its time recorded. Suggested reference
   models: `qwen3.8-27b-q4` (MLX) and a small model such as Gemma 12B.
5. These surfaces show no "craftbook", "voorman" or step role names by
   default: Home starts, the quick launch, the New Task dialog, the composer
   strip, and task cards.
6. Existing tests pass, new behavior has tests, typecheck is clean, and
   `docs/ux.md` is updated.

## Workstreams, in order

### W0. Audit the candidates (half a day)

Write a small script or test that prints, for each candidate starter book,
the fields `launchFormParamSchema` leaves visible and its required inputs.
Save the output as `docs/plans/zero-prompt-leg-2-audit.md`.

Choose 6–8 starters that meet all of these:
- the message alone can start them (`fromMessage` or `topic`)
- they need no required file input
- they have broad, non-technical appeal
- they already have a `test.json` eval

Seed candidates: `research-report`, `research-to-document` (Word),
`powerpoint-deck`, `report-pdf`, `branding-website`, and
`narrated-slideshow`. Confirm each exists in `../gilde` before relying on it.

### W1. Forms that never ask for paths, plus a contract test (1 day)

- **Contract test** in `packages/catalog/src/` (follow
  `docblocks-catalog-contract.test.ts`):
  - For every book tagged `starter`, `launchFormParamSchema(paramSchema)`
    must expose no property whose key, title or description reads as a
    filesystem path (path, folder, directory, output path, file name),
    unless it carries an `input` picker annotation.
  - Fail hard for starters. For all other books, print a report but don't
    fail. Copy the reporting style of `gilde-schema-freshness.test.ts`.
- **Gilde fixes** for the starters that fail:
  - Default output locations from `{{task.dir}}`, or mark them
    `askUser: false`.
  - Turn source-file params into `input` pickers (see
    `docs/craftbook-inputs.md`).
  - Start with `powerpoint-deck`: deck folder and output path become
    derived, and the source file becomes a file picker.
- **Re-run each changed book's eval once** to confirm it still passes (see
  W6 for how).

### W2. Starter set and one-step launch (1 day)

- **Starter set:** mark starters with the gilde tag `starter`. `tags` already
  exists on craftbook manifests, so no schema change is needed.
  - Add a core helper `isStarterCraftbook`.
  - Add a fallback list of ids in core. Use it only when no catalog book
    carries the tag, because the pinned gilde won't have the tag until the
    owner publishes.
- **Expose starters to the UI:** add a filter to the existing craftbook
  listing route, or a small route such as `GET /api/craftbooks/starters`. It
  returns id, plain name, one line, artwork, the main field's label, and the
  estimate from W5.
- **One-step launch** in `NewTaskDialog.selectBook`:
  - When no fields are visible and no inputs are required, skip Configure
    and show a single confirm with Start and Tonight.
  - Derive the title from the main parameter or the book name, and use the
    Auto assignee.
- **Collapse the rest:** put Title, Assign to and "Works on" behind a "More
  options" disclosure, closed by default. Show plain step names only, with
  role names inside the disclosure.

### W3. Starts on Home (1–2 days)

- **A "Make something" row on Home:** 6–8 cards (artwork, plain name, one
  line) in `views/home/` (see `HomeWorkshop.tsx`), plus a "See all" link to
  the New Task dialog.
- **A quick launch sheet:** a card opens a compact sheet.
  - The main field is focused.
  - Optional fields are collapsed.
  - Buttons are "Start now" and "Tonight".
  - The project is the current one, or Default.

  Reuse the dialog's form pieces and launch through the same path as
  NewTaskDialog / `TaskLauncher`, so dedupe and receipts behave the same.
- **Follow `docs/ux.md`:** square-ish keys in trays, the radius tokens, no
  pill buttons. Document the row and the sheet there.
- **Tests:** component tests with `test-utils/mockApi.ts` defaults, and a
  web e2e if one exists for Home.

### W4. Plain words (half a day)

- **The copy pass** covers the New Task dialog, the composer strip, task
  cards, `DeliverableCard`, and Assign-to text. On these surfaces, user-facing
  "craftbook" becomes "plan". Internal names, routes and schema keys stay
  unchanged.
- **Keep** "gezel" and "Meester".
- **Add a short "Words we show" table to `docs/ux.md`** so later work stays
  consistent.
- **Update tests** that assert on the old strings.

### W5. What you'll get, and how long it takes (half a day)

- **"You'll get":** a model-free summary from the book's declared deliverable
  ("A Word document with sources", "A slide deck", "A website"). Derive it
  from the final step's output declarations (`advanceWhen` file extension or
  the deliverable fields). Show it in the quick sheet and in the picker.
- **Time estimate, version 1:** the median duration of completed tasks of the
  same craftbook on this install, from task history (created → completed).
  - Show "Usually about N minutes here".
  - Show nothing when there's no history.
  - Put the helper in core, so the phone app can reuse it.
- **Later, not in this pass:** a catalog-level estimate and an example
  output image, both carried in gilde. Note them in the report.

### W6. Measure starter reliability (1–2 days, mostly waiting)

- **Run each starter's eval** three times on each reference model.
  - Use `pnpm eval:run` with the book's `craftbook-<id>` scenario. See
    `evals/README.md` and `evals/src/craftbooks/`.
  - Set `GEZEL_GILDE_DATA_DIR=/Users/mike/gh/gilde/data` so edited books are
    the ones that run.
  - Evals are long: run them in the background, one heavy run at a time.
- **Record the results** in `docs/plans/zero-prompt-leg-2-evals.md`: pass
  count, wall time and failure reason per book and model.
- **Fix what fails.** Book problems go to gilde as new versions. Runtime
  problems go to this repo with a regression test. Re-run until each
  starter passes at least 2 of 3, or record why it can't yet.

### W7. Stretch, only if time allows

- On a project's Overview, a "Start something here" row showing that project
  type's recommended plans.
- Typed-text suggestions in any new chat thread, not only a fresh Meester
  thread. Check the coordinator-only rules in
  `packages/service/src/chat/coordinator-only-tools.ts` first.

## Out of scope

- The Night Shift and folder work (leg 1).
- Publishing gilde, bumping the pin, deploying gezel.com. The owner does
  these.
- Moderated user tests. The owner runs them after this lands.

## When you finish, report

- Files changed per workstream, and the gilde books changed (new versions,
  unpublished).
- Tests run and their results, including any failure you believe is not
  yours, with its output.
- The audit (W0) and eval results (W6) files.
- Anything you skipped or changed from this plan, and why.
