# App serve — share an AI App as a mini-site

`gezel app serve` turns a project's applied AI App into a small website:
the app's pages, working exactly as they do in the desktop Output pane,
plus (opt-in) a chat box wired to the project's lead gezel. The daemon
hosts the site on its own port; the CLI starts it, prints a share link,
and stops it on Ctrl+C.

```
$ cd ~/spanish            # a folder with an app applied (gezel app apply …)
$ gezel app serve --chat

  Serving "Taal Trainer" (taal-trainer@1.2.0)
  project: spanish - site: a0fe12f7f205

  Share link:  http://127.0.0.1:52840/?k=mZk2rW…hQw
               (the link carries the site key - anyone with it can visit)

  Chat: on - visitors get their own conversation with the project lead (no tools).
  To reach the internet, put a tunnel in front, e.g.:
    ngrok http 52840
    cloudflared tunnel --url http://127.0.0.1:52840
    (for a proxy hostname, restart with --allow-host your.domain)

  visitors 0 - views 0 - invokes 0 - chat 0        Ctrl+C stops serving
```

Verbs and flags:

- `gezel app serve [appId]` — serve this folder's app (or the one project
  that has `appId` applied). `--port` fixes the port for tunnel configs;
  `--host <ip>` binds beyond loopback (trusted LANs only); `--allow-host
  <name>` accepts a reverse-proxy/tunnel hostname; `--chat` enables visitor
  chat; `--public` skips the key; `--key` pins a stable share key;
  `--detach` leaves the site running in the daemon; `--open` opens the link.
- `gezel app serve status` — list running sites.
- `gezel app serve stop [appId|siteId]` / `--all` — stop serving.

The HTTP control surface is `/api/app-serve` (first-party + CLI tokens
only). Sites are **ephemeral**: they live in the daemon's memory and end
with an explicit stop or a daemon restart — nothing is persisted.

## The trust model

- **Site key** — a random secret embedded in the share link. Presenting it
  once mints a **visitor**: a per-browser HttpOnly cookie session. The key
  then disappears from the URL. Rotate it any time
  (`POST /api/app-serve/:siteId/rotate-key`, optionally revoking current
  visitors). `--public` sites skip the key; every arrival becomes a visitor.
- **Visitors are not you.** The visitor cookie means nothing to the
  daemon's `/api/*`, `/v1/*`, or `/events/*` surfaces, and no first-party
  bearer ever appears in a serve response. The site listener mounts an
  explicit route allowlist — pages, the page API head, declared data
  files, and (when enabled) chat. Nothing else exists there.
- **Pages keep their declared powers, nothing more.** Visitor reads are
  limited to the manifest's `pages.reads`; visitor invokes to the
  manifest's `pages.tools`, schema-validated with `bind` pinned server-side
  — the same single implementation the desktop Output pane uses
  (`http/page-io.ts`). A tool's `reaction` can summon a gezel turn only on
  chat-enabled sites.
- **Visitor chat is toolless.** Each visitor gets an isolated session with
  the project lead marked `visitorAccess`: zero tools at session build, a
  visitor-context system prompt, and exclusion from memory extraction. Hard
  caps: 6 messages/min, 50 per visit, two concurrent turns site-wide.
- **Budgets everywhere.** Per-visitor and site-wide rate limits on pages,
  reads, invokes, and chat; 64 visitors per site; a whole-site in-flight
  ceiling. Visitor sessions expire (60 min idle / 24 h absolute) and their
  chats are archived.
- **Serving requires script execution.** The `super-lockdown` security
  level refuses to start a site (visitor page tools are script runs).

## Reaching the internet

The listener speaks plain HTTP and binds `127.0.0.1` by default. The
supported way to serve real visitors is a tunnel or reverse proxy that
owns TLS — ngrok, cloudflared, Tailscale serve/funnel, Caddy — pointed at
the site port. Add the public hostname with `--allow-host` so the Host
check admits it (loopback and the bound IP always pass; anything else is
refused — the DNS-rebinding stance of the main daemon, kept). Behind an
HTTPS proxy the visitor cookie is marked `Secure` automatically
(`x-forwarded-proto`).

`--host <lan-ip>` exists for trusted home/office networks; remember the
key and cookies then travel in clear text on that LAN.

## What app authors should know

Serving changes the audience, not the contract: the page still talks to
`window.gezel` (mode `serve` — see docs/output-pane-api.md), and every
tool you list in `pages.tools` becomes something *strangers* can invoke
with schema-valid input of their choosing. Declare accordingly, pin the
dangerous halves of an action with `bind`, and keep state transitions
inside your scripts. Legacy v0-sentinel pages (hand-rolled postMessage)
degrade to static HTML on a served site; the v1 `window.gezel` API is the
supported surface.
