# Connectors

A **connector** binds a project to an external source of the user's own data — a
mailbox, a calendar, a Drive folder, a git repo, a Slack export — and mirrors that source
into a normalized, inspectable on-disk **corpus** in the project's artifacts tree.
The user configures and authorizes the connector; the connector does the auth, the fetch,
and the normalization; the AI only ever sees the resulting files. Reading is bulk, offline,
and low-stakes. Writing back (send an email, create a calendar event) is a separate,
narrow, deny-by-default, consent-gated action surface — the kind of thing that accumulates
on the night shift and gets committed in a morning review.

**Architectural thesis: a connector is the mail pipeline's shape, generalized — not a new
subsystem.** Everything a connector needs already exists and is proven in production by
[packages/service/src/mail/](../packages/service/src/mail/): a provider-agnostic adapter
contract, cursor-resumed incremental sync, normalized files carrying trust frontmatter, an
injection scanner that quarantines outside the artifact corpus, credentials in the SecretStore,
and a deny-by-default outbox with night-shift deferral. [git/manager.ts](../packages/service/src/git/manager.ts)
is a second instance of the same pattern built independently. Codifying **one** contract
lets the next source (calendar, Drive, Slack, RSS, a watched filesystem folder) reuse the
sync engine, the safety rails, the secret store, artifact access, and the consent model instead
of re-deriving each one. No new code-execution surface is added.

