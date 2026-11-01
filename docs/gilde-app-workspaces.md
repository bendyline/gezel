# Gilde application workspace review

The catalog contains 26 project types. This pass adds new versions of all 23
HTML page applications. The three native experiences remain native: Email uses
the mailbox pipeline, Just Chat uses the conversation surface, and Software
Project uses the editor/workspace/task views. A second HTML facade would duplicate
their existing capabilities and navigation.

## Shared capabilities

- `ui.components.appLayout` expands existing content into a full workspace with
  native chat alongside it. Conversation visibility, page dialogs, restore, and
  narrow layouts preserve the mounted conversation and draft.
- `ui.components.actionForm` provides validated, accessible, serialized edits
  through declared page tools, with recoverable errors and retained drafts.
- `ui.components.collectionFilter` searches rendered records without replacing
  their existing controls. It follows data refreshes and ignores accents.

The pages use existing project files, scripts, scoped reads and imports. No new
private database or unrestricted write API is needed. Thirty-one page-only tool
aliases share the existing model-facing actions' scripts and bindings, keeping
their data ownership and permission checks intact. Original model tools remain
available to the crew. Native chat exposes neither transcripts nor credentials
to page scripts.

## Application changes

| App | New version | Workspace changes |
| --- | --- | --- |
| Caregiving Binder | 1.1.3 | Care coordinator, journal search, care notes and appointments |
| Checkers | 1.2.6 | Shared fullscreen table talk, preserved game and draft, dialog-aware chat |
| Chess | 1.0.8 | Integrated opponent conversation alongside the live board |
| Data Analysis | 1.0.1 | Full-width dataset exploration with an analyst and attachments |
| Design Scheme | 1.0.3 | Searchable palettes, palette creation, sample design previews, designer chat |
| Event Planner | 1.0.4 | Guest search, guest creation, RSVP changes, spending and planner chat |
| Fitness Coach | 1.1.1 | Integrated coach, editable weekly target, existing workouts and recap |
| Flashcards | 1.2.2 | Study partner, manual card creation, searchable card library, review and notes-to-cards |
| Freelance Office | 1.0.4 | Invoice search, recording invoices, sent/paid controls and office partner |
| Fundraiser HQ | 1.0.4 | Complete searchable donation list, gifts, thank-you tracking and campaign partner |
| Go | 1.0.6 | Opponent conversation with the board and move history |
| Household Budget | 1.0.5 | Entry search, income recording, expense entry and budget conversation |
| Household Manual | 1.0.4 | System search, new systems, maintenance logging, attention flags and home keeper |
| Image Feed | 1.0.3 | Visual studio with crew selection, attachments and a native post-detail dialog |
| Job Hunt | 1.0.5 | Searchable pipeline, applications, stage changes and selectable career crew |
| Language Trainer | 1.1.1 | Practice studio, scene goals, native tutor chat, optional dictation, review, searchable phrasebook and progress |
| Life Binder | 1.0.5 | Document search, location records, reviewed/missing controls and archivist |
| Meal Planner | 1.0.4 | Editable meal plan and pantry stock, grocery search and meal planner |
| Media Library | 1.0.1 | Expanded gallery, existing file cards/imports/media viewer, without adding an unnecessary crew member |
| Novel Writing Room | 1.0.4 | Writing partner, session logging, searchable chapters, outlines and chapter stages |
| Social Feed | 1.0.4 | Editorial workspace, crew selection and a native post-detail dialog |
| Trip Planner | 1.0.5 | Day planning, packing additions, journal entry and trip planner |
| Word Clues | 1.0.3 | Expanded game with selectable clue-giver conversation |

Read-only dashboards now report failed refreshes instead of silently presenting
empty records. Updated data views retain their last successful render and ignore
stale asynchronous results. The page subscriptions are disposed on exit. Demo
actions mutate their authored samples only; real failures never fall back to
demo data. The shared demo bootstrap replaces copied legacy platform stubs.

## Verification and release

`catalog-app-pages.spec.ts` exports and exercises every current Gilde page in a
browser: fullscreen, forms, search, light/dark themes and 320-pixel layouts.
`catalog-app-host.spec.ts` applies the catalog definitions in isolated projects,
checks native chat and retained drafts, exercises real script-backed form
actions, and reapplies definitions with `seedPolicy: preserve`. Models are
mocked. `page-app-components.spec.ts` covers the shared components' dialog,
validation, failure, asynchronous and dynamic-search behavior.

Run against a checkout with `GILDE_DIR` set to its root and
`GEZEL_GILDE_DATA_DIR` to its `data` directory, after building Gezel and running
Gilde's index builder. `pnpm test:e2e:catalog-apps` holds a dependency read lease;
use existing browser binaries. Catalog schema validation and page-demo checks
remain separate from browser behavior checks.

These are source changes and new unreleased catalog versions. Public delivery
requires the Gezel runtime containing the new components, a Gilde release, and
an updated pinned catalog dependency. Existing projects retain their applied
version until explicitly updated. Apply an update with `seedPolicy: preserve`
and reuse its existing crew. Do not replace the user's game, records, or drafts
with catalog samples.
