# The website connector

A project can follow web pages. Gezel's daemon visits them in its own
sandboxed browser, saves what a visitor would read as markdown with a few
screenshots, follows links inside the site up to a depth and a page cap, and
refreshes on a schedule. Gezels read the saved copies. They never get a web
tool from this: the browser is driven only by fixed daemon code, toward
addresses the person approved, and it never clicks, types or submits.

Decision record: [ADR 0031](decisions/0031-website-connector.md). Help article:
[Saved web pages](handboek/conceptual/saved-web-pages.md).

## Pieces

| Piece | Where |
|---|---|
| Adapter (one pass) | [connectors/natives/website.ts](../packages/service/src/connectors/natives/website.ts) |
| Crawl list, robots.txt, folder layout | [website-crawl.ts](../packages/service/src/connectors/natives/website-crawl.ts) |
| Page and site-overview records | [website-record.ts](../packages/service/src/connectors/natives/website-record.ts) |
| Monthly change log, lookout feed | [website-changes.ts](../packages/service/src/connectors/natives/website-changes.ts) |
| Saved sign-in (envelope-encrypted) | [website-session.ts](../packages/service/src/connectors/natives/website-session.ts) |
| Listing, Save page, gezel requests, sign-in | [website-service.ts](../packages/service/src/connectors/natives/website-service.ts), routes in [web-pages.ts](../packages/service/src/http/routes/web-pages.ts) |
| Capture service, worker, proxy | [page-capture/](../packages/service/src/page-capture/) |
| Address rules (pure) | [core web-pages/url.ts](../packages/core/src/web-pages/url.ts) |
| Gezel tools | [mcp web-tools.ts](../packages/mcp/src/web-tools.ts) |
| Web pages view | [ui project-views/web/](../packages/ui/src/views/project-views/web/) |
| Catalog manifest | gilde `data/connector-types/we/website/` |

## What lands on disk

```
artifacts/data/<corpus>/
  _meta.json
  <site>/                                   one folder per site (host without www.)
    NNN--site-overview--<h>.md              every saved page: title, address, changed date, synopsis
    NNN--home--<h>.md                       a page at the site root
    docs/guide/NNN--install--<h>.md         first two folders of the address, the rest in the name
      attachments/NNN/view-1.jpg page-2.jpg figure-1.png
    site-changes/NNN--2026-11--changes--<h>.md   this month's change log, newest first

~/.gezel/projects/<id>/connectors/<bindingId>/     private, removed with the binding
  crawl.json        every known page and its state
  text/<h>.md       last captured text of each page, for change diffs
  changes/*.json    each pass's changes, for website lookouts (newest 20)
  session.enc       a saved sign-in (AES-256-GCM; key in the SecretStore)
```

A page record's frontmatter: `kind: web-page`, `title`, `url`, `site`,
`description`, `author`, `published`, `modified`, `language`, `captured`
(volatile), `changed`, `words`, `render` (`browser` | `http`), `signed_in`,
then the writer's `trust: untrusted-external` and `scan_action`. The body is
the main content as markdown with absolute links; images the browser received
inside the main text are saved as attachments, every other image is a
captioned link (an offline record never loads remotely). A `## How the page
looked` section links the screenshots through `](attachment:<name>)`, which
the writer rewrites to the record's own `attachments/<NNN>/` folder.

A page is rewritten only when its **text** changes (a hash of the extracted
markdown), so a fresh screenshot of the same text is not a change. Record
identity is the normalized address (`normalizePageUrl`: no fragment, no
tracking parameters, sorted query).

## Capture

One pass opens one capture session (`PageCaptureService.open`). Where a
sandboxed browser can run, that is a **browser session**:

- **A child process** (`page-capture/capture-worker.js`, a tsup entry) drives
  the managed Chrome through playwright-core. Killing it is the cancel; the
  daemon cannot have its Chromium launch patched by other code in its process
  (`runWithManagedBrowser` does that for squisq).
- **Chromium's sandbox is on** (`chromiumSandbox: true`). The worker checks
  `chrome://sandbox` on Windows and Linux and refuses to continue if a
  renderer runs unsandboxed. A launch that fails is never retried without
  the sandbox; the session falls back to text-only and says why.
