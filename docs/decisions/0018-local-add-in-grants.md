# 0018 — Gezel's own local add-ins connect without a connection code

Status: Accepted (2026-09). Amends [0016](0016-office-host.md)'s same-origin consent.

## Context

Gezel's add-ins for Word, Excel and PowerPoint, for LibreOffice, and for
VS Code each asked for a `product` grant through the public consent flow: the
add-in showed a six-character code and the user typed it into Gezel. Gezel
itself installed two of them a minute earlier. The code was a step with no
decision in it.

The code exists because loopback does not separate local accounts
([security-architecture](../security-architecture.md), threat actor 4): a
process of another user, or a page that reaches loopback, can call
`/v1/apps/register` and claim to be anything. The code proves that the
requester and the person approving are at the same desk.

The CLI already skips that step on its own daemon (`authorizeLocalOwnedDaemon`
in `packages/cli/src/connection.ts`): the daemon's runtime directory lives in
the caller's home, readable only by that account, so *being able to read it
and being the owner are the same fact*. A process that can read it can also
read `tokens.json`, so a code protects nothing the filesystem does not.

## Decision

**A Gezel add-in that proves it runs as this account's owner gets its grant
without a code.** Proof is possession of something only that account can read.
There are three add-ins and two proofs.

- **Owner credential exchange** (VS Code, LibreOffice). A native add-in reads
  `runtime/auth-token` and calls `POST /v1/apps/local-connect` with it. The
  route requires first-party auth and names only the add-ins in
  `grants/first-party-apps.ts`. The owner credential serves that one request.
  The add-in holds only its own narrower grant, revocable by name in
  Connected Apps. VS Code reaches it through the app SDK's `gezelAddIn`
  option, which applies only on the per-user branch of `authorizeLocal`: a
  configured URL or a legacy full machine service still consents. The
  LibreOffice extension does it in `consent.py`.
- **Provisioned token** (LibreOffice). Setting LibreOffice up in Settings
  writes the grant to `integrations/libreoffice/token` (0600), which the
  extension already reads, so even an extension built before this change
  connects.
- **Enrollment key** (Office). The pane is a web page and cannot read files,
  so the secret rides where only the user can read: a 256-bit key in each
  manifest's task-pane URL (`?enroll=`). The pane posts it to
  `POST /v1/apps/office/enroll` (same browser-origin rule as registration,
  JSON only, 10 attempts a minute) and gets the `office` grant. Manifests are
  written 0600 in a 0700 folder, and the macOS copy in Office's container is
  chmodded 0600. The key is kept in `setup.json` (0600) because the manifests
  are regenerated from it; it rotates when the setup is removed. The pane
  drops it from its address once it holds a token, and the daemon's
  `Referrer-Policy: no-referrer` keeps it off the `office.js` request.

**One grant per add-in, shared.** `connect()` returns the existing token when
its scopes match and mints only when there is none. Word, Excel and PowerPoint
keep separate pane storage; if each connection rotated the token, the hosts
would sign each other out in turn.

**The code flow stays as the fallback** for every one of these ids: a
manifest registered by hand, a daemon that predates the routes, a remote
`gezel.daemonUrl`. It still gates every other app and every other scope.

**Revoking one of these add-ins resets it.** It reconnects the next time it
opens; Connected Apps says so. Removing the add-in (Settings for Office and
LibreOffice, which also revokes the grant; uninstalling for VS Code) is how to
disconnect it for good. Only an explicit setup writes LibreOffice's token
file, so a revoked token is never replaced behind the user's back; the
extension's own owner exchange is what reconnects it.

## Consequences

- The Office key's protection is file permissions: the user's home, Office's
  container (0700 by the OS), and gezel's 0600 manifests. On Windows the
  manifests sit in the user profile and rely on its default ACL; gezel adds no
  ACL of its own.
- The key also lives in Office's own caches and may appear in Office's logs
  or telemetry. It is worth nothing off this computer: the listener is
  loopback-only, and enrollment only mints a grant on this daemon.
- On a machine-wide daemon whose `runtime/auth-token` is readable by every
  local account, the exchange gives each of them what reading that file
  already gave them. The product daemon is per-user; the membership question
  for shared daemons belongs to [0004](0004-accounts-and-project-acls.md).
- `GEZEL_AUTOAPPROVE_APPS` remains the CI-only bypass; nothing here uses it.
