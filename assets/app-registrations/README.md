# App registration assets

Gezel's official app registrations with sign-in providers (Microsoft, Google), and the files uploaded to them. Everything here is public.

Gezel uses these apps for connections that only read, after any app the person saved or the daemon's environment sets. The client IDs and the scopes each app may request live in [builtin-oauth-clients.ts](../../packages/service/src/connectors/builtin-oauth-clients.ts).

## Registrations

### Gezel (read-only), Microsoft Entra ID

| | |
|---|---|
| Client ID | `fd484001-ce41-44ee-8ecb-dfb3b639cee5` |
| Who can sign in | Work, school and personal Microsoft accounts |
| Kind | Public client: no client secret, no certificates, device-code sign-in off |
| Redirect | `http://127.0.0.1/callback` (Microsoft ignores the port for loopback addresses) |
| Permissions (Microsoft Graph, delegated) | `openid`, `email`, `profile`, `offline_access`, `User.Read`, `Mail.Read`, `Calendars.Read`, `Files.Read`, `Sites.Read.All` |
| Publisher | Bendyline, verified 2026-11-18 |
| Logo | `gezel-read-only-logo.png` |
| Manifest | `gezel-read-only.entra-manifest.json`, downloaded 2026-11-18 |

It asks for nothing that can change, send or delete. Microsoft lets an app request permissions at sign-in that its registration does not list, so Gezel itself keeps to this list when it uses this client ID.

### Gezel (read-only), Google Auth Platform

| | |
|---|---|
| Client ID and secret | Not here. Google forbids committing client credentials to a public repository. They are the `GEZEL_GOOGLE_OAUTH_CLIENT_ID` and `GEZEL_GOOGLE_OAUTH_CLIENT_SECRET` repository secrets, which only the desktop release workflows write into the build. |
| Client type | Desktop app. Google's token endpoint requires the secret even with PKCE. |
| Audience | External |
| Scopes | `openid`, `userinfo.email`, `calendar.calendarlist.readonly`, `calendar.events.readonly` (all under `https://www.googleapis.com/auth/` except `openid`) |
| Homepage, privacy, terms | `https://gezel.com`, `https://gezel.com/privacy/`, `https://gezel.com/terms/` |
| Logo | `gezel-read-only-logo-120.png` |

Gmail and Drive are not on it: their scopes are restricted, which adds a yearly security assessment. Adding a scope means a new verification, so change the Data Access page, this table and `builtin-oauth-clients.ts` together.

## Files

| File | Used for |
|---|---|
| `gezel-read-only-logo.png` | Logo of the Microsoft Entra app (**Branding & properties → Upload new logo**). 215 × 215. |
| `gezel-read-only-logo-120.png` | The same logo at 120 × 120, the size Google asks for (**Google Auth Platform → Branding → App logo**). |
| `gezel-read-only-logo.svg` | The same logo as a vector. |
| `gezel-read-only.entra-manifest.json` | The Entra app's manifest (**Manifest → Download**), as a record of what it can ask for. Download it again after any change in the portal. |

The logos are drawn from the app icon's own artwork in [icon-artwork.mjs](../../packages/app/scripts/icon-artwork.mjs) (the `read-only` variant), so they stay in step with it. To change one, edit that file and run:

```bash
pnpm --filter @bendyline/gezel-app generate:icons
```

`pnpm --filter @bendyline/gezel-app check:icons` fails while a committed copy is out of date. A provider keeps its own copy of an uploaded logo, so upload it again after it changes.