- **Every request goes through the filter proxy** (`filter-proxy.ts`), a
  forward proxy on `127.0.0.1:0`. It resolves each host itself, refuses
  private, loopback, link-local, metadata and this machine's own addresses,
  and connects to the address it checked, which closes DNS rebinding. A host
  the person typed may resolve privately (an intranet wiki), only while a
  page on that host is being captured; loopback and cloud metadata never, in
  any spelling (an IPv4-mapped AAAA answer is judged as its IPv4 address,
  `neverReachableKind` in `utils/ssrf.ts`). Per page: 30 MB, 400 connections,
  80 hosts. Nothing connects between pages.
- **UDP is closed by the profile.** The worker seeds the fresh profile with
  `webrtc.ip_handling_policy = disable_non_proxied_udp`; QUIC is off by flag.
  Measured 2026-11-16 on Chrome for Testing 151: without the preference, WebRTC
  STUN reached loopback and the LAN; the `--force-webrtc-ip-handling-policy`
  switch does not exist in this build; the **headless shell ignores the
  preference**, so only the full managed Chrome is used
  (`resolveCaptureChromium`).
- **No input, ever.** No pointer, keys, form fills or synthetic events
  (`no-input.test.ts` scans the worker). Lazy content loads by scrolling from
  script; `<details>` open by property; consent banners and covering
  overlays are hidden by style, never accepted. Downloads refused, no
  permissions, dialogs dismissed, popups closed. Navigations are GET only; a
  main-frame navigation out of scope, or any after the page settled, is
  aborted. Signed-in sessions also refuse script POSTs unless the binding
  allows them.
- **Extraction runs in an isolated world** (CDP `Page.createIsolatedWorld`),
  so page script cannot tamper with what is read. Elements a visitor cannot
  see are dropped first (hidden text is the usual injection carrier). Main
  content: Mozilla Readability, falling back to `<main>` / a single
  `<article>` / the body without its chrome when Readability keeps too
  little. HTML → markdown with squisq's `htmlToMarkdown`, in the worker.
- **Walls are recognized, not saved.** 401/403, a bot-check title, or a
  visible password field with little text answers `blocked`; the earlier
  copy stays. A page that comes back with under a quarter of its words keeps
  its earlier copy too.
- **Deadlines are awake time** (`createAwakeTimeout`): 60 s per page; a page
  that runs over kills the browser and the next page gets a fresh one (once
  per pass).

Where no sandboxed browser can run (store builds, a container without a
seccomp profile, a failed launch, `GEZEL_CAPTURE_BROWSER=off`) or the binding
turned the browser off, the session is **text-only** (`http-session.ts`): a
plain download with every redirect hop checked (`assertPublicUrl`, private
only for a typed host), 5 MB, 30 s, conditional requests. DNS rebinding is
not closed in this mode, the same limit as `fetch_url`.

## A pass

`listChangesSince` per site: seed the start addresses, drop pages that left
the connection's scope (records removed), pick the due pages within the pass
budget (person 15 pages / 2 min, schedule and task 40 / 4 min, a request 5 /
90 s; awake time). Order: asked-for first, then shallow before deep, never
captured before stale. More due than the budget, or new links found during
the pass, sets `ChangeBatch.deferred`; after a pass the person or a task
started, the manager runs follow-up passes 2 s apart (at most 60), releasing
the project lock between them.

Due means: never captured; for a person's pass, older than 10 minutes; for
the schedule, older than `refreshEveryHours` (0 = manual only); for a
request, only pages someone asked for. A failed page backs off 15 min → 1 h →
6 h → 24 h, a blocked one 24 h; a person's Sync now retries a page whose last
attempt is over 10 minutes old (so follow-up passes never retry the same
failure). A site that answers 429/503 cools down (`Retry-After`, at least 10
minutes). Two "not found" answers remove a page.

A start address that redirects within its site adds the folder it landed in
to the site's scope (`redirectScopes`). Any page that redirects records its
landing address as an alias (`CrawlState.aliases`), so a link to that address
is not saved twice and `read_web_page` / `request_web_page` find the page by
either address. When the landing address is a page in its own right (saved,
typed, or asked for), the redirecting one is skipped as a duplicate.

