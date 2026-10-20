# Connector live testing

Everything in [connector-standards.md §8](./connector-standards.md#8-testing-a-connector)
tiers 1–3 runs in CI against provider fakes. This document is tier 4: the accounts,
apps, and runs that prove the fakes match the real services. It is the last mile —
an adapter that passes against a fake but meets a different API shape in the wild
fails here, and the fix is usually to the fake as much as the adapter.

## The accounts to create

Use dedicated test accounts, never a personal mailbox: the live check writes a full
corpus to disk, and the write-back checks put real drafts in the account.

| Provider | Account | Why this one | Cost |
|---|---|---|---|
| Google | A dedicated Gmail account (e.g. `gezel.connectors.test@gmail.com`) | Gmail, Calendar, Drive, YouTube all from one account and one OAuth app | Free |
| Google Workspace | Optional: a Business Starter seat on a test domain | Only needed for shared drives and admin-consent behavior | Trial, then ~$7/user/month |
| Microsoft work/school | A Microsoft 365 Business Basic tenant with one user | Mail, Calendar, OneDrive for Business, SharePoint, admin consent for `Sites.Read.All` | ~$6/user/month; trial available |
| Microsoft personal | A dedicated Outlook.com account | The `consumers` tenant: Outlook.com mail, calendar, personal OneDrive | Free |
| IMAP | Fastmail (trial) or iCloud Mail with an app-specific password | A standards IMAP server that is not Gmail or Exchange | Free/trial |
| X | A developer app at console.x.com with a few dollars of credits | Reads are pay-per-use; the free tier closed to new developers in Feb 2026 | Pay-per-use |
| Bluesky | A free account plus an app password | | Free |
| Instagram | A Business or Creator account, added as a tester on a Meta app using Instagram Login | Testers need no app review | Free |
| LinkedIn | A developer app tied to a test Company Page with "Share on LinkedIn" and "Sign in with LinkedIn using OpenID Connect" | Both products are self-serve; reading posts needs partner approval, so LinkedIn is publish-only | Free |
| RSS | None | Public feeds | Free |

The Microsoft 365 E5 developer sandbox is no longer a dependable option: since 2024 it
is eligibility-gated (usually a Visual Studio Professional/Enterprise subscription or a
partner program), and new sign-ups are often refused. A one-seat Business Basic tenant
is the reliable route.

## Registering the apps

Gezel ships no OAuth client, so the test install registers its own — the same
bring-your-own path a person uses, which is part of what this run tests. Each manifest's
`secretShape.clientSetup.steps` is the click path; the essentials:

- **Google Cloud project** (one serves every Google type): enable the Gmail, Google
  Calendar, Google Drive, and YouTube Data v3 APIs. OAuth consent screen External, add
  the test account as a test user, then set publishing status to **In production** —
  Testing mode expires refresh tokens after 7 days, which would make the live run fail
  weekly for a reason that is not a bug. Create an OAuth client of type **Desktop app**.
  Create a separate **API key** restricted to the YouTube Data API v3 for
  `youtube-videos`. `https://mail.google.com/` and `drive.readonly` are restricted
  scopes: fine for an unverified app used by its owner.
- **Microsoft Entra app registration** (one serves every Microsoft type): supported
  account types "any organizational directory and personal Microsoft accounts"; add the
  Mobile and desktop platform with the loopback redirect; public client, no secret.
  Delegated permissions: `offline_access`, `Mail.ReadWrite`, `Mail.Send`,
  `Calendars.Read`, `Files.Read`, `Sites.Read.All`. Grant admin consent for
  `Sites.Read.All` in the Business Basic tenant.
- **X**: OAuth 2.0 Native app with PKCE, callback `http://127.0.0.1:6241/callback`.
- **Instagram**: Meta app with Instagram Login, callback `http://127.0.0.1:6242/callback`,
  the test account added as an Instagram tester.
- **LinkedIn**: callback `http://127.0.0.1:6243/callback`.

Register the client IDs in the app (the Connections tab's setup panel) or set the
`GEZEL_*_CLIENT_ID` / `_SECRET` env vars the manifests name.

## Seeding the accounts

The fakes' seed data (top of [world.ts](../packages/service/src/connectors/testing/world.ts))
is the shape to reproduce, because each item exercises a code path:

- **Mail**: a thread with replies on different days; an HTML-only newsletter; a message
  with an attachment; a non-UTF-8 message; a message with a prompt-injection body (it
  must land as a quarantined stub); a message later moved to another folder; enough
  older mail (a few hundred) to make the first sync page.
- **Calendar**: a recurring weekly meeting; a meeting rescheduled into the next month
  (moves directories); an all-day event; a cancelled meeting; an event on a second
  calendar; an event with a Meet/Teams link and attendees.
- **Files**: a folder tree three deep with a Google Doc, Sheet, and Slides deck, a
  Markdown file, a PDF, a file over 25 MB; then rename one file, move one between
  folders, and trash one.
- **Feeds**: one RSS 2.0 feed, one Atom feed, a YouTube channel feed URL.

## Running the live acceptance check

1. Start Gezel against a test home (`pnpm app` uses `~/.gezel-dev`).
2. In one project, link every account from the Connections tab. Linking is part of the
   test: each OAuth flow, the bring-your-own setup panel, and the first sync run the way
   a person sees them.
3. Run the check against that daemon:

   ```powershell
   $env:GEZEL_CONNECTOR_LIVE = '1'
   $env:GEZEL_LIVE_HOME = "$HOME\.gezel-dev"
   $env:GEZEL_LIVE_PROJECT = '<project id>'
   $env:GEZEL_LIVE_REPORT = "$HOME\connector-live-report.json"
   Set-Location packages\service
   & ..\..\node_modules\.bin\vitest.CMD run src/connectors/testing/live-acceptance.test.ts
   ```

   Per binding it syncs until the first backfill settles, asserts the corpus invariants
   and the family's expected frontmatter keys, checks `_meta.json`, and confirms a second
   sync is quiet. `GEZEL_LIVE_ONLY` narrows the run to some bindings or types.
4. Exercise write-back by hand once per family: ask a gezel to "draft a reply to the
   latest email and save it to my drafts" (`save_email_draft`), check the draft appears
   in Gmail/Outlook/the IMAP Drafts folder, and that nothing was sent.
5. Mutate the seed (reschedule, move, trash, edit) and re-run: the tombstone and
   moved-record paths only prove themselves against real change feeds.

## What only a live run can confirm

The workstreams that built the adapters recorded what they could not verify against the
real APIs. Each is a specific thing to look for in the live report or the corpus:

- **Gmail**: whether `history.list` with `labelId` reports UNREAD label changes for
  messages in that label (read state in the corpus).
- **Graph mail**: that `$select=webLink` is honored in a message delta (records carry a
  `url`); that a page size of 100 is honored; whether Exchange keeps a `Bcc` header in a
  MIME draft and a MIME `sendMail`.
- **Google Calendar**: that deleting a whole recurring series under `singleEvents=true`
  reports every instance as cancelled; whether sync tokens stay bound to the original
  `timeMin`/`timeMax` window (the adapter clips either way).
- **Microsoft calendar**: that `/me/calendars/{id}/calendarView/delta` works on v1.0
  for a non-default calendar (the v1.0 reference shows only `/me/calendarView/delta`);
  how all-day events come back; that a ~455-day calendarView range is accepted; the
  exact 410 body.
- **Google Drive**: how a permanently deleted folder's children appear in `changes.list`;
  that an unrecognized page token answers 400; that `alt=media` serves bytes directly.
- **OneDrive/SharePoint**: that `$select` survives into later delta links; whether
  consumer OneDrive reports each child of a deleted folder or only the folder.
- **YouTube**: that the Data API accepts the key in the `X-Goog-Api-Key` header, as
  Google's API-key docs recommend; that an unmatched `forHandle` returns 200 with no
  items; the exact `API_KEY_INVALID` / `accessNotConfigured` bodies.
- **X**: the 402 "credits depleted" body; `tweet.fields` versus the newer `post.fields`.
- **Instagram**: throttle code 80002.
- **LinkedIn**: publishing with `LinkedIn-Version: 202610` (the previous pin, 202508,
  was retired and broke every publish).

When a live run disagrees with a fake, fix the fake first so the disagreement becomes a
failing CI test, then fix the adapter.

## Keeping it honest over time

- **Nightly live run.** Store the test accounts' refresh tokens as CI secrets and run the
  live check on a schedule against a daemon seeded from them. Provider APIs drift (the
  LinkedIn version retirement above was invisible until this pass); a nightly run turns
  drift into a red build instead of a user's `lastError`.
- **Record and scrub fixtures.** When a live run finds a new payload shape, capture the
  raw response, scrub personal data, and add it to the adapter's golden test so the fake
  learns it permanently.
- **The simulator for everything else.** E2E specs and eval scenarios should bind with
  `GEZEL_CONNECTOR_SIMULATOR=1` and placeholder credentials rather than real accounts: it
  is deterministic, free, and exercises the same managers and writer.
