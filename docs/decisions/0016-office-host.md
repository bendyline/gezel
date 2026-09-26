# 0016 — Office host: a per-user local CA, a stable HTTPS listener, and same-origin consent

Status: Accepted (2026-09)

## Context

Gezel should reach people inside Word, Excel, PowerPoint, and LibreOffice the
way the VS Code extension does: a real gezel session beside the document, and
document tools the project's gezels can call.

Office desktop add-ins are web pages in WebView2 (Windows) and WKWebView
(macOS), declared by an XML manifest. Three facts fixed the shape:

- **Registration needs no store.** Office reads a per-user manifest list:
  `HKCU\Software\Microsoft\Office\16.0\WEF\Developer` on Windows, each app's
  `~/Library/Containers/com.microsoft.<App>/Data/Documents/wef/` on macOS.
  Microsoft calls this sideloading; it persists and needs no tenant.
- **The pane must be HTTPS from a certificate the OS trusts,** at a URL the
  manifest names once. The daemon's loopback certificate is regenerated every
  launch with its key in memory (`http/cert.ts`), and its product port is
  ephemeral whenever the machine broker holds 6228.
- **A publicly hosted pane calling loopback** would meet Chromium's Local
  Network Access gate, and `POST /v1/apps/register` refuses any request that
  carries `Origin` (`routes/v1-apps.ts`), by design.

LibreOffice extensions are `.oxt` packages of Python/UNO with native UI;
`unopkg add -s` installs one per user. A native process can read
`runtime/port` + `runtime/cert.pem` and do the consent handshake like the CLI.

## Decision

**The daemon serves the pane, on a second listener, with a per-user CA.**

- `office-host/tls-identity.ts` mints a CA (RSA-2048, 10 years,
  `basicConstraints cA pathLen:0`, critical `nameConstraints` permitting only
  `localhost`, `127.0.0.1`, `::1`) and an 800-day leaf, under
  `<home>/integrations/office/` with 0600 keys. The leaf renews 60 days before
  expiry without touching the CA. `selfsigned` drops unknown extensions, so
  certificates are built with `@peculiar/x509` and a hand-encoded
  NameConstraints extension.
- `office-host/listener.ts` binds the **full product app** again on a stable
  per-home port (`officeHostPortForHome`, yielding to every bridge port), on
  `127.0.0.1` and best-effort `::1`. It is not a local bridge: bridges are
  plain HTTP and inference-only by construction, and the pane is a first-party
  page that needs `/api/*` and `/events/*`.
- `/office/*` serves the pane (`packages/ui` `vite.office.config.ts`, staged
  as `dist/office`) with its own CSP, which adds exactly one origin,
  `https://appsforoffice.microsoft.com`, because Microsoft requires office.js
  from its CDN. Every other path keeps the default CSP.
- The chat is the main UI's `/?embedded=chat` page in a same-origin frame,
  reading the pane's token from `gezel:token` in the origin's storage, so the
  pane never duplicates the app bundle. That one document may be framed
  (`frame-ancestors 'self'`, `X-Frame-Options: SAMEORIGIN`) and only when
  requested through the Office listener; everything else stays
  `frame-ancestors 'none'`.

**The desktop app does every OS-side step; the daemon owns state.**
`office-setup/manager.ts` owns the identity, listener, manifests, and a
`setup.json` status. Electron (`packages/app/src/office-integration/`) trusts
the CA in the user's store (login keychain `-p ssl`; `certutil -user` on
CurrentUser\Root), registers each manifest, and reports each outcome through
`POST /api/office-setup/host-report`. A certificate is installed only from a
click; the boot-time verify only observes and reports, except that it
refreshes a macOS manifest copy gezel already placed after an upgrade.

**Same-origin consent.** `/v1/apps/register` admits a browser request only
when `Origin` equals the Office listener's own origin and `Sec-Fetch-Site` is
absent or `same-origin`. The pane asks for `product` scope only, so the user
still types the verification code into Gezel. That code — not the origin
check — protects the grant, since loopback is reachable by every local
account; the origin check keeps every other page out, and `/office/*` serves
only files gezel ships.

**LibreOffice** needs none of this. `packages/libreoffice-extension` builds a
deterministic `gezel.oxt` (the daemon detects "newer" by hash), staged as
`dist/libreoffice/gezel.oxt`; Electron runs `unopkg add -f -s`. The extension
discovers the daemon, asks for its own `product` grant as `libreoffice`, and
offers the same tool names as the Office pane.

Both integrations map a document to a project through ADR 0015's inference,
so a newly found folder project is read-only and document edits go through
the in-app tools.

## Consequences

- Two loopback identities: the main certificate still rotates per launch;
  only the Office origin uses the CA chain.
- A port collision on the Office listener is reported, not retried elsewhere,
  because the manifests name the port.
- Name constraints are defense in depth; the boundary is the 0600 CA key and
  the per-user store. Windows and macOS both show a confirmation, which must
  come from the user's click.
- Uninstall removes the registrations and the CA for the uninstalling account
  (macOS `uninstall.sh`; NSIS `customUnInstall`, guarded by `isUpdated` so an
  upgrade never unregisters Office). Other accounts remove theirs from
  Settings.
- Office on the web (framed, and unable to reach a loopback origin) and
  Outlook (registered through Exchange) are out of scope.
- The UNO layer of the LibreOffice extension has a manual smoke recipe; its
  pure modules have stdlib unit tests.