And most connector types are **configuration over a generic driver — an MCP server or a
script — not bespoke code.** Gezel supplies the connect UX, the sync host, credential
management, normalization, and the fault-tolerance envelope; the manifest names what to call.
Native adapters like mail are the exception, reserved for cornerstone corpora that resist
declarative expression. See [Drivers](#drivers-most-connector-types-are-configuration-not-code).

> This document is the architectural intent. For the normative rules an adapter, a driver, or
> a gilde manifest must satisfy — above all **where a connector puts the data it retrieves** —
> read [connector-standards.md](./connector-standards.md), whose conformance table records
> the per-rule implementation state (all met since the August 2026 overhaul, with the
> residual gaps named there).

## Vocabulary

The word "connector" is overloaded; pin it down:

- A **connector** (this feature) is gezel's **download-and-normalize** primitive. Its
  defining property is **isolation**: credentials and the network fetch live on one side of
  a boundary, the AI and the normalized corpus on the other.
- This is deliberately **not** the same thing as an **MCP server** — which claude.ai's UI
  also calls a "connector" (see the Gmail / Google Calendar / Drive entries in the MCP
  connector list). Those give the model **live, per-call tool access** to a remote API.
  Gezel connectors give it a **static local corpus**. Both are valid; they are different
  postures (see [Relationship to MCP servers](#relationship-to-mcp-servers)). In gezel prose
  and code, "connector" means the download-and-normalize primitive, never an MCP server.
- Not to be confused with the supervisor's daemon **connection** (`gezel:current-connection`),
  which is unrelated.

Terms used below: a **connector type** is the reusable, versioned adapter (`mail-gmail`,
`calendar-google`, …); a **binding** (or **account**) is one configured instance of a type
on a project; the **corpus** is the normalized output; an **action** is a declared writeable
capability of a type.

## The proven pattern (mail is the reference implementation)

Mail already did, end to end, exactly what a connector must do — and the generalization is
now complete: the "mail today" column below is **historical** (the standalone mail stack it
describes was retired once mail became ordinary `mail-*` connector bindings), kept because
it documents where each concern in the connector core came from. Each row generalized:

| Concern | Mail today | Generalized connector |
|---|---|---|
| Adapter contract | `MailProvider` in [mail/types.ts](../packages/service/src/mail/types.ts) — `ensureAuth` / `listChangesSince(cursor)` / `fetchMessage` / `send` / `close` | `ConnectorAdapter` (below) |
| Type registry | `createMailProvider` in [mail/registry.ts](../packages/service/src/mail/registry.ts) dispatches imap/gmail/graph | Catalog-seeded type registry |
| Config binding | `ProjectMailAccount` on `project.json` ([schemas/project.ts](../packages/core/src/schemas/project.ts)) — binding + cursor, **credential never here** | `ProjectConnectorBinding` |
| Incremental cursor | opaque per-provider (`imap` UID / `gmailHistoryId` / `graphDeltaLink`) | opaque `cursor` blob, persisted on the binding |
| Sync engine | `MailSyncManager` (retired) — idle-gated, posture-gated, one project/tick, modeled on `IndexEnrichmentManager` | `ConnectorSyncManager` (one engine, all types) |
| Normalized output | immutable per-message markdown with trust frontmatter, in [mail/storage.ts](../packages/service/src/mail/storage.ts) | per-record normalized files, same writer discipline |
| Safety | `contentScanner.scan` → quarantine to `.gezel/quarantine/` (unindexed), path-safety via `resolveInside` | identical, in the shared writer |
| Secrets | SecretStore keyed `{toolset: mail-<provider>, field: accountId}`, OAuth re-persist on refresh | SecretStore keyed by connector type + binding |
| Write-back | `_drafts/` → `_outbox/` → `_sent/` with a deny-by-default allowlist (mail's outbox, since folded into the consent registry) | connector **outbox** contract |
| AI read path | **none** — the AI reads synced markdown as ordinary files | unchanged: read = files |
| AI write path | `draft_email` / `queue_email` / `send_email` MCP tools → `/api/projects/:id/mail/*` ([mcp/server.ts](../packages/mcp/src/server.ts)) | type-declared actions, same 3-step stage/gate |
| Posture gate | autonomous sync rides `resolveSecurityPolicy(cfg).allowMail` | `allowExternalServices` per source |

The point of the table: **codifying connectors is mostly a refactor of a shape we've already
shipped and hardened**, not new invention. The risk is concentrated in the two genuinely hard
parts every type re-encounters — auth/token lifecycle and normalization schema — which the
contract below is designed to isolate.

## The adapter contract

The generalization of `MailProvider`. An adapter speaks only normalized types, never a
provider SDK above this line. It is single-use per sync pass (connect on first call, `close`
when done), exactly like the mail adapters.

```ts
interface ConnectorAdapter<Record, Cursor> {
  readonly typeId: string;                          // 'mail-gmail', 'calendar-google', …
  ensureAuth(): Promise<void>;                      // establish/refresh; throw on hard auth failure
  listScopes(): Promise<string[]>;                  // partitions (folders, calendars); [''] for one
  listChangesSince(scope: string, cursor: Cursor | undefined, opts?: { limit?: number }): Promise<{
    records: RecordRef[];                           // lightweight handles (cf. MailEnvelope)
    cursor: Cursor;                                 // advanced cursor to persist (per scope)
    partial?: boolean;                              // more remain; cursor covers this batch exactly
    enumeratedAll?: boolean;                        // this batch IS the full scope (mirror prune gate)
    rateLimited?: boolean;                          // back off; engine stops the pass
  }>;
  fetchRecord(scope: string, ref: RecordRef): Promise<Record>;  // fetch + NORMALIZE (raw → canonical)
  runAction?(action: string, input: unknown): Promise<unknown>; // write-back, commit-time only
  close(): Promise<void>;
}
```

`Record` is the type's canonical shape (a `MailMessage` for mail, an event for calendar).
Normalization — the raw-to-canonical mapping — lives **inside** `fetchRecord` and is never
exposed to the AI. This is the schema-design work that recurs per type; keeping it behind the
adapter boundary is the reason the sync engine and writer never learn a provider's
quirks.

## Drivers: most connector types are configuration, not code

The contract has three implementations, and only one is bespoke code per source. A connector
type declares a **driver**; the first two are generic adapters that *interpret the type
manifest*, so a new source is a JSON file, not a compile. The registry dispatches on `driver`
— the generalization of `createMailProvider`.

- **`mcp` — drive an MCP server as an ingest source.** Gezel already speaks MCP for agent
  tool-calls: [mcp-bridge.ts](../packages/service/src/providers/mcp-bridge.ts)'s `McpBridgePool`
  dispatches stdio / HTTP / SSE via `isHttpSpec()`. The `mcp` driver reuses that bridge in a
  **non-agent** context — the sync host, not the model, connects the server and calls declared
  tools deterministically on a schedule. The manifest names the list/search tool (and how the
  cursor maps to its args), the fetch tool, and the write tool for actions. This repurposes MCP
  slightly — it was built for live agents — but the payoff is the standardized, fast-growing
  MCP ecosystem (Linear, Notion, Sentry, databases, …) as ingest sources for near-zero
  per-source code.
- **`script` — drive a CLI or SDK script.** The manifest points at a sandboxed SDK script
  ([scripts/runner.ts](../packages/service/src/scripts/runner.ts) / [sandbox/runner.ts](../packages/service/src/sandbox/runner.ts))
  or a CLI invocation. Gezel injects the credential from the SecretStore as env/args, runs the
  fetch on the schedule, and applies the same normalization + safety pipeline. This is the
  project-type "script-tool" primitive pointed at ingest instead of the model.
- **`spectral` — host a Prismatic component.** Run an Apache-2.0
  [Prismatic component](#seeding-from-an-external-library-prismatic-components) on its
  `@prismatic-io/spectral` SDK (MIT): the sync host calls the component's read actions and
  populates its `connection` from our SecretStore. Buys a large library of production-used auth
  definitions + REST plumbing; costs a hosted third-party SDK we version-pin and shim. A
  specialization of `script` (external code, our schedule), broken out because the library is
  big enough to be a strategy of its own — see the section below.
- **`native` — bespoke code.** The escape hatch, for **cornerstone corpora** the user lives in
  that resist declarative expression. Email is the exemplar (MIME, threading, quote-stripping,
  HTML→markdown, high-fidelity IMAP/Gmail/Graph cursors — none of which an MCP tool hands you
  clean); Google Calendar is the second. GitHub Releases is native because its uploaded assets
  can be multi-gigabyte binaries that must stream through a digest-verifying, file-backed
  attachment path rather than a JSON/prose driver. Decision rule: **own the sources users live
  in; rent the long tail** through `mcp` / `spectral` / `script`.

  > **The Git substrate is NOT a connector.** Git's value is its *structure* — the commit DAG, diffs,
  > branches, and an AI-*editable* working copy — which is the inverse of the connector shape
  > (mirror an external source into a read-first normalized corpus). Git stays a **core concept**
  > of gezel (native in `git/manager.ts` + `ProjectGitHubView`); the connector framework never
  > touches the git substrate. GitHub's *non-git content* (issues, PR discussions) is a different
  > thing — that content is legitimately connector-eligible data (the `github-issues-cli` `script`
  > exemplar), but the git substrate itself is not. GitHub wikis are connector-eligible page
  > content too: the native wiki adapter uses the separate `.wiki.git` repository only as a
  > read-only transport and exposes normalized pages, never its history or an editable working copy.
  > GitHub releases are connector-eligible as well: the release record is read-first metadata and
  > its uploaded assets are immutable-ish inbound files, not an editable working tree. The native
  > releases adapter mirrors both and can reuse the user's existing GitHub sign-in to see drafts.

All four implement one `ConnectorAdapter`. What gezel provides across all of them is the
part users never want to rebuild per source: the connect UX, credential management, the sync
host, normalization, and the **fault-tolerance envelope** — retry/backoff (mail's `rateLimited`
handling), per-binding `lastError` surfacing, timeouts, quarantine of malformed/hostile
output, and health/circuit-breaking. Writing that reliability once is the strongest argument
for the generic-driver approach.

### Normalization is a spectrum, not free

The manifest makes **connect, fetch, and schedule** genuinely declarative — exactly the
auth-lifecycle pain the contract exists to isolate. It does **not** make normalization free.
MCP tools and CLIs return arbitrary JSON or prose; turning that into canonical, frontmattered,
uniform inspectable records is per-source work. So a type's `normalize` step is one of:

- a **field mapping** (declarative: source fields → frontmatter + body) — enough for tidy,
  structured tool output;
- a **transform script** (a sandboxed SDK script: raw output → canonical records) — for messy
  or prose-heavy sources;
- **native** normalization, for the cornerstone types.

"A connector type is just a JSON file" holds for the connect/sync half and is optimistic for
the normalize half — budget a small transform script for most real `mcp` / `script` sources.

### Two postures of one server — the isolation rule

The same MCP server can be used two ways, and a connector install must be explicit about which:

- **Model-exposed** (the claude.ai posture): the server's tools sit on the model's session
  surface; the model calls them live.
- **Ingest-bound** (the connector posture): the server is bound to the **sync host only** and
  never appears on the model's tool surface. The model sees the resulting corpus, not the tool.

Load-bearing rule: **an `mcp` / `script` connector's write action is invoked at commit time by
the outbox, never exposed to the model directly.** If the live write tool were on the model's
surface, the draft→queue→commit gate and the deny-by-default allowlist would be moot — a
prompt-injected turn could just call it. Ingest-bound is what preserves the isolation the whole
feature rests on.

### Seeding from an external library (Prismatic components)

[Prismatic's `components`](https://github.com/prismatic-io/components) is ~170 pre-built SaaS
connectors (Salesforce, Jira, Slack, Dropbox, S3, …) under **Apache-2.0**, each built on the
`@prismatic-io/spectral` SDK (**MIT**). Both licenses are permissive and compatible with gezel's
MIT — we may vendor and modify. Prismatic accepts no external PRs and calls off-platform use
"unsupported," so we fork and own maintenance. It is a strong seed library — but the value is
**not uniform**, and adopting it well means cutting along that seam rather than swallowing it
whole:

- **Auth definitions (`connections.ts`) — high value, ~zero coupling.** Each component's OAuth
  authorize/token URLs, scopes, and client-id/secret field shapes are pure declarative config.
  A build-time importer can transpile them into the auth half of our `connector-type` manifests
  (`secretShape` + connect UX). This is 170 services' correct, production-proven auth as a
  ready-made credential catalog — and it feeds **every** driver, not just `spectral`.
- **Read actions (`actions/*`) — medium value, spectral-host coupling.** The `list*` / `get*`
  verbs are the "pull data" calls. Reusing them is what the **`spectral` driver** does: host
  spectral, inject the connection from our SecretStore, call the action, run **our** normalize.
- **Triggers — skip.** Built for Prismatic's webhook/poll event model, not our idle-gated host.
- **Normalization — theirs is none.** Actions return raw provider JSON (`{ data }`) by design;
  the canonical mapping is ours to write. The two hardest things — normalization and resumable
  cursors — the library does not provide.

Honest caveats: coverage is **standardized but only ~40% unit-tested** (the flagship `github`
ships no tests — treat it as "production-used," not "verified for us"); components deep-import
`@prismatic-io/spectral/dist/...` (private paths → pin a spectral version, expect a shim); and
they're webpack-bundled for `prism publish`, so we consume `src/` and compile ourselves. Running
vendored third-party code on our schedule is the autonomous-execution surface from the posture
section — sandbox it, sha-pin it.

Preference rule for the long tail: **`mcp` first when a decent server exists** (cleaner
boundary, the server owns its own auth), **`spectral` / Prismatic when it doesn't.** The
auth-catalog harvest is worth doing regardless of which driver a given source ends up using.
Whether to fold the **entire** library plus a pinned spectral into gezel — versus curating
components on demand — is a later evaluate-then-decide (see phases).

## On-disk layout and normalization

Generalizes [mail/storage.ts](../packages/service/src/mail/storage.ts) into a shared
connector writer. Records land under the project's managed artifacts tree, not in the
workspace or the user's repository:

```
<artifacts>/data/<corpusName>/<scope>/…normalized records…
```

The naming, the scope level, the `_`-prefixed mutable surface, and the record-file shape are
specified in [connector-standards.md §1](./connector-standards.md#1-the-data-placement-contract).

Non-negotiable writer discipline, inherited verbatim from mail:

- **Trust frontmatter on every record.** `trust: untrusted-external`, `direction: inbound`,
  `account`/binding id, source ids, and the `scan_action` verdict. Downstream prompt
  assembly and the safety layer key off `trust`.
- **Injection scan + quarantine.** Every record body runs through `contentScanner.scan`
  ([safety/index.ts](../packages/service/src/safety/)); a quarantine verdict diverts the raw
  bytes to the workspace's `.gezel/quarantine/` (outside artifacts) and writes only a stub. External
  data is hostile-by-default; the corpus is where injection lands.
- **Path safety.** Every path component derived from source data is slugged and funneled
  through `resolveInside` / `safeJoin` — a hostile subject, filename, or record id cannot
  escape the artifacts root.
- **Idempotent, refresh-in-place.** Records are content-hashed: re-sync is a no-op on
  unchanged records, replaces a changed record's file in place (stable ordinal), and — for
  mirror-completeness sources, after a clean full enumeration — prunes records the source no
  longer returns. Only connector code mutates the corpus. Mutable state (read/seen flags,
  content hashes) goes in an unindexed sidecar.

**Corpus writability — decided and enforced.** A connector corpus is *inbound
source-of-truth*; the AI reasons over it and writes its analysis elsewhere in `artifacts/`, never
mutating the corpus. The corpus is **read-only to the AI**, with `_`-prefixed entries
(`_drafts/`, `_outbox/`, `_flags.json`) as the only writable surfaces — see
[connector-standards.md §1.5–1.7](./connector-standards.md#15-the-_-rule-underscore-means-mutable).
Enforced for gezel-initiated artifact writes at the daemon artifact boundary (with the MCP
tool rejecting the same paths early), because a deleted record is never re-fetched — the
cursor has already advanced past it. Script-dispatch artifact mutations remain the
documented residual gap.

## The isolation boundary — what it buys, and its one caveat

Precisely what is isolated: the **credentials and the network fetch**. The connector process
holds the OAuth token and talks to Gmail; the AI holds files. Enforced three ways, all of
which mail already does:

1. The adapter runs inside a service-owned manager, never in the MCP bridge.
2. Credentials live in the SecretStore and are **never** injected into the MCP subprocess
   env (which gets only `GEZEL_BASE_URL` / `GEZEL_TOKEN` / ids).
3. The AI's view of the source is the normalized corpus, read as ordinary files. There is no
   "the AI calls the connector to fetch" path — that would dissolve the boundary.

The honest caveat: the AI still has `run_nodejs_script` / `run_playwright_script` /
`npm_install`, which can reach the network. So the guarantee is **"the AI is never handed the
credentials or the fetch code,"** not a physical airgap. Elevating to the stronger claim is a
sandbox-network-policy conversation and belongs in [sandbox/runner.ts](../packages/service/src/sandbox/runner.ts),
not the connector layer.

## Sync engine

One `ConnectorSyncManager` ([connectors/sync-manager.ts](../packages/service/src/connectors/sync-manager.ts),
generalized from mail's original loop) serves every type. Its discipline is the reason autonomous sync is safe to leave running:

- **Idle-gated.** Never fights a live chat turn; respects OS idle and the night-shift flag.
- **Posture-gated.** Dormant under lockdown / super-lockdown; autonomous sync rides
  `resolveSecurityPolicy(cfg).allowExternalServices`. A manual, user-initiated sync is a
  separate route with its own (stricter) gate.
- **One unit per tick, staleness-ordered.** Bounded work; the least-recently-synced due
  binding goes first.
- **Cursor-resumed.** Resume from the persisted cursor; never re-walk the whole source.

## Secrets and auth

Reuse the SecretStore keying mail established: a credential blob per binding, keyed by
connector type + binding id, with an OAuth-refresh callback that re-persists the rotated
token (`persistOAuth` in [mail/registry.ts](../packages/service/src/mail/registry.ts)). Auth
configuration is a **human-in-the-loop step** — the Meester or a settings flow, never a tool
call — and its UX (OAuth consent screens, IMAP passwords, revocation, error surfacing via the
binding's `lastError`) is the genuinely expensive 80% of every new type. The contract keeps
that cost inside the adapter; it does not remove it.

## Write-back and the morning briefing

Generalized from mail's outbox (now [connectors/consent.ts](../packages/service/src/connectors/consent.ts) +
[connectors/actions.ts](../packages/service/src/connectors/actions.ts)). A type may declare
**actions** (mail declares "send"). Actions never execute inline:

1. The AI calls a **draft** action → a draft file is written to `_drafts/`. **The draft file
   is the human review surface.**
2. A **queue** step stages it to `_outbox/`.
3. A **commit** step transmits and records a receipt to `_sent/`.

Two hard gates, both already enforced for mail and both load-bearing against a prompt-injected
agent:

- **Deny-by-default allowlist.** Sending is permitted only to addresses/domains the user
  explicitly allowlisted on the project. No allowlist → nothing transmits. The generalized
  form: every action declares a consent scope, and the daemon — not the model — enforces it.
- **Night-shift deferral.** `send_email` refuses to transmit during night shift; the message
  stays staged for daytime approval. This **is** the morning-briefing model: the night shift
  drafts and queues, the user reviews the outbox and commits in the morning. The
  [HistoryManager](../packages/service/src/history/manager.ts) audit log and the keurmeester
  intervention layer are the substrate for that review view.

Ship connectors **read-only first.** Actions are phase 2. Read value (reports, cross-corpus
analysis) is real on its own and carries none of the send-a-thing-to-the-world risk.

## Catalog modeling and relationship to project types

Connector **types** are a catalog kind, using the standard gilde item layout already used by
`gezel-templates/`, `craftbook-templates/`, and `project-types/`:

```
data/connector-types/{shard}/{id}/
├── manifest.json          identity: schemaVersion, id, name, description, tags, maintainer, kind: 'connector-type'
└── versions/{semver}/
    ├── manifest.json       driver + source + normalize + configSchema + actions (below)
    └── normalize.ts?       optional transform script (script/mcp drivers with messy output)
```

The version manifest is where "a connector type is a JSON file that configures (a) or (b)"
becomes concrete:

```jsonc
{
  "driver": "mcp",                       // 'mcp' | 'script' | 'native'
  "configSchema": { /* binding form: which folders / labels / repos / projects */ },
  "secretShape": { /* what credential the binding stores in the SecretStore */ },
  "source": {                            // driver-specific
    // mcp:    { server: { command|url, args, envFromSecret },
    //           list: { tool, cursorArg }, fetch: { tool }, actions: { send: { tool } } }
    // script: { fetch: "fetch.ts", envFromSecret: ["TOKEN"] }
    // native: { adapterId: "mail-gmail" }
  },
  "normalize": { "kind": "mapping", "map": { /* source field → frontmatter/body */ } },
                                         // or { "kind": "script", "script": "normalize.ts" } | "native"
  "actions": [{ "name": "send", "consentScope": "recipient-allowlist" }]
}
```

Sources compose **local → bundled → community** like every other kind. First-party adapters
(the mail providers, github) are bundled and map to native service code; the manifest is the
discoverable, versioned face over them — the same "wrap native code in a bundled manifest for
gallery unity" move [project-types.md](./project-types.md) makes for the mail pipeline.

Connectors are the **missing input primitive** for [custom project types](./project-types.md).
A project type is a composition manifest; today it composes gezels, craftbooks, scripts,
toolsets, pages, and schedules. Add `connectors` to that list and an "Inbox Triage" or
"Weekly Ops Digest" type can declare the gmail + calendar bindings it needs, the craftbooks
that reason over the corpus, and the night-shift schedule that runs them — one installable
kit. The connector fills the corpus; the project type's craftbooks turn it into reports.

## Relationship to MCP servers

Not download-*versus*-MCP: a connector can **be** an MCP server (the `mcp` driver). The
distinction that matters is **posture**, not technology (see [the isolation rule](#two-postures-of-one-server--the-isolation-rule)):

- **Ingest-bound** (connector): the server is driven by the sync host, its output normalized
  into an inspectable corpus the model reads as artifact files. Reproducible, diffable,
  injection-scanned. Weak at bulk/historical (below).
- **Model-exposed** (live tool): the server's tools sit on the model's session; up-to-the-second,
  natural for "do X now," but the model holds a live handle to the API and its auth, and there
  is no corpus to browse or diff.

Same server, two postures; some installs want both (ingest Notion into the corpus for analysis
*and* expose a Notion "create page" tool live). Recommended stance: **corpus for reasoning and
analysis, model-exposed MCP for real-time action** — with a connector's gated *write* actions
as the controlled bridge back to "do X now." The product needs one sentence a user understands
for when each applies.

### What MCP-as-ingest can't do well

MCP tools were built for agents, not bulk sync. Many expose "search" or "get recent," not
"everything since cursor X" with a stable, resumable cursor. So `mcp` connectors are often
**rolling-window mirrors** (recent activity), not complete historical corpora. Sources where a
full, faithful backfill matters — email again — are exactly the ones that justify a `native`
adapter. State per connector whether the user is getting a **mirror** or a **window**.

## Security posture

Connectors extend the existing `SecurityPolicy` ladder ([schemas/api.ts](../packages/core/src/schemas/api.ts)),
they do not add a parallel one:

- Autonomous sync is gated by `allowExternalServices`; lockdown postures stop the loop.
- The corpus is `trust: untrusted-external` and injection-scanned; quarantine keeps hostile
  raw content out of the artifact tree while leaving a safe stub. This is the single largest
  new attack surface — all inbound.
- Write actions are deny-by-default and daemon-enforced; the model cannot widen its own
  allowlist.
- **Autonomous third-party execution.** An `mcp` / `script` connector means gezel runs
  third-party code **on a schedule, unattended** — a larger surface than a tool the user
  invokes through an agent. The project-type sharing rules apply harder: catalog-referenced
  with sha pins, declared capabilities shown at install, the sandbox caveats acknowledged
  (weakest on Windows/Linux — see [project-types.md](./project-types.md)), and autonomous sync
  gated by `allowExternalServices` so lockdown halts it.
- **Corpus-at-rest** is a new decision the mail feature did not force at scale: a full mailbox
  in plaintext files is sensitive. Options — leave as plaintext (local-first, on the user's
  disk), or encrypt-at-rest with a key from the secrets backend. Flagged for [secrets-security.md](./secrets-security.md)
  to rule on.

## Deliberate exclusions (v1)

- **No write actions in v1.** Read-only corpora first; the outbox generalization is phase 2.
- **No entity resolution across connectors** (same person in mail + calendar + Slack). Real
  value, real rabbit hole; defer. Records carry their native identifiers; joining is later.
- **No new *interpreter*.** The `mcp` and `script` drivers reuse the existing MCP bridge and
  sandbox; no new code-execution engine is added. Bundles never carry adapter code — `mcp`
  servers and scripts are catalog-referenced with sha pins (same rule as project-type sharing).
  What *is* new is running them autonomously; that risk is handled in the posture section.
- **Breadth is not a v1 goal.** The generic drivers are *how* breadth becomes cheap later; v1
  proves the mechanism with one type per driver plus the two `native` cornerstones (mail,
  github), not a gallery. The long tail rides the sdk/catalog after the contract is proven.

## Proposed rollout phases

Coarse on purpose — the detailed implementation plan is the next artifact.

1. **Extract the contract.** Lift `ConnectorAdapter`, the shared writer (trust frontmatter +
   scan + quarantine + path safety), `ConnectorSyncManager`, and the SecretStore keying out of
   `mail/` as a `connectors/` core, with **mail re-expressed as the first adapter over it** —
   a pure refactor, its existing tests the safety net.
2. **Schema + catalog kind.** `ProjectConnectorBinding` on `project.json`, `connector-type`
   catalog kind carrying `driver` / `source` / `normalize`, bundled manifests wrapping mail +
   github as `native`. Binding config form from the type's `configSchema`.
3. **Generic drivers — the leverage phase.** `McpConnectorAdapter` over the existing bridge and
   `ScriptConnectorAdapter` over the sandbox, each with the normalization spectrum (mapping +
   transform-script). Ship one manifest-only type per driver (e.g. a Notion/Linear-style `mcp`
   source; a CLI `script` source) with a small `normalize.ts`. This is what proves the contract
   generalized to **config, not code** — and it retires the risk that we merely re-described
   mail.
4. **`spectral` driver + auth-catalog harvest.** `SpectralConnectorAdapter` hosting a pinned
   `@prismatic-io/spectral`; a build-time importer transpiling Prismatic `connections.ts` into
   our auth catalog (feeds every driver). Prove one Prismatic component end to end — pick a
   source with no good MCP server — with our normalize over its raw output.
5. **`connectors` in project types.** Let a project type declare bindings; ship one exemplar
   kit end to end (e.g. "Weekly Ops Digest" over a cornerstone `native` source + a long-tail
   `mcp` / `spectral` source).
6. **Write actions + morning briefing.** Generalize the outbox to the action contract (with the
   ingest-bound write rule enforced), build the outbox-review UI over History, wire night-shift
   draft/queue → daytime commit.
7. **Later.** **Evaluate folding the Prismatic library wholesale** (all ~170 components + a
   pinned spectral, vendored into gezel) versus curating components on demand — a maintenance /
   footprint / trust tradeoff to decide once the `spectral` driver is real. Plus entity
   resolution, corpus-at-rest encryption, community connector types via the sdk, an
   enrichment-budget policy for large corpora, and mirror-vs-window UX per binding.
