# Accounts

People who sign in to Gezel from a browser on another device: a Gezel
container's web UI today, first-class remote access later. The decision is
[ADR 0029](decisions/0029-container-hosting-and-accounts.md), which adopts
option (c) of [ADR 0004](decisions/0004-accounts-and-project-acls.md) for
network sign-in. The desktop app and the same-machine CLI never use
accounts; they keep the owner credential in `runtime/auth-token`.

## Where accounts apply

- Required on the container listener ([container.md](container.md)).
- Opt-in on `gezel start --web --accounts` (`GEZEL_WEB_ACCOUNTS=1`), instead
  of the one-time `?token=` URL.
- Never on `gezel app serve`, whose visitors are a separate, toolless model.

## Stores

Both are owned by `packages/service/src/accounts/`, written through
`writeSecurityJson` (atomic, `.bak` beside, mode 0600), and kept apart from
`tokens.json`, whose loader refuses durable first-party authority, so an
older daemon reading this home ignores them instead of refusing to start.

| File | Shape |
| --- | --- |
| `<home>/accounts.json` | `{ version: 1, accounts: [{ id, name, role, passwordHash, createdAt, updatedAt, passwordChangedAt?, lastSignInAt?, disabledAt? }] }` |
| `<home>/account-sessions.json` | `{ version: 1, sessions: [{ id, accountId, tokenHash, createdAt, lastSeenAt, expiresAt, label?, address? }] }` |

- **Names** are unique without regard to case and are what people sign in
  with.
- **Passwords** are scrypt from `node:crypto` (N=2^17, r=8, p=1), stored as
  `scrypt$N$r$p$salt$hash` so stronger parameters re-hash at the next
  sign-in. At least 8 characters, no composition rules. At most two hashes
  run at once.
- **Sessions** are `gzs_`-prefixed bearer tokens, stored as sha256 hashes.
  They end after 30 days unused or 90 days in any case. A password change
  ends the account's other sessions; disabling or removing it ends all.

## Roles, and what comes later

`role` is stored from day one; this build creates only `admin`, and every
account can do everything, terminals included. A role this build does not
know cannot sign in, so a downgrade never widens a newer build's narrower
role. What a role may do lives in one place
(`packages/core/src/accounts/roles.ts`), and account management goes through
one check (`requireAccountAdmin` in `http/routes/accounts.ts`). At least one
admin who can sign in always remains.

Next, without reshaping anything: a `member` role (no terminals, Settings,
Integrations or account management) guarded through `roles.ts`, and ADR
0004's per-project ACLs keyed on `account.id`.

## The request principal

A session resolves, inside `TokenStore.lookup` (`setAccountResolver`), to an
in-memory record with scopes `['ui', 'openai', 'knowledge', 'images']` (what
the desktop credential carries) and ADR 0004's principal, `account: { id,
source: 'password', label }`, on `c.var.auth`. `bearerAuth` also enters the
account into an AsyncLocalStorage (`accounts/request-account.ts`), and
`HistoryManager.log` stamps `by: { accountId, name }` on every event a
request causes, including background work it starts.

## Sign-in routes

Under `/v1/apps/signin`, so `/v1/apps`'s no-CORS rule covers them:

| Route | |
| --- | --- |
| `GET /state` | `{ accountsRequired, setupRequired, setupCodeAvailable }`; mints a fresh setup link when the last one expired |
| `POST /setup` | `{ code, name, password }`: the first account, while none exists |
| `POST /` | `{ name, password }` |
| `POST /signout` | ends the bearer's session |

POSTs need JSON and a `Sec-Fetch-Site` of `same-origin` or `none` (or none
at all, for non-browser clients). A wrong name and a wrong password get the
same answer in the same time (a dummy hash is checked for a missing name).
Five failures per name or address in 15 minutes, then a doubling wait up to
15 minutes, plus an install-wide ceiling of 60 failures a minute. Failures
are logged to History, at most once per name and address every 5 minutes.

## The first account

Created by the first of:

1. **The setup link.** While no account exists and accounts are required,
   the daemon logs `…/?setup=<code>`: a single-use code, valid for an hour,
   regenerated at each restart and when the sign-in screen finds it
   expired. `GEZEL_SETUP_LINK=0` turns it off. `gezel account setup-link`
   prints a new one.
2. **A secret.** `GEZEL_OWNER_NAME` and `GEZEL_OWNER_PASSWORD_FILE`, read once
   at boot while the store is empty. A file, never a variable.
3. **The shell.** `gezel account create <name>`.

Recovery is the shell: `gezel account reset-password <name>`.

## Management

`/api/accounts` (first-party callers; the owner credential always counts as
an admin): list, create, rename, disable or enable, set a password, remove,
list sessions, sign one out or all. `/api/accounts/me…` lets a signed-in
person change their own password (current one required) and sign out their
other browsers. The CLI is `gezel account …`; the UI is Settings → Accounts,
shown wherever accounts are required or exist.

## Related keys

`POST /api/app-tokens` (`gezel integrations token create`) mints an app key
for the OpenAI-style endpoints without the approval prompt, for the person
already at the shell. The key still goes through the grant manager and
appears in Integrations.
