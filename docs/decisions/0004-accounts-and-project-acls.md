# 0004 — Accounts and per-project ACLs for shared machines

Status: Proposed (design only; no implementation is scheduled by this record)

## Context

Gezel's authorization model is capability-only. Tokens carry scopes
(`token-store.ts`: `root | openai | product | cli | ui | session |
remote-inference | machine-models`), `requireScope` is a set-membership test,
and there is **no principal beneath the scope**: two holders of the same
scope are interchangeable to every guard. Three consequences follow on a
machine install:

1. **Membership is "whoever can read the runtime directory."** The broker
   publishes its scoped first-party credential at 0644 under
   `GEZEL_SYSTEM_SCOPE` (`service.ts` `writeRuntime`), so every local account
   is an equally-trusted first-party client. This is documented posture
   (security-architecture.md "Hosting scope is not client membership"), not
   an accident — but it cannot express "these two accounts, not that one."
2. **Shared metadata is last-writer-wins.** The machine-shared root
   (grandfathered pre-split data) has per-account private sidecars for
   chats/memories/growth, but shared identity/metadata edits from two
   accounts race with no versioning (service-boundaries.md, intended-shape
   item 5).
3. **The broker credential is not a data-authorization model.** It admits
   compute sharing; it says nothing about which account may read or edit a
   shared project (service-boundaries.md closing constraint).

The product need driving this record: **shared projects** — two accounts on
one machine (later: two devices) collaborating on a project with real
membership, not machine-wide implicit trust.

## Invariants (recorded elsewhere; this design must not violate them)

- Never put the daemon **root credential** on disk; never restore a
  privileged service identity (AGENTS.md; the v1.26217.38 fail-open incident
  in `resolveEffectiveServiceRole` is the cautionary tale).
- The broker never becomes a product daemon; **compute sharing stays
  independent of data sharing**.
- Membership must come from an **installer-managed OS group** or an
  **OS-authenticated local broker** — not from widening file permissions and
  not from the runtime credential.
- Do not reuse the legacy `hosting` config field for storage/authorization
  scope (`GezelConfigSchema` doc comment).

## Decision drivers

- Local-first: identity must work offline, with no cloud account dependency.
- Simplicity: gezel's audience includes non-technical users; "accounts" must
  not surface as an IT admin console.
- The scope vocabulary is good at what it does (capability confinement —
  `remote-inference` vs `/api/*` is enforced at three independent layers);
  the missing axis is *who*, not *what*.

## Identity-source options

**(a) OS accounts via an installer-managed group (recommended first step).**
The installer creates a `gezel-members` OS group; the machine runtime
credential (or a per-member handshake secret) becomes group-readable instead
of world-readable; membership = OS group membership, administered with
normal OS tooling. Pros: no new secret material, survives offline, the OS
already authenticates the human. Cons: per-member *identity* still has to be
asserted per connection (group-readable credential alone proves membership,
not which member), so it pairs with (b) for identity.

**(b) OS-authenticated local broker (recommended end state).** A tiny
authentication endpoint on a UNIX domain socket / Windows named pipe whose
peer credentials (`SO_PEERCRED` / `GetNamedPipeClientProcessId`) identify the
calling account; it exchanges that OS-verified identity for a per-account
token minted by the daemon. Pros: real per-account identity with no typed
secret; the runtime-directory credential can then stop being the membership
mechanism entirely. Cons: one more listener surface; per-platform peer-cred
code; must stay out of the broker process (it authenticates *product*
clients — host it in the user daemon or a dedicated first-party helper, never
by elevating the broker).

**(c) App-level accounts (rejected for now).** Gezel-managed usernames +
passphrases. Violates simplicity (a second identity system on a machine that
already has one), adds credential-recovery surface, and buys nothing the OS
cannot assert locally. Reconsider only when cross-device membership without
shared OS identity becomes the driving need — and even then, device pairing
(Ed25519 TOFU, already shipped for inference) is the more gezel-native
cross-device identity.

## Principal model

Extend `TokenRecord` with an optional `account` principal:

```ts
interface TokenRecord {
  // existing: appId, appName, scopes, kind?, deviceId?, ...
  account?: { id: string; source: 'os' | 'device'; label: string };
}
```

- Scopes remain pure capabilities; `account` is the subject. Absence keeps
  today's semantics (machine-trusted first-party), so rollout is
  compatible: guards that need a principal treat `account === undefined` as
  "legacy machine-wide member."
- `auth` context (`c.var.auth`) carries the principal alongside scopes; no
  route changes semantics until it opts into an ACL check.
- Device-paired clients get `source: 'device'` principals from their
  existing `deviceId` — the remote-inference tenant id and the future
  project-membership subject become the same identity.

## Per-project grants

- A per-project ACL document (owner + members + roles read/write/admin),
  stored with the project's metadata in the shared-project root — never in
  the broker's home.
- Enforcement layers on the existing deny-by-default guard family in
  `http/scope-guard.ts` (`projectScopeGuard` is the precedent): a
  `projectAclGuard` resolves (principal, project) → allow/deny after scope
  checks pass. `storageScope` (`user | machine-shared`, `paths.ts`) is the
  domain switch: `user`-scoped projects never consult ACLs.
- File-level reality must back the ACL: shared project content lives under
  the installer-managed shared root with the OS group from (a); the ACL
  document narrows within the group, the group bounds the blast radius when
  an ACL bug exists. The logged-in user's daemon still performs file
  operations under that user's OS identity (service-boundaries.md item 2).

## Migration from last-writer state

- Grandfathered `machine-shared` entities start with an "everyone on this
  machine" ACL — semantics unchanged on day one.
- Shared metadata writes gain versioned optimistic concurrency (reject on
  stale version → reload) before any UI advertises simultaneous editing;
  this retires the documented last-writer race rather than encoding it.
- Account-local delete keeps refusing shared entities until the deliberate
  machine-wide administration flow exists (today's behavior).

## Rejected alternatives

- Root credential on disk, privileged service identity, broker-hosted
  product/ACL routes — each violates a recorded invariant above.
- Loopback-as-boundary ("same machine = same trust") — explicitly named a
  non-boundary in security-architecture.md invariant 4.
- Per-account gezel *homes* as the sharing mechanism (symlinked stores) —
  bypasses Store atomicity and has no answer for concurrent metadata.

## Regression surface

- Extend the credential-level tests in `service-runtime.test.ts`: a token
  with an `account` principal outside a project's ACL gets 403 on that
  project's routes while same-scope members pass — per account, not per
  scope.
- Cross-account fixtures (two simulated accounts against one shared root)
  are required before enforcement flips from audit to enforce — mirroring
  the `GEZEL_TOKEN_SCOPE` rollout pattern.
- The 0644 runtime-credential posture must be re-tested the day membership
  narrows: group-readable modes replace world-readable under
  `GEZEL_SYSTEM_SCOPE`, and `installer-security` tests pin the group.

## Ordering

Accounts precede first-class remote product access: remote principals are
accounts (see `docs/remote-access.md`), and shipping remote UI/API on the
machine-wide-trust model would freeze that model into the wire contract.