Links are followed when they are inside a site's scope (same host ignoring
`www.`, same scheme and port, under the start address's folder), within the
link depth and page cap, and `linkRefusal` allows them: never sign-out, cart
or editor links, links with credential-like parameters, or files; signed in,
also delete, approve, subscribe, settings and other action words. Links
beyond the depth or cap, or matching an exclude pattern, are kept as
`skipped` entries: known, never followed, available to `request_web_page`.
robots.txt (our group, else `*`; Crawl-delay honored) applies to followed
links, not to addresses the person typed. At least 1.5 s between visits to one
host.

The crawl list commits a page only in `recordWritten`, after the engine wrote
its record, so a failed write is never remembered as current.

## Sign-in

The person presses **Sign in…** on the connection's row. The daemon opens a
**headed window of the same managed Chrome**, through the same proxy and
sandbox (it runs as the logged-in user: connectors live in the product
daemon, which the app spawns per user). The window first shows a page naming
Gezel and the host, then the site. Chrome's own address bar is the
anti-phishing surface. Gezel sends the window no input. Its page, the site
being signed in to, begins before the window opens (a sign-in has no capture
request to begin one, and the proxy refuses everything between pages), with a
larger budget than a capture's, `SIGN_IN_NETWORK_BUDGET` (400 MB, 4,000
connections, 400 hosts), because single sign-on passes through identity
providers and their CDNs. The window launches
without Chrome's automation marker, since a person drives it; capture
browsers stay honest about automation.

**Done** snapshots the storage state, closes the window, loads the page the
person ended on headless with and without the state, and saves both
fingerprints. A sign-in that still looks signed out is refused. One that
looks the same both ways is saved `unverifiable`.

Storage: Windows Credential Manager holds 1,280 characters through
@napi-rs/keyring (measured), and the keyring store does not chunk, so a random
AES-256-GCM key goes in the SecretStore under `connectorSecretKey('website',
bindingId)` and the ciphertext in `session.enc`, with one previous generation.
Only cookies and storage for the binding's own hosts are kept. Forget and
unbind delete both.

Each signed-in pass probes first. A 401/403, a sign-in wall, or a match with
the anonymous fingerprint stops the pass (`PassStoppedError`) with "Signed out
of <host>. Sign in again…" on the row and every record untouched. Rotated
cookies are re-saved at the end of a pass that still verified.

Where no window can open, `PUT …/session` takes a storage state the person
exported themselves (2 MB cap, saved `unverifiable`).

## Gezels

Projects with a website binding get three tools (`GEZEL_WEBSITES_ENABLED`):
`list_web_pages`, `read_web_page` (a saved copy, never a visit) and
`request_web_page`. A request is fetched only when the address **exactly**
matches a page in a crawl list (a link the crawler found on a followed site),
the binding lets gezels ask (`gezelRequests`, default `allow` for public
sites; a signed-in binding asks unless set to `allow` explicitly), and the
project's 40 requests a day are not spent. Anything else answers
`needs-permission` and fetches nothing: a model-composed address can carry
data out. The fetch runs as a `request` pass, which captures only asked-for
pages.

The connector standards' "no fetch tool" rule ([connector-standards.md §6](connector-standards.md#6-discoverability))
holds in spirit: the model chooses among links the site itself published,
within caps, and never supplies an address.

Every record is `trust: untrusted-external`, scanned and quarantined like any
connector record, and the untrusted-content prompt block names saved web
pages.

## The person

- **Connections tab**: a website row with its status line (`describeStatus`),
  Sync now, Edit (in place, from the manifest's schema, plus "Ask me before
  Gezel saves a page it wants to read"), Sign in… / Sign out, Remove.
- **Web pages view** (Views tab, offered when the project follows a website):
  pages by site, a reader with Reading and Screenshots keys, the original
  address, checked and changed times, the synopsis. A link to a saved page
  opens it in place; any other link opens in the browser. **Save a page**
  saves one address into the connection that follows it or already found it
  as a link, else into the project's "Saved pages" connection (no link
  following, no schedule).
