# Factual writing

A gezel that writes for people states facts from evidence and cites it. It
does not fill gaps from memory. This page is the contract: which sessions
it covers, what the model is told, how evidence is numbered, what is checked
and where, and what the check cannot do.

Local models get names, dates and relationships wrong fluently. A person
asked a writer in Word for George Washington's family tree and got several
wrong details. The answer was well formed and read as certain. Asking for
care in the prompt does not fix that. What helps is three things together:
give the model the evidence, make it point at the evidence for every fact,
and check that pointer mechanically before the text goes anywhere it will be
trusted.

## Who writes in factual mode

`resolveFactualWriting` in
[core grounding/factual-writing.ts](../packages/core/src/grounding/factual-writing.ts)
decides it once per session build. The order:

1. **The gezel's explicit setting.** `factualWriting: true | false` in
   `gezel.md` always wins. A person sets it on the gezel's page with the
   **Sources** keys: "By role", "Always cite" or "Off". The API is
   `POST /api/gezels/:id/settings` `{ factualWriting }`, with `null` to
   follow the role again.
2. **The role.** Researchers, reviewers and copywriters are covered by
   canonical role. So are titles that state facts for a living: writer,
   author, editor, journalist, reporter, historian, biographer, genealogist,
   librarian, archivist, Boekwachter, fact checker. Fiction is excluded by
   title (novelist, poet, screenwriter, Schrijfmaat). Invention is that job.
3. **The surface.** Any session that can write into a person's open
   document (`doc_insert_text`, `doc_replace_selection`, `slide_insert`) is
   factual whatever the role. Today that means the Office and LibreOffice
   add-ins. It is where an invented date does the most harm and is the
   least likely to be checked.

Document panes also default to a writer. When the person has not picked a
gezel for the document, the Office pane and the LibreOffice sidebar choose
one the daemon reports as `writesFactually` (`GezelSummary.writesFactually`,
computed by the daemon so no client keeps its own copy of the role rules).
They prefer the project's crew, then anyone, and only then fall back to the
lead or the Meester.

Visitor sessions are never factual. They have no tools.

A factual session keeps its lookups. Cloud models normally lose
`wikipedia_search` / `wikipedia_read` on the theory that they read Wikipedia
in training. But a memory cannot be cited, so `computeToolAllowlist({
factualWriting: true })` keeps both tools on every tier. The prompt and
bridge surfaces get the same flag.

## What the model is told

One standing block, `## Facts and sources`, rendered by
`factualWritingGuidance` into the stable band of the system prompt after the
markdown guidance (`factualWriting` layer in `GEZEL_PROMPT_BREAKDOWN`). It is
imperative and short:

- State a specific fact only when evidence in this conversation shows it:
  indexed context, a tool result, or what the person said.
- Cite the evidence number after each sentence that uses it: `[3]`. Never
  make a number up.
- The numbers exist only in the conversation. In a file it writes (an
  artifact, a workspace file, a task deliverable) the gezel names the source
  itself, or follows the citation format its craftbook step gives. Otherwise a
  `citationsResolve` gate would see numbers it cannot resolve, and so would
  a reader.
- Not in the evidence? Look it up first. The block names only the lookup
  tools the session actually has (`search`, `wikipedia_search`,
  `wikipedia_read`, `web_search`, `fetch_url`, `read_document`).
- Still not found? Leave it out, or say plainly it could not be verified.
  Never smooth over a gap with a plausible detail.
- Keep the source's certainty.

Providers that run their own tool loop (Copilot, the CLI providers) never
reach gezel's bridge, so nothing is numbered for them. Their block asks for
a named source after each fact instead.

## `[n]`, not URIs

Evidence numbers are short integers the runtime assigns. A small model
copies `[3]` reliably. It mangles a 90-character `knowledge://` URI, and
worse, it composes plausible ones. A number either exists in the session's
evidence list or it does not, so a made-up citation is detectable in
microseconds.

## The evidence ledger

[chat/evidence-ledger.ts](../packages/service/src/chat/evidence-ledger.ts)
holds one session's evidence:

- **Retrieval rows.** Each indexed-context excerpt injected with a turn gets
  a number. The row header reads `[7] [knowledge] knowledge://… — Title`, and
  the block header says to cite by that number
  (`retrieveProjectContext({ citeHit })`).
- **Evidence tool results.** A successful result from a tool in
  `EVIDENCE_TOOLS` gets a header line before the text the model sees:
  ``[4] Evidence from `wikipedia_read` — Wikipedia: George Washington. Cite
  facts from it as [4].`` It is applied in `McpBridge.callToolRich` through the
  session's `grounding` hooks, after the output cap, so the ledger holds
  exactly what the model saw. The batch readers (`read_files`,
  `read_artifacts`) count like their single-file twins, numbered once per
  file section.
