# Connections a draft calls for

A person writes a message that names something a connector could bring in: a
web address today, a GitHub repository or a shared folder later. Gezel finds
it while they write, says what Send will do, does it, and hands the result to
the turn. This page is the contract for that path. The website connector is
the first user; its own contract is [website-connector.md](website-connector.md).

## The pieces

| Piece | Where | What it owns |
| --- | --- | --- |
| Rules | [core prompt-connectors/](../packages/core/src/prompt-connectors/index.ts) | What in the words a connector type serves. Pure, shared by the composer and the daemon. |
| Resolvers | [service prompt-connectors/](../packages/service/src/prompt-connectors/) | Per rule: what is still open, how to take it, what a turn gets. |
| Routes | [routes/prompt-connectors.ts](../packages/service/src/http/routes/prompt-connectors.ts) | `POST /api/projects/:id/prompt-connectors/offers` and `/accept`. First-party only. |
| Strip | [ComposerConnectorStrip.tsx](../packages/ui/src/components/ComposerConnectorStrip.tsx) | One row per offer above the To line; takes open offers before any send. |
| Turn block | `resolveTurnNamedItems` in [chat/manager.ts](../packages/service/src/chat/manager.ts) | Puts saved copies of what the message names in front of the person's words. |
| Message rows | [MessageInclusions.tsx](../packages/ui/src/components/MessageInclusions.tsx) | Under the sent message: the saved copy, its synopsis, a link to the file. |

## Rules

A rule (`PromptConnectorRule`) has an id, the catalog connector type it
serves, an **effect**, and `find(draft)`, which returns the subjects it claims
with a label a person reads. Rules run most specific first, and a subject one
rule claimed is not offered by a later one. `web-page` claims every web
address and goes last.

The effect decides what an offer is:

- **`include`**: the connector can fetch that one thing with nothing more from
  the person. The strip is a notice ("… will be saved here and included in the
  chat"), and Send takes it.
- **`connect`**: a connection needs setting up (a sign-in, a choice of
  folder). The strip offers a **Connect…** key that opens the form. Send never
  takes it.

At most three candidates are shown for one draft
(`MAX_PROMPT_CONNECTOR_CANDIDATES`), so a person can read everything Send will
do.

## Offers and taking one

`offers(project, text)` runs the rules, then asks each rule's resolver which
candidates are still **open**: a page with a saved copy is not offered again.
It offers nothing when connector data is off in the security policy
(`allowConnectorData`), when this install's catalog has no such connector
type, or when the resolver refuses the subject. Finding offers never reaches
the network.

`accept(project, rule, subject)` rebuilds the candidate from the rule (a
subject the rule would not claim is refused), then calls the resolver. For
`web-page` that is `WebsiteService.savePage`. The answer is a
`PromptInclusion`: with a `path` when a copy was saved, or with a `reason`
when it was not.

Both routes refuse session tokens ([scope-guard.ts](../packages/service/src/http/scope-guard.ts)):
taking an offer fetches for the person, exactly as Save page does. A gezel
still asks with `request_web_page`.

## Send

The composer calls `beforeSend(text)` on the strip from every path that sends
the draft (Send, Nudge, Interrupt). It asks the daemon for offers again with
the words as sent, because the strip's own list lags typing, then takes each
open `include` offer the person did not dismiss and waits for all of them.

- A dismissed offer (the × key) is not taken, for as long as that composer
  stays open on the project.
- **Save now** takes one early. Send then waits for that same save.
- A save that failed under the person's eyes is theirs to retry. Send does not
  repeat it.
- Send is never held more than 60 seconds (`SEND_WAIT_MS`), and a daemon that
  cannot answer holds it not at all.

The fetch is the person's act: their words, their Send, with the address and
the × in front of them. The row shows host and path, marks a query as `?…`,
and carries the whole address in its tooltip.

## What the turn gets

On a person's turn the daemon finds the same candidates in the message and
asks each resolver for what it already holds (`turnContext`). Nothing is
fetched here. For a saved page the model reads, in front of the person's
words and nearer to them than indexed context:

- the page's title and address, and the path of the saved copy in the
  project's artifacts;
- a summary: the synopsis the index wrote when there is one, else the page's
  own description, else its opening lines, labeled as which;
- the page's text. A page that fits goes whole. A longer one keeps its opening
  and the passages that share words with the question, in page order, with
  `[…]` where text was left out ([page-digest.ts](../packages/service/src/prompt-connectors/page-digest.ts)).

The block opens with a line saying the text is untrusted evidence. It names
`read_web_page` or `read_artifact` only when the turn has that tool. In a
factual-writing session the page is numbered evidence the reply cites.

A page whose last save failed or was blocked gets a short note instead ("No
saved copy: …"), so the gezel says the page could not be read and does not
guess.

Budget: three times the indexed-context ceiling for the model's window, at
most 6,000 tokens, shared by the pages in one message
(`namedItemBudgetChars`). Indexed context for the same turn leaves the same
file out (`alreadyGiven`).

The stored user message carries `inclusions`, so the thread shows a row per
saved copy that opens the file, and the block itself is part of
`sentPreamble`, so a rebuilt session replays the turn as sent. A visitor of a
shared page gets none of this.

Summaries and the index: a saved page is an ordinary connector record, so the
artifacts index picks it up right after the save (keyword search). A
model-written synopsis is written by the enrichment pass, which runs only in
projects with a Librarian; until then the turn uses the page's own
description.

## Adding a connector

1. Write a rule in core and place it before any rule it is more specific
   than. A `github.com/<owner>/<repo>` rule before `web-page` makes that
   address a GitHub offer and never also a page to save.
2. Write a resolver for it and add it to `createPromptConnectors`
   ([index.ts](../packages/service/src/prompt-connectors/index.ts)). `open`
   is required; `accept` only for an `include` rule; `turnContext` only when
   the connector has something to hand a turn.
3. For a `connect` rule, pass `onConnect` to the strip from the composer so
   the key opens the Connections form. No rule ships with that effect yet.

The routes, the strip, the send paths, the turn block and the message rows
need no change. `service.test.ts` runs a second rule through all of it.

## Marks

Each row shows its connector type's mark (`ConnectorMark`): the catalog
artwork on the ground its family takes (`connectorTypeGround` in core
[catalog-ground.ts](../packages/core/src/catalog-ground.ts)), or a line glyph
where the catalog has none. Connector marks are Workshop Marks; the subjects
and how they were made are in gilde's `docs/catalog-artwork.md`.
