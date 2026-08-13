# The fifty benches — a project-type catalog strategy (July 2026)

Gezel's promise is that AI should feel like hiring a warm, capable crew — not like
operating a chat window. Project types are where that promise becomes concrete. The
New Project dialog is our storefront: the moment a person decides whether gezel is
"for someone like me." A blank project asks the user to supply the imagination; a
project type supplies it for them — a named companion, a ritual, tools that fit the
work, and a shelf where progress visibly accrues.

This paper proposes a catalog of **fifty project types**, the category structure to
hold them, the sequencing to ship them, and — just as important — the platform
affordances the exercise exposes as missing. It builds directly on the shipped
project-type system ([docs/project-types.md](project-types.md)): everything proposed
here is a composition of manifest rails that already exist (gezel templates,
craftbooks, sandboxed SDK scripts, script-backed tools, Output pages, seeds,
schedules, params) plus a small number of named platform gaps.

## Why this is the value proposition

Chat is a commodity. Every competitor has a text box and a model. What nobody else
has is an **outfitted bench**: a project that arrives with a character who knows the
craft, craftbooks that encode the rituals, tools that mutate real local data, and a
dashboard that turns effort into something you can look at. The Language Trainer
proved the shape:

- a **companion** (the trainer gezel — patient, gently corrective),
- a **ritual** (daily lesson, weekly review),
- **data that accrues** (`progress.json` — level, sessions, streak),
- a **trophy shelf** (the dashboard that fills in as you practice).

That composition is the emotional core: the user isn't "using an AI," they're
*keeping something alive* — a language, a garden, a novel, a family archive. The
strategy below is that shape, applied fifty times.

Three strategic claims:

1. **Types are the growth surface.** Each type is a story ("a grandmother built a
   puzzle book for her grandkids"), a landing page, and a reason to open the app on
   a Tuesday. Fifty types is fifty answers to "what would I use this for?"
2. **Types are the moat.** The composition — local files + named characters + sandboxed
   tools + visible progress — is hard to copy for cloud-first products, because
   the files-on-your-disk part *is* the feature (caregiving notes, tax receipts,
   journals: data people rightly refuse to put in someone else's cloud).
3. **Types are the flywheel.** The `.gzl` exporter means users who grow a project
   organically can package and share it. Fifty first-party types seed the norms and
   the quality bar for a community catalog.

## Anatomy of a great project type

Every proposed type below is built from the same rails, and reviewed against the
same tests.

**The rails** (all shipped today unless flagged):

| Rail | What it gives the type |
|---|---|
| Gezel template (`gezels[]`, voorman) | The companion — a named character with craft expertise |
| Params | "Which language?" — variation without proliferation |
| About / mission templates | The project knows what it's for; injected into every session |
| Craftbooks | Repeatable rituals — the verbs of the craft |
| SDK scripts + script-backed tools | Structured mutations of real data, sandboxed |
| Workspace / artifact seeds | Day-one data files with a schema |
| Output page | The trophy shelf — a dashboard reading project data |
| Schedules | The heartbeat (consent-gated; wiring still pending — see gaps) |

**The tests** a type must pass to earn a gallery slot:

- **The uplift test.** Describe the end state in one sentence to a stranger. If they
  don't smile or nod, it's not a type. ("She scanned forty years of handwritten
  recipe cards and printed a book for each grandchild.")
- **No costume without tools.** A type must ship at least one script-backed tool or
  seeded data schema *and* a dashboard that changes as the project is used. A gezel
  with a themed about.md and nothing else is a prompt in a trench coat — it erodes
  trust in the whole gallery.
- **Data that accrues.** The project must be more valuable in month three than day
  one. Accrual is what makes a project a *practice* rather than a transaction.
- **Params for variation, types for workflows.** Genre, language, instrument, event
  kind: params. A genuinely different loop (making game assets vs. making a game):
  a separate type. This keeps fifty from becoming five hundred.
- **A first session that lands.** The voorman's opening move should produce something
  visible within minutes (a seeded plan, a filled dashboard tile), not a
  questionnaire.

## Category strategy

The rail today ([new-project-meta.tsx](../packages/ui/src/views/projects/new-project-meta.tsx)):
General, Code, Communication, Photos & Media (`creative`), Writing, Personal Growth
(`growth`), Games, Data, More. Categories light up only when a type claims them —
so adding a category is cheap in code and expensive only in curation.

Proposed additions to `ProjectTypeCategorySchema`
([catalog.ts](../packages/core/src/schemas/catalog.ts)):

| New id | Label | Tagline | Why it earns a rail slot |
|---|---|---|---|
| `home` | Home & Family | Run the household; care for the people in it. | 7 strong types; the most underserved audience in AI tooling |
| `money` | Money & Small Business | Ledgers, invoices, and calm tax seasons. | 5 types; local-first is decisive here |
| `events` | Events & Journeys | Plan the day, make the trip, rally the crowd. | 3 types; naturally time-boxed projects with clean end states |

Rule: **a category ships only when at least three strong types claim it.** The rail
stays under a dozen entries; "More" absorbs the long tail. Display labels stay
warmer than enum ids (as `creative` → "Photos & Media" already does).

## The fifty

Format per type — **Helps you**: the pitch. **End state**: what exists when it's
working. **Gezels**: the crew (voorman first; Dutch names with gloss, per the
naming tradition). **Tools**: script-tools, toolsets, engines. **Craftbooks**:
the rituals (existing catalog templates marked *(catalog)*). **Dashboard**: the
Output page. **Needs**: platform dependencies beyond today's rails, if any.

The three shipped types — Language Trainer, Email / Inbox, Design Scheme — are the
anchors and are not counted in the fifty.

### Home & Family (`home`, new)

**1. Household Manual (het Huisboek)**
**Helps you**: turn the junk drawer of appliance manuals, warranties, paint colors,
and "which breaker is the kitchen?" into a living home operations book.
**End state**: a searchable manual plus a seasonal maintenance rhythm that never
gets forgotten.
**Gezels**: Huismeester (house steward, voorman) — unflappable, knows where
everything is.
**Tools**: `house-store` script-tools (`add_system`, `log_maintenance`,
`whats_due`); PDF ingest of manuals.
**Craftbooks**: appliance-intake (manual PDF → summary + care schedule),
seasonal-checklist, fix-it-guide (symptom → likely fix → when to call a pro),
vendor-log.
**Dashboard**: home systems grid + "due this season" list.
**Needs**: nothing new; schedules make it sing when wired.

**2. Move Planner**
**Helps you**: survive a house move — inventory, box manifests, address-change
sweep, utility switchovers, a moving-day runbook.
**End state**: moved in, nothing lost, every institution notified; the project
archives itself as a record of what went where.
**Gezels**: Verhuismeester (move foreman, voorman) — checklist-brained, calm.
**Tools**: `move-store` (rooms, boxes, tasks); params: move date, from/to.
**Craftbooks**: room-inventory, box-manifest (searchable "where's the blender?"),
address-change-sweep, moving-day-runbook (adapted from runbook *(catalog)*).
**Dashboard**: countdown + task burn-down + box lookup.

**3. Meal Planner & Pantry**
**Helps you**: answer "what's for dinner?" once a week instead of nightly; plan
menus from what's actually in the pantry; shop from a generated list.
**End state**: a weekly rhythm — menu on Sunday, one grocery run, less waste.
**Gezels**: Maaltijdplanner (meal planner, voorman) — practical, budget-aware,
knows the family's tastes from memory.
**Tools**: `pantry-store` (`add_items`, `use_up`, `whats_expiring`).
**Craftbooks**: weekly-menu, grocery-list, pantry-audit, use-it-up (build meals
around expiring items).
**Dashboard**: this week's menu + shopping list + pantry health.

**4. Garden Almanac**
**Helps you**: plan beds, time sowings to frost dates, keep a walkthrough habit,
and log harvests year over year.
**End state**: a multi-season garden record — what thrived, what failed, what to
change — plus a live "what to do this week" view.
**Gezels**: Tuinman (gardener, voorman) — seasonal, patient, observant.
**Tools**: `garden-store` (beds, plantings, harvests); params: hardiness zone /
frost dates.
**Craftbooks**: bed-plan, sowing-calendar, weekly-walkthrough, harvest-log,
pest-diagnosis (describe or photograph the problem → likely culprit).
**Dashboard**: bed map + this-week tasks + harvest tally.
**Needs**: photo intake (vision) elevates pest-diagnosis; useful without it.

**5. Caregiving Binder**
**Helps you**: coordinate care for an aging parent or ill family member —
medications, appointments, symptom journal, doctor-visit prep, family updates.
**End state**: every appointment walked into prepared; the whole family on the
same page; a continuous record clinicians actually thank you for.
**Gezels**: Zorgcoördinator (care coordinator, voorman) — warm, discreet,
meticulous.
**Tools**: `care-store` (meds, appointments, journal entries).
**Craftbooks**: visit-prep (history + current questions → one-page brief),
meds-reconcile, symptom-journal-entry, weekly-family-update.
**Dashboard**: med list + next appointments + journal ribbon.
**Needs**: nothing new. **This data must never leave the machine — local-first is
the entire pitch.** Candidate for a "stays on this device" badge (see gaps).

**6. Pet Companion**
**Helps you**: keep vet records, vaccination schedules, weight and training logs
for the animals in the house.
**End state**: shots never lapse; a one-page boarding sheet exists for any sitter.
**Gezels**: Dierenvriend (animal friend, voorman).
**Tools**: `pet-store` (animals, weights, vaccinations).
**Craftbooks**: vet-visit-log, training-week, weight-checkin, boarding-sheet.
**Dashboard**: vaccines due + weight chart per animal.

**7. Family Recipe Book**
**Helps you**: rescue handwritten recipe cards and family dishes — capture,
standardize, test, and print an heirloom cookbook.
**End state**: a printable book (one per grandchild) plus a living collection the
family keeps adding to.
**Gezels**: Keukenmeester (kitchen master, voorman) — reverent about provenance
("Oma's version uses twice the butter — keep both").
**Tools**: `recipe-store`; `render_image` for chapter illustrations.
**Craftbooks**: recipe-capture (photo/scan → structured recipe with provenance
note), recipe-test-notes, menu-plan, cookbook-layout.
**Dashboard**: recipe shelf by course + "recently tested."
**Needs**: photo intake for handwriting; print/PDF pipeline for the book.

### Money & Small Business (`money`, new)

**8. Household Budget**
**Helps you**: import bank CSVs, categorize spending, close each month, and track
savings goals — without a subscription service reading your transactions.
**End state**: a monthly close ritual that takes twenty minutes and a year-view
that answers "where does it actually go?"
**Gezels**: Penningmeester (treasurer, voorman) — unjudging, precise.
**Tools**: `ledger-store` (`import_csv`, `categorize`, `close_month`); reuses
csv-transformer *(catalog)* mechanics.
**Craftbooks**: monthly-close, subscription-audit *(catalog)*, spending-review,
savings-goal-checkin.
**Dashboard**: cashflow + category breakdown + goal thermometers.
**Needs**: manual CSV drop works today; a watched-folder/CSV connector automates it.

**9. Tax Shoebox**
**Helps you**: capture receipts and deductible expenses year-round so tax season
is an afternoon, not a crisis.
**End state**: a categorized, documented year — exported as the tidy package your
accountant has never once received from anyone.
**Gezels**: Belastingklerk (tax clerk, voorman) — asks the boring question now so
April is calm.
**Tools**: `ledger-store` variant; PDF/receipt intake.
**Craftbooks**: receipt-intake, quarterly-summary, deduction-hunt, year-end-package.
**Dashboard**: totals by category + missing-documentation list.
**Needs**: PDFs day one; photo receipts want the vision intake rail.

**10. Freelance Office**
**Helps you**: run a one-person business — proposals, invoices, polite payment
chasing, monthly income reports.
**End state**: nothing falls through: every invoice tracked to paid, every
proposal followed up, income visible at a glance.
**Gezels**: Kantoormeester (office manager, voorman) — the operations half of the
freelancer's brain.
**Tools**: `client-store` + `ledger-store`; PDF invoice rendering.
**Craftbooks**: proposal-draft, invoice-run, late-payment-nudge (firm, warm,
escalating), monthly-income-report.
**Dashboard**: outstanding invoices + proposal pipeline.
**Needs**: print/PDF pipeline for invoices.

**11. Life Binder**
**Helps you**: assemble the "in case of emergency" file — wills, policies,
accounts, passwords' whereabouts, instructions — so your people aren't left
searching.
**End state**: a complete, current binder plus a printed one-page emergency sheet;
reviewed annually.
**Gezels**: Archivaris (archivist, voorman) — gentle about hard topics, rigorous
about completeness.
**Tools**: document inventory store; completeness checker.
**Craftbooks**: document-inventory, coverage-gap-review, emergency-sheet,
annual-refresh.
**Dashboard**: completeness checklist ("what's in place, what's missing").
**Needs**: nothing new. The quiet flagship of local-first trust.

**12. Shop Numbers**
**Helps you**: give a small shop or café a weekly numbers habit from POS/bank
exports — trends, anomalies, a monthly close.
**End state**: the owner knows their numbers cold; surprises surface in days, not
quarters.
**Gezels**: Cijfermeester (numbers master, voorman).
**Tools**: CSV drop + `ledger-store`; spreadsheet-model *(catalog)*.
**Craftbooks**: weekly-numbers, anomaly-hunt, month-close-report.
**Dashboard**: KPI tiles + trend lines.

### Personal Growth (`growth`)

**13. Fitness Coach**
**Helps you**: follow a real training plan — progressive overload, deload weeks,
honest logging.
**End state**: a year of training history, visible PRs, and a coach who adjusts
the plan to the log rather than the other way around.
**Gezels**: Coach (voorman) — encouraging, allergic to excuses, safety-first.
**Tools**: `training-store` (`log_workout`, `record_pr`, `plan_week`).
**Craftbooks**: plan-week, log-workout, monthly-progress-review, plateau-analysis.
**Dashboard**: streak + PR board + weekly volume.

**14. Mind Journal**
**Helps you**: keep a daily reflective journal with a companion who listens and
asks exactly one good question.
**End state**: a private, growing record of your inner weather — with weekly
patterns you'd never spot alone.
**Gezels**: Stille Vriend (quiet friend, voorman) — never advises unless asked.
**Tools**: journal `log-store` with mood tags.
**Craftbooks**: daily-entry, weekly-reflection, gratitude-pass,
letter-to-future-self.
**Dashboard**: streak + mood ribbon.
**Needs**: nothing new. Second flagship for the "stays on this device" badge.

**15. Reading Circle**
**Helps you**: track what you read, capture quotes and notes, and actually retain
it — with someone to discuss books with.
**End state**: a personal library of notes; an annual reading review you look
forward to writing.
**Gezels**: Boekenwurm (bookworm, voorman) — has opinions, defers to yours.
**Tools**: `shelf-store` (books, quotes, ratings).
**Craftbooks**: book-notes, quote-capture, monthly-shelf-review, next-reads.
**Dashboard**: covers grid + quote of the day.

**16. Study Buddy**
**Helps you**: turn a syllabus and an exam date into a study plan, flashcards,
practice tests, and targeted weak-spot drills.
**End state**: walk into the exam having already taken it five times.
**Gezels**: Studiemaat (study mate, voorman) — patient tutor who quizzes, never
lectures.
**Tools**: `review-queue` script-tools (`record_quiz_result`, `next_review` —
spaced repetition); params: subject, exam date.
**Craftbooks**: syllabus-to-plan, flashcard-forge, practice-exam, weak-spot-drill.
**Dashboard**: exam countdown + mastery heat map.
**Needs**: interactive Output pages unlock in-dashboard card review (v2).

**17. Habit Forge**
**Helps you**: build one to three habits with daily check-ins, streaks, and
reviews that are honest instead of shaming.
**End state**: the habit is boring — which is to say, won.
**Gezels**: Aanmoediger (encourager, voorman) — celebrates day 3 as loudly as
day 300; treats a broken streak as data.
**Tools**: `streak-store`.
**Craftbooks**: daily-checkin, weekly-review *(catalog)*, streak-postmortem.
**Dashboard**: streak calendar.
**Needs**: scheduled-craftbook wiring for the daily nudge.

**18. Music Practice**
**Helps you**: practice an instrument deliberately — session logs, pieces broken
into passages, recital prep.
**End state**: a repertoire board that fills over months; recordings that prove
the progress your ears stopped hearing.
**Gezels**: Muziekmeester (music master, voorman); params: instrument.
**Tools**: `practice-store`; audio transcription for recording review.
**Craftbooks**: practice-session, piece-breakdown, monthly-recording-review,
recital-plan.
**Dashboard**: repertoire board + practice heat map.
**Needs**: whisper surfaced as a script capability for recording review.

**19. Job Hunt**
**Helps you**: run a search like a campaign — tracked applications, tailored
materials, researched interviews, compared offers.
**End state**: signed offer; a pipeline record that made the whole slog feel
navigable.
**Gezels**: Loopbaancoach (career coach, voorman) + Oefen-interviewer (mock
interviewer) — the second gezel *is* the feature: hard questions, kind debriefs.
**Tools**: `application-store` (pipeline stages).
**Craftbooks**: tailor-resume (builds on resume-cv *(catalog)*),
company-research-brief, mock-interview, offer-compare, weekly-pipeline-review.
**Dashboard**: pipeline board + this week's follow-ups.

**20. Family History**
**Helps you**: research the family tree, interview elders while you can, archive
photos, and write the family story.
**End state**: a tree, an audio archive with transcripts, and written chapters —
the thing every family means to do and doesn't.
**Gezels**: Stamboomvorser (genealogist, voorman) + Verhalenverteller
(storyteller).
**Tools**: `tree-store` (GEDCOM-ish records); audio transcription.
**Craftbooks**: interview-kit (questions tuned to the relative), record-a-relative
(transcribe-audio *(catalog)*), photo-caption-pass, family-story-chapter.
**Dashboard**: tree view + story shelf.
**Needs**: whisper script surface; photo intake enriches captioning.

### Communication (`communication`)

**21. Calendar Desk**
**Helps you**: plan the week, walk into every meeting prepped, and chase what fell
out of the last one.
**End state**: Monday starts with a plan; no meeting starts cold.
**Gezels**: Dagplanner (day planner, voorman).
**Tools**: calendar connector (read + propose).
**Craftbooks**: week-plan, meeting-prep-brief, followup-sweep,
standing-meeting-audit (which recurring meetings still earn their slot?).
**Dashboard**: week ahead + prep queue.
**Needs**: **calendar connector** — the headline gap for this category (the dialog
already shows the "Soon" tile).

**22. Newsletter**
**Helps you**: publish a recurring newsletter sustainably — idea bank, drafts,
edit passes, send-ready output.
**End state**: an unbroken publishing rhythm and a growing archive.
**Gezels**: Redacteur (editor, voorman) + Schrijver (writer) — the editor keeps
the calendar, the writer keeps the voice.
**Tools**: `issue-store` (idea bank, issue states).
**Craftbooks**: issue-plan, draft-issue, edit-pass (tone-rewrite *(catalog)*),
links-roundup, growth-review; social-thread *(catalog)* for promotion.
**Dashboard**: issue calendar + archive shelf.

**23. Club Secretary**
**Helps you**: run a club, association, or HOA — roster, agendas, minutes, dues,
announcements.
**End state**: meetings documented, dues current, institutional memory that
survives officer turnover.
**Gezels**: Secretaris (secretary, voorman) — the guild spirit, literally.
**Tools**: `roster-store` (members, dues, roles).
**Craftbooks**: agenda-draft, minutes-from-notes (transcribe-audio *(catalog)* for
recorded meetings), dues-chase, announcement-draft, agm-pack.
**Dashboard**: roster + next meeting + dues status.

**24. Correspondence Desk**
**Helps you**: keep up real correspondence — letters, thank-you notes, holiday
cards — and remember what you last said to whom.
**End state**: nobody who mattered goes unanswered; the holiday-card run is a
pleasure.
**Gezels**: Briefschrijver (letter writer, voorman) — unhurried, remembers
everyone.
**Tools**: `correspondent-store`; `render_image` for card art.
**Craftbooks**: letter-draft, thank-you-batch, holiday-card-run, address-refresh.
**Dashboard**: "owed a reply" list + correspondence log.
**Needs**: print pipeline for cards.

**25. Support Desk**
**Helps you**: give a small business a calm support queue — triage, drafted
replies in your voice, an FAQ that learns from every answer.
**End state**: inbox zero is routine; the FAQ answers half of tomorrow's mail
before it arrives.
**Gezels**: Steunpilaar (mainstay, voorman).
**Tools**: the existing mail pipeline; `case-store`.
**Craftbooks**: triage-pass, reply-draft, faq-distill (new answers → knowledge
base), weekly-themes-report.
**Dashboard**: queue state + FAQ growth.
**Needs**: nothing new — builds directly on the shipped email type. Cheapest
high-value type in the fifty.

**26. Topic Watch**
**Helps you**: follow topics you care about via feeds — a morning brief, weekly
deep dives, source-quality audits.
**End state**: informed without doomscrolling; a personal archive of what
mattered.
**Gezels**: Krantenlezer (newspaper reader, voorman) — skeptical, cites sources.
**Tools**: RSS/web-feed connector; `topic-store`.
**Craftbooks**: morning-brief, weekly-deep-dive (research-to-document
*(catalog)*), source-quality-audit.
**Dashboard**: today's brief + topic shelves.
**Needs**: feed connector + scheduled craftbooks.

### Code (`code`)

**27. Website**
**Helps you**: build and maintain a real site — portfolio, small business, band —
without being a developer.
**End state**: a live site the owner isn't afraid to update.
**Gezels**: Webbouwer (web builder, voorman) — asks about the bakery, not the
framework.
**Tools**: sandbox scripts; `run_playwright_script` for screenshots/checks; the
preview host serves the site itself.
**Craftbooks**: page-add, content-refresh, seo-pass (seo-meta-pack *(catalog)*),
site-check, ship *(catalog)*.
**Dashboard**: the site, live in the Output pane.

**28. Ops Desk**
**Helps you**: run scheduled scripts and operational rituals with runbooks,
incident notes, and status reports.
**End state**: the 2 a.m. problem has a runbook; the Monday report writes itself.
**Gezels**: Werkmeester (works master, voorman).
**Tools**: sandbox + schedules; `job-store` for run history.
**Craftbooks**: runbook *(catalog)*, root-cause-investigation *(catalog)*,
rollback-plan *(catalog)*, status-report *(catalog)*.
**Dashboard**: job board + last-run statuses.
**Needs**: nothing — near-total catalog reuse; the most technical-user type here
by design.

**29. Learn to Code**
**Helps you**: learn programming by building small real projects with a teacher
who reviews your work instead of doing it.
**End state**: a portfolio of shipped exercises and a concept map filling in.
**Gezels**: Codeleraar (code teacher, voorman) — Socratic; writes code only to
demonstrate, never to rescue.
**Tools**: sandbox `run_nodejs_script`; `progress-store`; params: language, goal.
**Craftbooks**: lesson-project, teachback-review, concept-explainer
(topic-explainer *(catalog)*), weekly-challenge.
**Dashboard**: concepts mastered + projects shipped.

**30. Home Automation**
**Helps you**: inventory smart-home devices, write automation recipes, get a
morning house report.
**End state**: the house runs on inspectable, versioned automations instead of
five vendor apps.
**Gezels**: Huisautomaat (house automator, voorman).
**Tools**: Home Assistant / MQTT toolset (new); `device-store`.
**Craftbooks**: automation-recipe, device-inventory, morning-report.
**Dashboard**: device board + automation log.
**Needs**: a home-automation toolset — wave 3; ships when the toolset exists.

### Photos & Media (`creative`)

**31. Photo Curator**
**Helps you**: turn the 40,000-photo camera roll into albums — deduped,
captioned, curated, printed.
**End state**: albums the family actually revisits; a year-in-review that makes
someone cry (the good way).
**Gezels**: Fotoarchivaris (photo archivist, voorman).
**Tools**: watched-folder connector; vision intake for captions/tags;
`album-store`.
**Craftbooks**: import-pass, album-curate, year-in-review, print-album-layout.
**Dashboard**: album grid + timeline ribbon.
**Needs**: watched folder + vision intake + print pipeline. Wave 2 flagship.

**32. Podcast Studio**
**Helps you**: plan episodes, research guests, transcribe recordings, produce show
notes and chapters, ship on schedule.
**End state**: a sustainable episode pipeline with an archive of transcripts.
**Gezels**: Programmamaker (producer, voorman) + Redacteur (editor).
**Tools**: whisper transcription (bundled engine); `episode-store`.
**Craftbooks**: episode-plan, guest-brief, transcribe-and-shownotes
(transcribe-audio + youtube-chapters-seo *(catalog)*), publish-checklist.
**Dashboard**: episode pipeline board.
**Needs**: whisper as a script capability.

**33. Video Workshop**
**Helps you**: take a video from idea to published — storyboard, script,
voiceover, subtitles, thumbnail.
**End state**: a repeatable production line for a channel or a business.
**Gezels**: Regisseur (director, voorman).
**Tools**: whisper; `render_image`; ffmpeg script primitive (new).
**Craftbooks**: video-storyboard *(catalog)*, voiceover-script *(catalog)*,
subtitle-generator *(catalog)*, thumbnail-generator *(catalog)*, edit-notes.
**Dashboard**: production board per video.
**Needs**: ffmpeg pipeline for the assembly steps; five existing craftbooks make
the planning half shippable early.

**34. Home Video Archive**
**Helps you**: index and preserve family footage — tape logs, transcripts, people
tags, highlight reels for birthdays and anniversaries.
**End state**: "find the clip of Opa's 80th toast" takes ten seconds.
**Gezels**: Filmarchivaris (film archivist, voorman).
**Tools**: whisper; ffmpeg (new); `clip-store`.
**Craftbooks**: tape-log, transcribe-index, highlight-reel-plan, anniversary-cut.
**Dashboard**: timeline by person and year.

**35. Comic Maker**
**Helps you**: write and illustrate a comic or children's book — consistent
characters, page spreads, print layout.
**End state**: a printable illustrated book starring, say, your kid and their dog.
**Gezels**: Tekenaar (illustrator, voorman) + Verhalenverteller (storyteller).
**Tools**: `render_image` (sd-cpp); character-sheet consistency kit (new).
**Craftbooks**: character-sheet, page-spread (script → panels → images),
style-guide, print-layout.
**Dashboard**: page gallery.
**Needs**: image-consistency workflow (reference/seed reuse) + print pipeline.

### Writing (`writing`)

**36. Novel Writing Room**
**Helps you**: write long-form fiction — outline, character bible, chapter
drafts, revision passes, submission prep.
**End state**: a finished manuscript and a bible that kept book two consistent.
**Gezels**: Schrijfmaat (writing companion, voorman) — critiques, challenges,
never ghostwrites unless asked.
**Tools**: `manuscript-store` (word counts, chapter states).
**Craftbooks**: outline-act, character-dossier, chapter-review, revision-pass,
query-letter.
**Dashboard**: word-count march + chapter board.

**37. Memoir Studio**
**Helps you**: get a life story out of your head (or a parent's) — guided
interviews, transcription, chapters woven from the sessions.
**End state**: a bound memoir that exists because the interviews finally happened.
**Gezels**: Luisteraar (listener, voorman) — interviews *you*; follows the thread
of feeling, not chronology.
**Tools**: whisper; `session-store`; photo pairing.
**Craftbooks**: memory-prompt-session, transcribe-and-draft, chapter-weave,
photo-pair.
**Dashboard**: life timeline filling in.
**Needs**: whisper script surface; print pipeline for the bound end state.

**38. Songwriting Notebook**
**Helps you**: keep every lyric fragment, chord chart, and demo note in one place;
finish songs instead of starting them.
**End state**: a songbook and a setlist, versions preserved.
**Gezels**: Liedjesschrijver (songwriter, voorman) — rhyme and meter help on tap,
taste kept humble.
**Tools**: `song-store` (versions, keys, states).
**Craftbooks**: lyric-session, chord-chart, song-version-log, setlist-builder.
**Dashboard**: songbook shelf.

### Games (`game`)

The modality question resolves by the params rule: **genre is a param; workflow is
a type.** Making a web game, making assets for an engine, writing interactive
fiction, and modding an existing game are different loops — four types. Platformer
vs. shmup is a param on one type.

**39. Web Arcade**
**Helps you**: build a playable browser game — canvas scaffold by genre, level
design, a "juice" pass, playtesting.
**End state**: a game your friends play in the Output pane; the dashboard *is*
the game.
**Gezels**: Spellenmaker (game maker, voorman); params: genre (platformer /
puzzle / shooter / idle).
**Tools**: sandbox + preview host (client-side games are playable today).
**Craftbooks**: game-scaffold, level-design, juice-pass (screenshake, sound,
feel), playtest-report.
**Dashboard**: the playable game.
**Needs**: nothing for playable; persistent high scores need the page↔host bridge.

**40. Asset Foundry**
**Helps you**: produce game assets only — sprite sheets, tilesets, portraits,
style-consistent batches — for use in Unity/Godot/wherever.
**End state**: an organized, style-locked asset library with a manifest.
**Gezels**: Assetsmid (asset smith, voorman).
**Tools**: `render_image`; consistency kit (new); `asset-store` manifest.
**Craftbooks**: sprite-sheet *(catalog)*, tileset-batch, character-turnaround,
style-guide.
**Dashboard**: asset gallery.

**41. Interactive Fiction**
**Helps you**: write a branching story — passage drafts, branch maps, playthrough
tests, ending audits.
**End state**: a playable story in the Output pane; the most accessible "I made a
game" there is.
**Gezels**: Verhalenbouwer (story builder, voorman).
**Tools**: story compiler script → self-contained playable page (works today).
**Craftbooks**: branch-map, passage-draft, playthrough-test, ending-audit (is
every ending reachable?).
**Dashboard**: the playable story + branch map.

**42. Mod Workshop**
**Helps you**: mod an existing game — scaffolds per game, asset pipelines,
compatibility checks, publishing.
**End state**: a published mod with a changelog and a compat matrix.
**Gezels**: Modmaker (voorman); params: game (Minecraft datapacks first).
**Tools**: sandbox; per-game toolchains (new, incremental).
**Craftbooks**: mod-scaffold, compat-check, changelog-and-publish (version-bump
*(catalog)*).
**Dashboard**: mod state + compat matrix.
**Needs**: per-game toolchain work — wave 3; start with the zero-toolchain case
(Minecraft datapacks are just JSON).

**43. Puzzle Almanac**
**Helps you**: generate custom crosswords, word searches, and logic puzzles —
personalized, validated, print-ready.
**End state**: a monthly puzzle pack starring the grandkids' names; playable on
screen, printable for the kitchen table.
**Gezels**: Puzzelmaker (puzzle maker, voorman).
**Tools**: generator + validator script-tools (constructed, then *verified*
solvable — this is what script-tools are for).
**Craftbooks**: crossword-forge, puzzle-pack-layout, difficulty-tune.
**Dashboard**: puzzle of the week (playable client-side) + pack shelf.
**Needs**: print pipeline for packs.

**44. Tabletop Campaign Forge**
**Helps you**: run a D&D/RPG campaign — world bible, NPCs with portraits, session
prep, recaps, encounter balance.
**End state**: a campaign chronicle players re-read between sessions.
**Gezels**: Spelleider (game leader, voorman) — the GM's co-conspirator; never
spoils, always prepped.
**Tools**: `campaign-store` (wiki-shaped); `render_image` for NPC portraits.
**Craftbooks**: session-prep, npc-forge, recap-chronicle, encounter-balance,
lore-entry.
**Dashboard**: chronicle + NPC gallery.

### Data (`data`)

**45. Research Notebook**
**Helps you**: run a real inquiry on any topic — sources logged, claims checked,
briefs produced.
**End state**: a defensible brief with citations, and a question board that shows
what's still open.
**Gezels**: Onderzoeker (researcher, voorman) — distinguishes "I read it" from "I
verified it."
**Tools**: `source-store` (sources, claims, verdicts); web toolset.
**Craftbooks**: research-to-document *(catalog)*, source-log, claim-check,
weekly-digest.
**Dashboard**: question board + brief shelf.

**46. Collection Catalog**
**Helps you**: catalog any collection — vinyl, stamps, minerals, sneakers —
photographed, identified, valued, insured.
**End state**: a gallery-grade catalog plus the insurance inventory nobody has
until the day they desperately need it.
**Gezels**: Conservator (curator, voorman); params: collection kind.
**Tools**: `collection-store`; vision intake for identification.
**Craftbooks**: item-intake, valuation-pass, insurance-inventory, wishlist-watch.
**Dashboard**: gallery grid + collection stats.
**Needs**: manual entry day one; photo identification wants vision intake.

**47. Survey Lab**
**Helps you**: design a survey, analyze the responses, and report findings —
rigorously, without a stats degree.
**End state**: a findings report that would survive a methods question.
**Gezels**: Vragensteller (question asker, voorman) — obsesses over question
neutrality.
**Tools**: csv-transformer + dataset-clean *(catalog)* mechanics.
**Craftbooks**: survey-design, survey-analysis *(catalog)*, findings-report
(whitepaper *(catalog)*).
**Dashboard**: response stats + findings shelf.

### Events & Journeys (`events`, new)

**48. Event Planner**
**Helps you**: plan a wedding, reunion, or big party — guests, budget, vendors,
timeline, invitations, day-of runbook, thank-yous.
**End state**: the day goes beautifully *and* the thank-you notes actually go out.
**Gezels**: Ceremoniemeester (master of ceremonies, voorman) — the name the role
was born for; params: event kind, date.
**Tools**: `guest-store` (RSVPs), budget `ledger-store`; `render_image` for
invitation art.
**Craftbooks**: guest-list-manage, vendor-compare, day-of-runbook (runbook
*(catalog)*), invitation-design, thank-you-sweep.
**Dashboard**: countdown + budget + RSVP board.

**49. Trip Planner**
**Helps you**: research and plan a trip — itinerary, bookings binder, packing
lists, day plans — then journal it as you go.
**End state**: a smooth trip and, afterward, a travel journal + album worth
keeping.
**Gezels**: Reisleider (travel guide, voorman); params: destination, dates.
**Tools**: `itinerary-store`; web toolset for research.
**Craftbooks**: itinerary-draft, packing-list, day-plan, travel-journal-entry,
trip-album.
**Dashboard**: itinerary timeline; flips to journal/album view after the trip.

**50. Fundraiser HQ**
**Helps you**: rally a community drive — goal tracking, sponsor outreach,
progress posts, thank-yous, a wrap report.
**End state**: goal met, every donor thanked, a report the next organizer starts
from.
**Gezels**: Aanjager (rallier, voorman) — infectious, organized.
**Tools**: pledge `ledger-store`.
**Craftbooks**: sponsor-outreach, progress-update-post (social-thread
*(catalog)*), thank-you-run, wrap-report.
**Dashboard**: the thermometer + sponsor wall.

### The bench

Strong ideas held in reserve — each one earns a slot the moment its gap closes or
a category thins: Homeschool Planner (per-child curriculum + worksheet printing),
Poetry Chapbook (form-of-the-week practice → printed chapbook), Audiobook Studio
(**TTS-gated**), Car & Vehicle Log, Wardrobe / Declutter Coach (vision-gated),
Dream Journal, Chess Study (engine toolset), Neighborhood Association Desk (Club
Secretary variant via params).

## Missing affordances — shapes gezel doesn't have yet

Designing fifty types against the real manifest schema is a stress test of the
platform. The same gaps recur; closing them is what makes a fifty-type catalog
*maintainable* rather than heroic. Ordered by leverage:

**1. A type-kit standard library (the store family).** The Language Trainer's
`progress-store` generalizes into four store shapes that between them power ~45 of
the fifty types: **log-store** (append events, derive streaks/totals — fitness,
journal, practice), **roster-store** (people/things with states — guests, members,
applications, pets), **ledger-store** (money in/out with categories — budget, tax,
invoices, pledges), **review-queue** (spaced repetition — study, flashcards,
quote retention). Today each type author hand-writes these as SDK scripts. Ship
them as `@bendyline/gezel-sdk` helpers with tested schemas, and authoring a new
type drops from days to hours — the single biggest multiplier on catalog velocity.

**2. Scheduled-craftbook wiring.** The manifest's `schedules[]` rail is spec'd,
consent-gated — and listed under "Later" in the rollout. Rituals are the heartbeat
of nearly every growth/home type (daily lesson, weekly walkthrough, quarterly tax
summary). Until schedules actually fire craftbooks, "data that accrues" depends
entirely on the user remembering to show up. This is the highest-priority pending
item from the original spec.

**3. An intake rail: file → structured record.** Fourteen types want the same
pipeline: point at a photo/PDF/audio file, get a typed record (receipt → ledger
entry, recipe card → recipe, tape → transcript + index). The pieces exist —
whisper.cpp is bundled, providers have vision, PDFs are readable — but there is no
composable "intake" primitive a type can declare. Ship it once (an SDK helper +
capability), and Tax Shoebox, Recipe Book, Photo Curator, Collection Catalog,
Memoir Studio, and Family History all light up.

**4. Whisper as a script capability.** The engine ships with the app, but SDK
scripts can't declare "I need transcription." Six types (Podcast, Memoir, Music
Practice, Family History, Home Video, Club Secretary) want exactly that. Smallest
gap on this list relative to unlocked value.

**5. Connector kinds beyond mail.** The mail pipeline proved the shape: external
data synced into project-local canonical files, then everything downstream is
ordinary gezel machinery. PARTIALLY SHIPPED: **social feeds** (Bluesky/X/
Instagram — the Social Feed and Image Feed types, with Bluesky publishing
through the outbox consent flow) landed with the marketing/social family,
and connector corpora are now content-indexed so gezels can search synced
records. Still open: **calendar** (Calendar Desk — already a "Soon" tile),
**feeds/RSS** (Topic Watch), **watched folder** (Photo Curator, CSV drops for
Budget/Shop Numbers), **CSV drop** as a degenerate watched folder. Same
consent posture as mail; per-kind drivers.

**6. Interactive Output pages (the page↔host bridge).** SHIPPED (Phase 1a): the
`pages.tools` allowlist + page-invoke route + HtmlPreviewFrame postMessage relay,
plus tool `reaction`s that summon a gezel turn from a page action — proven by the
Checkers and Flashcards exemplars. The bridge exposes *only* the type's declared
script-tools, keeping the security model unchanged. Phase 1b SHIPPED: the
versioned `window.gezel` Output Pane API (docs/output-pane-api.md) — injected
shim, in-bridge reads with centralized watch, server-side tool-input
validation — with the v0 sentinels kept for shipped pages. Remaining platform
caveat: scripts (and therefore interactive pages) need a Windows denyNet
boundary.

**7. A print/PDF pipeline.** The most uplifting end states are physical: the
heirloom cookbook, the emergency sheet, the puzzle pack, the invitation, the
chapbook, the invoice. One sandboxed render-to-PDF primitive (HTML → PDF is
enough) serves eight types. Nothing about it is exotic; it just has to exist.

**8. Image-consistency kit.** sd-cpp generates images; Comic Maker and Asset
Foundry need *the same character again* — reference images, seed reuse, style
anchors persisted per project (the poppetje lesson applied to content: persist
the resolved identity, don't re-derive it).

**9. Crew declarations.** The manifest supports multiple gezels, and
`message_gezel` exists — but the *choreography* (editor reviews writer's chapter;
mock interviewer debriefs with coach) currently lives as prose in about.md.
A lightweight "crew ritual" convention — craftbooks that name which role performs
which step — would make two-gezel types (Newsletter, Job Hunt, Podcast, Comic
Maker) feel like an actual crew rather than two adjacent chats.

**10. Params depth.** Genre/kind enums with conditional follow-ups (choose
"platformer" → get platformer-specific params) keep one type per workflow. The
JsonEditor form handles flat schemas today; conditionals are the ask.

**11. A per-type quality gate.** At fifty types, gallery quality is the brand. Two
mechanisms: an **eval scenario per shipped type** in [evals/](../evals/) (the
arcade-deluxe pattern — instantiate the type with a mock provider, run its first
session and one craftbook, assert the dashboard changed), and the **upgrade/drift
UI** already listed as "Later" — at this scale, versioned types without a
reconcile surface will bite.

**12. A "stays on this device" badge.** Not an engine — a product affordance.
Caregiving Binder, Mind Journal, Life Binder, and Tax Shoebox are chosen
*because* the data never leaves the machine. Say it in the gallery, on the type
card, in the project header. It is the moat, stated out loud.

**13. The community registry.** `.gzl` export/import ships; what's missing is the
place — submission, review (the import-review gate already enumerates
capabilities), and a browsable community shelf in the gallery. The fifty
first-party types set the quality bar; the registry turns the catalog into a
flywheel.

## Sequencing

**Wave 1 — compose from what exists** (no new platform work; hand-written stores
as language-trainer does today). **Shipped July 2026** — all twelve below are
bundled, tested (`wave1.test.ts`), and supervised; see
[wave1-supervision.md](wave1-supervision.md). A first-ship dozen
chosen for category breadth, including three types each to light `home`,
`money`, and `events`:

| Category | Types |
|---|---|
| Home & Family | Household Manual, Meal Planner & Pantry, Caregiving Binder |
| Money & Small Business | Household Budget, Freelance Office, Life Binder |
| Events & Journeys | Event Planner, Trip Planner, Fundraiser HQ |
| Personal Growth | Fitness Coach, Study Buddy |
| Writing | Novel Writing Room |

Fast follows in the same wave (still zero new primitives): Habit Forge, Reading
Circle, Mind Journal, Job Hunt, Newsletter, Support Desk, Club Secretary,
Tabletop Campaign Forge, Interactive Fiction, Research Notebook, Survey Lab,
Ops Desk, Website, Learn to Code, Shop Numbers, Songwriting Notebook, Pet
Companion, Move Planner, Web Arcade (playable; scores deferred).

**Wave 2 — ships as the kit lands.** Ordered by which affordance unlocks them:
type-kit stores (everything gets cheaper); schedules wiring (all ritual types
get their heartbeat); whisper surface (Podcast Studio, Memoir Studio, Music
Practice, Family History); intake rail + vision (Tax Shoebox photo receipts,
Family Recipe Book, Collection Catalog, Garden pest-diagnosis); connectors
(Calendar Desk, Topic Watch, Photo Curator); print pipeline (Correspondence
Desk, Puzzle Almanac, invitations, invoices); page bridge (interactive Study
Buddy, Web Arcade scores, RSVP boards); consistency kit (Comic Maker, Asset
Foundry).

**Wave 3 — new engines and toolsets.** ffmpeg pipeline (Video Workshop, Home
Video Archive), home-automation toolset (Home Automation), per-game toolchains
(Mod Workshop beyond datapacks), TTS engine (Audiobook Studio, off the bench).

## Measuring whether it works

- **Type adoption**: share of new projects created from a non-general type. The
  storefront metric.
- **Day-7 dashboard return**: user re-opens a typed project's Output page within a
  week. The "data accrues" metric — the one that predicts retention.
- **Ritual uptake**: schedule opt-in rate and craftbook runs per typed project per
  week.
- **Crew depth**: sessions per type's gezel beyond the first day.
- **Flywheel**: `.gzl` exports, imports, and (once the registry exists) community
  submissions.

Per-type, these tell us which compositions actually produce practices — and which
are costumes to fix or retire.

## Risks and rules

- **Thin types are worse than no types.** Enforce "no costume without tools" in
  review; every gallery entry must mutate real data and move a dashboard.
- **Category sprawl.** The ≥3-strong-types rule holds; "More" absorbs experiments.
- **Maintenance at scale.** Fifty types × versions is real surface. The kit stdlib
  (gap 1) and the per-type eval gate (gap 11) are the mitigations — types built
  from shared, tested stores break together and get fixed together.
- **Consent posture.** Schedules, connectors, and intake all touch the trust
  model. The spec's line stands: nothing installs, syncs, or fires silently.
- **Tone drift.** The Dutch role-naming and the warmth are the brand. Names like
  Ceremoniemeester and Stille Vriend are not decoration; they are the product
  telling the user what kind of relationship this is. Review type copy the way we
  review UI — against [docs/ux.md](ux.md).

## Where this goes next

1. Land the type-kit stores and schedules wiring (gaps 1–2) — they pay for
   themselves inside wave 1.
2. Build the first-ship dozen against the kit, each with an eval scenario.
3. Add `home`, `money`, `events` to `ProjectTypeCategorySchema` and the category
   registry when their first types land.
4. Sequence wave 2 by affordance, not by type — each platform gap closed lights up
   several types at once.
5. Open the registry when the first-party catalog reaches ~30 types and the
   upgrade/drift UI exists.

Fifty benches, each with a companion standing at it. That's the product.