- **Composer**: an address in the draft that has no saved copy gets a row
  saying it "will be saved here and included in the chat". Send saves it
  first, unless the person pressed × on the row; **Save now** does it early.
  The turn then opens with the saved page's summary, its text (whole, or the
  passages that fit) and the path of the local copy, and the sent message
  shows a row that opens that copy. This is the `web-page` rule of the
  general path in [prompt-connectors.md](prompt-connectors.md). The save
  route still takes `sessionId` for a copy kept only until that chat is
  deleted; the composer no longer offers it.
- Connector records open read-only in the editor (`isConnectorCorpusPath`):
  the next refresh would overwrite an edit.

## Change log, lookouts and synopses

Each site keeps one change-log record per month. During the first crawl it
carries one running "Started following … N pages saved so far" line; after
it, each pass that changed something adds an entry: new pages, changed pages
with up to eight lines that appeared and disappeared, pages that no longer
exist. Changes under 40 characters update the page but stay out of the log.

Website lookouts (`source.kind: 'website'`; conditions `page-changed`,
`page-added`, `text-appears`, each with an optional path prefix) are judged
by core's `admitWebsiteLookout`: literal, model-free, once per pass, the
camera rule's cooldown and limits. Page text is untrusted: the only
page-derived text an action carries is "Changed: <title>", sanitized like a
camera's line. The daemon hands each new pass's changes to the lookout engine
once, only for passes since boot.

Synopses: after a project's own files drain, the enrichment loop summarizes
saved pages with no summary for their current text
(`ContentIndex.summarizeWebPages`), same prompt, model and Librarian roster
gate as workspace files, summaries only (the corpus has no measured vector
floor). They land in the artifacts index's `summaries` table and in the crawl
list, so the overview and the Web pages view show them.

## Policy

- Background refresh of every **read-only** connector (a type that declares no
  write-back actions) rides `allowConnectorData`, so websites, feeds and wikis
  refresh at the default Lockdown level. Types that can send or post keep
  `allowExternalServices`. `ConnectorManager.backgroundBindings` decides;
  the loop lists only eligible bindings.
- `syncBinding` refuses when `allowConnectorData` is off (403 on the route).
- Turning App network off, emergency stop, pausing or removing a binding, and
  shutdown stop running passes (`cancelPasses`), which kills the capture
  worker, and close sign-in windows.
- Bind, sync, sign-in, session, Save page and the composer's offer routes
  (`/prompt-connectors/*`) refuse gezel session tokens (`scope-guard.ts`).
  Sending a message that names an address saves it only from the composer,
  with the row and its × in front of the person; the daemon's send path
  reads saved copies and never fetches. A coordinator can no longer grant its project a stored
  credential through `PUT /api/projects/:id`.

## Testing

- `website.test.ts`: the conformance suite (first pass, quiet second pass,
  edit in place, deletion, hostile names) over `FakeSite` + `FakePageCapturer`,
  plus discovery, robots, walls, near-empty pages, the change log, site
  removal, the pass budget, screenshots, sign-out.
- `website-service.test.ts`: a gezel's request fetches a found link and never
  a composed one; Save page.
- `filter-proxy.test.ts`, `no-input.test.ts`, `manager-background.test.ts`,
  core `url.test.ts`, `website-admission.test.ts`, `connector-corpus.test.ts`.
- `capture.real.test.ts`: the built worker, sandboxed Chrome and the proxy
  against a fixture site, with canary listeners that must see zero packets
  from fetch, image, iframe, preconnect, WebSocket, beacon and WebRTC aimed at
  loopback and the LAN. Skipped without a managed Chrome; rerun on every
  Chromium pin bump.

## Known limits

- Sandbox startup is verified on Windows (per-user). macOS, Ubuntu 23.10+
  (AppArmor user namespaces) and containers need a run there; a failure falls
  back to text-only with the reason shown.
- Bot checks (Cloudflare-style) answer `blocked`; Gezel does not disguise its
  browser or solve challenges.
- PDFs and other files linked from pages are not saved.
- An older build reading a home with website lookouts drops them on its next
  lookout save.
