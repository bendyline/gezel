# Connector standards and practices

[connectors.md](./connectors.md) is the *why* — the architectural thesis, the driver
strategy, the security posture. This document is the *how*: the normative contract every
connector must satisfy, in particular **where a connector puts the data it retrieves**.

It is written for anyone adding a connector type (a gilde manifest), writing a `native`
adapter, or changing the sync engine, the writer, or the action surface.

The connector overhaul (August 2026) brought the implementation into conformance with this
document; the [conformance table](#conformance-current-state) at the end records the state
per rule, including the deliberate residual gaps.

## Vocabulary

| Term | Meaning |
|---|---|
| **connector type** | The reusable, versioned adapter definition. A gilde catalog item (`mail-gmail`, `linear-issues`). |
| **binding** | One configured instance of a type on one project. Carries config, cursor, sync state. Credential lives in the SecretStore, never on the binding. |
| **scope** | A partition *within* one binding: a mailbox folder, a calendar, a saved query, a table. Produced by `listScopes()`. |
| **record** | One retrieved item, normalized to a `NormalizedRecord` and written as one immutable markdown file. |
| **corpus** | Everything one binding has written to disk. |
| **action** | A declared write-back capability of a type. Drafted by a gezel, committed by a human. |

## 1. The data-placement contract

This is the part that most needs a standard, because a connector's whole value is that its
output is findable — by the indexer, by a gezel, and by the user in a file browser.

### 1.1 One corpus root per binding, under `data/`

```
<project workspace>/
└── data/
    └── <corpusName>/                 the binding's corpus root
```

`<corpusName>` is a slug, resolved **once at bind time** and persisted on the binding as
`corpusDir`. Rules:

1. Prefer the user's `displayName` — `data/work-gmail/`, `data/support-inbox/`.
2. Fall back to the connector type id — `data/linear-issues/`.
3. On collision with an existing binding's `corpusDir`, append `-2`, `-3`, …
4. Once written, **it never changes.** Renaming a binding does not move files on disk; the
   corpus is the stable thing, the label is not.

Rationale for pinning at bind time rather than deriving per sync: a derived path silently
strands the old corpus the first time a user edits a display name, and the indexer keeps
serving both copies.

Implementation: `corpusDir` on `ProjectConnectorBindingSchema`, resolved by
`resolveCorpusDir` in [manager.ts](../packages/service/src/connectors/manager.ts) at bind
time (lazily backfilled for older bindings on their next sync) and shared with the action
manager through `corpusDirFor`. Mail writes here too — the separate `mail/` tree died with
the `project.mail` stack.

### 1.2 Scope is a directory level, and the engine owns it

If a binding retrieves more than one thing — two inboxes, two calendars, two saved queries —
each lands in its own subdirectory:

```
data/<corpusName>/<scope>/…
```

`<scope>` is `slug()` of the string the adapter returned from `listScopes()`. The **sync
engine** prepends it; an adapter must not re-derive it inside `dirSegments`. When a binding
has exactly one scope and that scope is the empty string, the level is omitted entirely — no
`records/` filler directory.

Below the scope, an adapter may add its own partitioning through `NormalizedRecord.dirSegments`
— a month bucket, a thread folder, a team name. That is optional and adapter-owned. Scope is
not.

```
data/work-gmail/inbox/2026-08-04--quarterly-review--6b1f0a92/001--….md
data/work-gmail/sent/…
data/team-calendars/mike-bendyline-com/2026-08/2026-08-04--standup.md
data/linear-issues/platform-team/001--flaky-ci-on-windows--0af31c22.md
```

Implementation: `syncWithAdapter` joins `slug(scope)` between the corpus root and the
record's `dirSegments` (`scopeAsDir`, on by default); mail and calendar dropped their
hand-rolled scope segments, and an ungrouped mapping record lands at the scope root — the
old `records/` filler directory is gone.

### 1.3 Scopes versus separate bindings

Both partition data; pick by what the user is authorizing, not by what is convenient:

- **One binding, many scopes** — one credential, one authorization, one sync schedule, one
  error surface. Two folders in the same mailbox. Two calendars in the same Google account.
  Two tables in the same Airtable base.
- **Separate bindings** — different credentials, different accounts, or a user who wants to
  disable/unbind one without touching the other. Work Gmail and personal Gmail.

A type that can retrieve multiple things from one credential **should** expose them as scopes
via `configSchema` (`syncFolders`, `calendars`, `queries`, `tables`) rather than making the
user bind the same account twice.

### 1.4 The record file

Owned entirely by [writer.ts](../packages/service/src/connectors/writer.ts). Adapters supply
the pieces; they never build a path.

```
<NNN>--<fileStem>--<recordHash8>.md      NNN = 3-digit ordinal within its directory
attachments/<NNN>/<safe-filename>        original bytes, filename sanitized to one segment
```

- `recordHash8` is `sha256(record.recordId).slice(0,8)` — the record's **identity**. A
  separate **content hash** (key-sorted domain frontmatter + body + ordered attachment
  filename/size/SHA-256 identities, stored in the `_flags.json` sidecar) decides idempotency.
- The corpus tracks the **current state of upstream** (refresh-in-place). A re-synced
  record whose content hash matches is skipped; one whose content changed **replaces its
  file in place** — same ordinal (so the attachment dir stays stable), new stem/hash in the
  sidecar. Mirror-completeness sources may additionally **prune** records the source no
  longer returns, but only after a clean, single-batch, full enumeration of the scope
  (`ChangeBatch.enumeratedAll`; window types never prune). Ordinals go sparse after a prune
  by design — the writer allocates from the max, never the count.
- Only connector code performs these mutations. Gezels are read-only on the corpus (§1.7).
- Every path component that came from the source — record id, title, filename, scope name,
  group — is `slug()`ed by whoever produces it and joined through `resolveInside`. Both, not
  either.
- Small attachments may arrive as in-memory bytes. Large binaries use the file-backed
  attachment variant: the adapter streams to a private temporary file, calculates SHA-256
  (and checks provider-supplied size/digest metadata), then the writer atomically copies it
  into the record's attachment directory. The adapter retains the staging directory until
  `close()`, so multi-gigabyte release assets never need to exist as one heap allocation.
- Consequence for adapters: pick a `recordId` that is **stable across edits** (the GitHub
  wiki adapter uses the page path, not `path:blobSha`) and keep repo-global volatile fields
  (HEAD commit sha/date) out of the frontmatter, or every upstream commit churns every
  record's content hash.

### 1.5 The `_` rule: underscore means mutable

Everything inside a corpus root is connector-owned inbound data **except** entries whose
name starts with an underscore — the designated mutable surface. That is the one rule a gezel, a reviewer, and a future writer all need:

```
data/<corpusName>/
├── _meta.json                      binding provenance + what this corpus is
├── _actions/
│   ├── _drafts/<id>.md             drafted by a gezel — the human review surface
│   ├── _outbox/<id>.md             staged, awaiting daytime approval
│   └── _sent/<id>.md               committed receipt
└── <scope>/
    ├── _flags.json                 read/seen/content-hash sidecar, never indexed
    └── …record files (connector-managed)…
```

`_meta.json` is the discoverability surface — binding id, type id and version, display name,
scopes, completeness (`mirror` | `window`), and `lastSyncedAt` — so that `ls data/` tells a
gezel what each directory is without a tool call.

Implementation: the sync manager writes `_meta.json` after every pass; `_actions/` lives
under the binding's corpus root.

### 1.6 Quarantine stays outside the corpus

A `quarantine` verdict from `contentScanner.scan` diverts the raw body to
`<workspace>/.gezel/quarantine/<namespace>/<hash8>.md` — outside every indexed root — and
writes only a stub into the corpus. The stub keeps the record's frontmatter, so the record
count and the trust metadata stay honest. This is non-negotiable and already correct.

`quarantineNamespace` should be the **connector type id**, so quarantined content is
attributable (`mail`, `calendar`, `github-wiki`, `linear-issues`).

### 1.7 Who may write to a corpus

The corpus is inbound source-of-truth. A gezel reasons over it and writes its conclusions to
`artifacts/`. A gezel must not mutate or delete records.

Enforced in the daemon, not the tool client: `Store.assertWorkspaceWritable` denies
gezel-initiated writes under `data/**` unless a path segment below `data/` starts with `_`
(reason `data-subtree-readonly`, mapped to an actionable MCP error). Rename is checked on
both endpoints; user-initiated writes stay exempt. Why it matters: a deleted record is never
re-fetched — the cursor has already advanced past it — so a gezel write here would be silent
permanent loss. Known residual gap: sandboxed scripts (`run_nodejs_script`, npm hooks) write
with raw filesystem access and bypass the path policy (the `derive_data` output path is
gated); closing that fully is a sandbox-network/fs-policy conversation, not a connector one.
A gezel can also technically write into `_sent/` (receipt spoofing) — receipts are
informational; the commit itself is server-side.

## 2. The adapter contract

`ConnectorAdapter` in [types.ts](../packages/service/src/connectors/types.ts). One instance
per sync pass: connect on first call, `close()` when done, always.

```ts
readonly typeId: string;
ensureAuth(): Promise<void>;
listScopes(): Promise<string[]>;
listChangesSince(scope, cursor): Promise<ChangeBatch<Cur>>;
fetchRecord(scope, ref): Promise<NormalizedRecord>;
runAction?(action, input): Promise<unknown>;
close(): Promise<void>;
```

Standing rules:

1. **No provider SDK types above this line.** Everything a source knows stops at the adapter.
2. **`fetchRecord` normalizes.** Raw → `NormalizedRecord`, inside the adapter. The engine, the
   writer, and the indexer never learn a source's quirks.
3. **`close()` releases everything** — sockets, MCP subprocesses, temp checkouts — and is
   called on the error path too.
4. **`ensureAuth` throws on hard auth failure**, with a message a user can act on. It lands in
   the binding's `lastError` and is the only auth diagnostic the UI has.
5. **Rotated OAuth tokens are re-persisted** through the binding's secret key before the pass
   continues (`persistOAuthTo` in [registry.ts](../packages/service/src/connectors/registry.ts)).
6. **`runAction` is never on the model's tool surface.** It is invoked at commit time by the
   outbox and by nothing else. See [§5](#5-write-back).

### 2.1 Cursors are per scope

A cursor is opaque to the engine and adapter-shaped. The one thing the engine guarantees is
that **the cursor an adapter sees for scope A is the cursor it last returned for scope A.**

Implementation: the persisted cursor is a per-scope envelope
(`{ v: 2, scopes: { [scope]: cur } }`; `asScopedCursor` in
[manager.ts](../packages/service/src/connectors/manager.ts)). Anything that isn't a v2
envelope is discarded — the writer's idempotency makes the re-backfill safe. This fixed a
live bug: the old engine threaded one cursor across scopes, and `calendar-google` (bare
`nextSyncToken` per calendar, all calendars by default) could not sync a multi-calendar
binding past its first pass. A clean scope also now advances even when a later scope fails.

### 2.2 Advance the cursor only on a clean batch

Already correct, and worth stating so nobody "simplifies" it: a scope's cursor advances only
when every record in the batch fetched and wrote without error. On any failure the prior
cursor is kept and the batch retries next pass — safe because the writer is content-hash
idempotent, so the already-written records dedupe rather than the failed one being skipped
forever.

### 2.3 Bounded work per pass

Each scope takes the newest `backfillLimit` refs; overflow is counted in `skipped`.

Two obligations that follow:

- **Sort key.** Newest-first ordering uses `RecordRef.ordinalKey`. The generic drivers derive
  it from the record timestamp (`ordinalKeyFromTs`); an adapter that sets neither gets a
  stable no-op sort, which is only safe for sources that order results themselves.
- **Overflow is windowing, never silent.** The engine passes `limit` to `listChangesSince`;
  an adapter that can page returns at most that many records with `partial: true` and a
  cursor covering exactly the batch — the engine then loops the scope (bounded rounds per
  pass, remainder next tick), so nothing is lost. An adapter that over-returns gets the
  newest-`limit` slice, the overflow counted in `skipped` **and logged** — that is the mail
  backfill-cap model (deliberate windowing), visible rather than silent.

### 2.4 Backpressure

`ChangeBatch.rateLimited` means "the source asked us to back off; resume next tick."

Implementation: providers throw `HttpStatusError`; adapters convert 429/503 on the list
call into a `rateLimited` batch (records kept, cursor persisted). The engine stops the whole
pass, and `ConnectorManager` backs the binding off in memory (jittered 1m → 5m → 15m → 30m
ladder via core's `net-retry`, reset on a clean pass, surfaced as `backoffUntil` in status).
Autonomous sync skips a backed-off binding; a user-initiated sync overrides. Per-record
fetches additionally get three `retryTransient` attempts, so a socket blip is not a scope
error. The `mcp` / `script` / `spectral` drivers have no reliable throttle signal and do not
set `rateLimited` — documented limitation.

## 3. Choosing a driver

| Driver | Use when | Cost |
|---|---|---|
| `mcp` | A decent MCP server exists for the source. | Server owns its own auth; often a rolling window, not a mirror. |
| `script` | No server, but a REST API or CLI you can drive from a sandboxed SDK script. | You write and maintain the fetch loop and its pagination. |
| `spectral` | No server, and a Prismatic component covers the source. | A pinned third-party SDK in the sync host. |
| `native` | A cornerstone corpus the user lives in, whose fidelity resists declarative expression. | Bespoke service code, forever. |

The decision rule from [connectors.md](./connectors.md) stands: **own the sources users live
in, rent the long tail.** Reach for `native` when a source needs real parsing (MIME,
threading, quote-stripping) or a high-fidelity resumable cursor — not because a mapping felt
fiddly.

Whatever the driver, a connector must declare `completeness`:

- **`mirror`** — a faithful copy; absence from the corpus means absence upstream.
- **`window`** — recent activity only; older items were never fetched.

This is a promise to the user and to any craftbook reasoning over the corpus. State it, and
carry it into `_meta.json` so a gezel reading the corpus can see it too.

Implementation: `status()` resolves each binding's manifest and reports `completeness`
per binding; the sync manager writes it into `_meta.json` on every pass.

## 4. Authoring a connector type

Item layout in [bendyline/gilde](https://github.com/bendyline/gilde):

```
data/connector-types/{shard}/{id}/
├── manifest.json                  identity: id, name, description, tags, maintainer, kind
└── versions/{semver}/
    └── manifest.json              driver + source + normalize + configSchema + secretShape
                                   + actions + completeness + notes
```

Checklist:

- **`configSchema`** is the binding form the user fills in, and the place scopes are chosen
  (`syncFolders`, `calendars`, `tables`). Keep required fields to what the fetch genuinely
  cannot proceed without.
- **`secretShape`** declares the credential: `oauth2` (with authorize/token URLs, scopes, and
  the env vars naming the install's client), `apikey` (with `field` and a human `label`), or
  `imap`. Mark `required: false` for sources that work anonymously — `github-issues` and
  `github-wiki` both do.
- **`normalize`** is `mapping` for tidy JSON, `script` for messy or prose-heavy output,
  `native` when the adapter already built the record. Set `title` and `timestamp` whenever the
  source has them: they become the filename stem and the `date` frontmatter, and a corpus
  without them is a wall of ids.
- **`notes`** carries the honest caveats — what is not mirrored, what is not pruned, what the
  first sync covers versus later ones. `airtable-records` and `github-issues` are the models
  to copy.
- **OAuth types must come from the bundled catalog.** `startOAuth` refuses any other source,
  because an OAuth manifest chooses where authorization codes and client secrets are sent.

Implementation: `bind()` validates config against `configSchema` through a small
JSON-Schema-subset validator ([config-validate.ts](../packages/service/src/connectors/config-validate.ts):
type/properties/required/const/enum/items, permissive on unknown keywords) and rejects with
a field-level 400 instead of a sync-time `lastError` days later.

## 5. Write-back

Retrieval is bulk, offline, low-stakes. Writing is none of those, so it is a separate,
narrow, deny-by-default surface with a fixed shape:

1. A gezel **drafts** an action → `_actions/_drafts/<id>.md`. Only actions the type
   declares may be drafted. The draft file is the human review surface. No network.
2. A **queue** step stages it to `_actions/_outbox/`.
3. A **commit** step transmits and records a receipt to `_actions/_sent/`. Committing must
   clear the action's **consent scope** through the daemon-enforced registry
   ([consent.ts](../packages/service/src/connectors/consent.ts)) — no declared scope, no
   registered enforcer, or a failing enforcer all deny. Generic actions have no enforcer an
   agent can satisfy, so their commit is user-only in practice; mail's `send_email` commits
   through the `recipient-allowlist` enforcer (deny-by-default, allowlist on the binding
   config), which preserves the historical mail semantics.

Two gates, both load-bearing against a prompt-injected turn:

- **Consent scope.** Every action declares one; the daemon enforces it at commit. The model
  cannot widen it. Mail's recipient allowlist is the reference implementation.
- **Night-shift deferral.** A commit during night shift stages to `_outbox/` instead of
  transmitting, for daytime approval. This is the morning-briefing model.

Draft/queue/commit and discard are serialized per project through the same
`ProjectLocks` instance the sync engine uses, so a commit can't race a sync or a concurrent
discard.

## 6. Discoverability

A corpus nothing knows about is a corpus nothing reads. Three surfaces have to agree:

- **The indexer** picks up the workspace, so records are searchable for free. Correct today.
- **The system prompt** names the project's corpora: `buildInstructions` renders a terse
  "Connected data" block (one line per binding — label, type, corpus path, last sync —
  capped at eight) plus the read-only rule. Absent entirely when no bindings exist, so
  no-connector prompts stay byte-identical for prefix caching.
- **`_meta.json`** answers "what is this directory?" for a gezel already reading files.

The model's connector tool surface is deliberately small: `draft_connector_action`, plus
the mail-specific `draft_email` / `queue_email` / `send_email` (thin wrappers over the same
action routes, with send gated by the consent registry). Reading a connector is reading its
files. Do not add a "fetch from the connector" tool — that dissolves the isolation the whole
feature rests on.

## 7. Safety invariants

Never traded away, for any driver:

1. **`trust: untrusted-external` on every record**, plus the `scan_action` verdict. Prompt
   assembly and the safety layer key off it.
2. **Every body through `contentScanner.scan`**, quarantine outside every indexed root.
3. **Path safety twice** — `slug()` at the adapter, `resolveInside` at the writer.
4. **Credentials never leave the daemon.** Not into the MCP subprocess env, not into a
   sandboxed script (a `script` connector reaches its credential parent-side through
   `gezel.http.authed` by *name*), not into the model's context.
5. **Ingest-bound MCP servers stay off the model's tool surface.**
6. **Autonomous sync rides `allowExternalServices`.** Lockdown stops the loop. A
   user-initiated sync is a separate route with its own gate.

## 8. Testing a connector

- **Adapter unit tests** drive the adapter against a faked transport, asserting the
  scope/cursor/record shape — [github-wiki.test.ts](../packages/service/src/connectors/natives/github-wiki.test.ts)
  is the model.
- **Golden normalize tests** pin a real raw payload to its `NormalizedRecord` —
  `normalize-github.golden.test.ts`, `normalize-airtable.golden.test.ts`. Every `mapping`
  type should have one; a source that changes a field name under you is otherwise invisible.
- **Engine tests** use the injectable `write` seam on `syncWithAdapter` — no disk, no source.
- **Cursor resumption** deserves an explicit test per adapter: sync, advance, sync again,
  assert the second pass fetched only what was new. For multi-scope adapters, assert scope
  isolation.

## Conformance: current state

| # | Standard | Status | Where |
|---|---|---|---|
| 1 | Corpus under `data/<corpusName>/`, pinned at bind time | Met — `corpusDir` on the binding, resolved at bind, lazily backfilled | manager.ts |
| 2 | Scope is a path level, engine-owned | Met — engine joins `slug(scope)`; adapter scope segments removed | manager.ts |
| 3 | Per-scope cursors | Met — `{v:2, scopes}` envelope; clean scopes advance independently | manager.ts |
| 4 | Refresh-in-place, content-hashed, idempotent records + mirror prune | Met — sidecar content hash; triple-gated prune | writer.ts, manager.ts |
| 5 | Trust frontmatter + scan + quarantine + path safety | Met | writer.ts |
| 6 | Corpus read-only to gezels | Met at the Store chokepoint; sandbox-script raw-fs writes remain a documented gap | fs/store.ts |
| 7 | `_`-prefix marks the mutable surface | Met — stated here, enforced by the `data/` gate | fs/safe-paths.ts |
| 8 | `_meta.json` provenance | Met — written after every sync pass | manager.ts |
| 9 | Cursor advances only on a clean batch | Met | manager.ts |
| 10 | Bounded pass without silent loss | Met — `limit` + `partial` paging; over-return windowing counted and logged; `ordinalKey` from timestamps in generic drivers | manager.ts, drivers/ |
| 11 | Backpressure on `rateLimited` | Met for native HTTP adapters — pass stops, binding backs off (jittered ladder), status shows `backoffUntil`; mcp/script/spectral have no throttle signal | manager.ts, mail/adapter.ts |
| 12 | `completeness` surfaced per binding | Met — status + `_meta.json` | manager.ts |
| 13 | `configSchema` validated at bind | Met — subset validator, field-level 400 | config-validate.ts |
| 14 | Actions declared, consent enforced at commit | Met — undeclared drafts rejected; consent registry, unknown scope = deny; `recipient-allowlist` shipped | actions.ts, consent.ts |
| 15 | Night-shift deferral | Met | actions.ts |
| 16 | Credentials never leave the daemon | Met | registry.ts, drivers/ |
| 17 | Autonomous sync posture-gated | Met | sync-manager.ts |
| 18 | Corpora named in the system prompt | Met — "Connected data" block, absent when no bindings (cache-stable) | chat/instructions.ts |

**Mail now runs on one stack.** `project.mail` is gone: a mailbox is an ordinary
`mail-*` connector binding (identity in the binding config, credential in the SecretStore,
corpus under `data/<corpusName>/<folder>/…` with the address — not an opaque id — as the
`account` frontmatter). The mail routes, `MailManager`, and its outbox were deleted; linking
goes through the generic bind/OAuth routes (with `loginHint`), and `draft_email` /
`queue_email` / `send_email` are wrappers over the connector action surface, with the
recipient allowlist enforced by the consent registry from the binding's
`allowedRecipients` / `allowedDomains` config. Pre-convergence corpora (`mail/`,
`connectors/<slug>/`) and `mail-<provider>` secrets are stranded by design (beta) — users
re-link mailboxes and re-sync.