- **Refusal remedies follow the source.** When the session's evidence so far
  came from a workspace reader, or the person's messages name source files,
  a refused write is sent back to `read_file` on those files rather than to
  `search`. Searching for text a writer already read cost the core synthesis
  scenarios 3-5x their wall-clock on 2026-10-05/06.
- **What the person said.** All of the person's messages in the session
  count as evidence that needs no citation. Restating someone's own facts
  back to them is not invention.

Numbers are session-wide and never restart. The same text from the same
place keeps its number. After a daemon restart the ledger is rebuilt from
the transcript's `grounding` records. Numbers issued before the restart stay
valid, but their text is gone, so a sentence citing one is reported `cited`
rather than checked.

## What is checked

[core grounding/citations.ts](../packages/core/src/grounding/citations.ts)
splits text into prose sentences, attaches each `[n]`, and extracts the
details a person could check: years, numbers (thousands separators and
spelled small numbers match), months, quotations of three words or more, and
capitalized names. Every detail must appear in the text of the evidence the
sentence cites. A quotation is normalized like the evidence (case, line
breaks, thousands separators), loses the writer's punctuation at its edges,
and matches piece by piece across an ellipsis. A year or number must also sit
near the sentence's rarest name, but only in a source that states both:
a number taken from a different source is a synthesis the check cannot judge.
Each sentence ends up as one of:

| Status | Meaning |
|---|---|
| `supported` | Every detail is in the cited evidence, or in the person's own words. |
| `unattributed` | Every detail is in *some* evidence, just not what the sentence cites, or it cites nothing. A citation slip, not an invention. |
| `uncited` | States details no evidence shows, and cites nothing. |
| `unsupported` | Cites evidence, but states details that neither it nor any other evidence shows. |
| `bad-citation` | Cites a number that is not in the evidence list. |
| `cited` / `non-factual` | Nothing checkable: connective prose, opinion. |

**Document writes are refused.** Before `doc_insert_text`,
`doc_replace_selection` or `slide_insert` is forwarded to the app, the text
is checked. If any sentence is `uncited`, `unsupported` or `bad-citation`, the
call is refused with each sentence and the detail no evidence shows, and the
model is told to look it up, drop it, or say it is unverified. After two
refusals of one tool in one turn the third attempt goes through. The reply
then carries a warning that names how many statements went into the
document unverified. A turn that can never write anything is worse than one
the person is told to check. Passing text has its `[n]` markers removed
before it reaches the document. Indentation and Markdown links are kept.

**Prose files are refused too.** `write_file`, `write_artifact` and
`write_document` of a `.md`, `.txt`, `.rst` or similar file get the same
check. `[n]` numbers do not bind inside a file, so each fact is checked
against all the evidence, not just what a marker names. A file that cites
`[n]` gets a `## Sources` list at its foot that maps each number to its
title and link, unless it already lists its own sources. Code and data files
are never checked. This exists because a writer asked to "write a paragraph
about Martha Washington's children" saved one from memory with four wrong
facts, and its chat reply was a single line naming the file.

A refusal names the session's lookup tools and the call to make next. Told
only to "look it up", Gemma 4 31B instead told the person it had no sources
and asked for some, with `wikipedia_search` on its roster.

**Clamps keep the lookups.** "Write a paragraph about…" reads to the runtime
as an immediate file write, and that clamp narrows a turn to `write_file`
alone. In a factual session, `resolveSessionToolSurface` puts the lookup
tools back after every message-shaped clamp and protects them from the
tier cap. Without that, the factual rule asks for research the turn cannot
do.

**Replies are annotated, not blocked.** Every factual-mode reply gets a
`ChatMessage.grounding` record: the numbered evidence it cites plus whatever
the turn added (with a 600-character excerpt each), the status counts, and up
to 20 problem sentences, worst first. In the chat the markers become links
and a Sources row lists the evidence and the unsourced statements (see
[ux.md](ux.md)).

## What the check cannot do

It checks the text, not the world:

- A model that copies a wrong date out of a wrong source passes.
- A wrong *relationship* between true names passes: "Lawrence was George's
  son" when the evidence names both men.
- A sentence with no checkable detail is never `supported`, only `cited`.
- A number the writer computed ("30,000 EUR more than the finance sheet")
  appears in no source, so it reads as invented. Cite the inputs and state
  the arithmetic, or leave the number out.

The answer to these is not a bigger regex. It is a narrow model check of the
flagged sentences, kept for later and measured with the factuality bench
first.

## Measuring it

`pnpm --filter @bendyline/gezel-evals run factuality -- --home <dir> --gezel <id>`
([evals/src/bin/factuality.ts](../evals/src/bin/factuality.ts)) asks 20
family-history questions about George Washington. Each reply is graded claim
by claim against a fixed answer key
([washington.ts](../evals/src/factuality/washington.ts)). Only a
contradiction of the key counts as an error. A claim the key does not cover
is reported as unverified. Run it once per arm: a gezel with
`factualWriting: false` against the same gezel with it on.
