# Secrets storage — current design, threat model, and the Secure Enclave roadmap

This document captures how gezel stores secrets today (API tokens, OAuth
refresh tokens, webhook keys, toolset credentials), why the design is what
it is, what threats it actually defends against, and the planned upgrade
path to Secure Enclave-wrapped keys on macOS. It complements
[CLAUDE.md](../CLAUDE.md), which describes the broader runtime architecture.

Audience: future-us when deciding whether to invest in #2 below, plus
anyone touching [packages/service/src/secrets/](../packages/service/src/secrets/).

## Where secrets live today

The `SecretStore` abstraction ([types.ts](../packages/service/src/secrets/types.ts))
has two backends; [openSecretStore](../packages/service/src/secrets/index.ts)
picks one per process at boot.

| Backend | Storage | Selected when |
|---|---|---|
| `KeyringSecretStore` | OS keychain (macOS Keychain / Windows Credential Manager / Linux Secret Service) | Keychain probe succeeds — typically dev, embedded mode, or a user-context daemon |
| `FileSecretStore` | `~/.gezel/secrets.enc` (encrypted) + `~/.gezel/secrets.key` (32-byte key, 0600) | Keychain probe fails, or `GEZEL_SECRETS_BACKEND=file`, or under VITEST / mock provider |

The probe is a set/get/delete round-trip against a sentinel keychain
entry. It fails (and we fall through to the file backend) in exactly the
situations where the keychain is unreachable — most importantly, when
the process is running as a non-login system user.

## Effective backend per deployment mode

| Mode | OS user | Effective backend |
|---|---|---|
| **macOS production** (LaunchDaemon, [com.bendyline.gezeld.plist](../packages/app/installer/com.bendyline.gezeld.plist)) | `_gezeld` (no login session, `NFSHomeDirectory=/var/empty`) | **File** — `_gezeld` has no accessible keychain → probe fails |
| **Windows production** (NSSM machine service) | restricted `LocalService` | **File** — the non-login service identity has no user Credential Manager session |
| **Linux production** (systemd unit) | dedicated system user | **File** — no D-Bus user session → Secret Service unreachable |
| **macOS embedded mode** (`GEZEL_EMBEDDED=1`, supervisor fallback) | logged-in user | **Keychain** — login.keychain |
| **macOS local-spawn fallback** (mode 4) | logged-in user (Electron's child) | **Keychain** — login.keychain |
| **Dev (`pnpm dev` / `pnpm app`)** | logged-in user | **Keychain** (unless `GEZEL_SECRETS_BACKEND=file`) |

Machine-service production modes use the encrypted file store. Per-user
spawn, embedded mode, and development can use the OS keychain.

Machine-service installers keep the data root private to the dedicated
service/admin identity and expose only `runtime/` discovery metadata to local
desktop clients. `secrets.enc` and `secrets.key` are never part of that shared
runtime subtree.

This split is deliberate: Windows services, LaunchDaemons, and Linux systemd
services run as non-login identities by design — for boot-time
start, surviving logout, and not depending on a GUI session. The
trade-off is that they can't reach the user's keychain. Most macOS
system daemons make the same trade-off (Postgres, Tailscaled, Apple's
own `*d` daemons in `/Library/LaunchDaemons/`); keychain-using
background processes (1Password helper, GitHub Desktop, the Apple
`ssh-agent`) are LaunchAgents in the user's session, not LaunchDaemons.

## What the file backend actually does

[FileSecretStore](../packages/service/src/secrets/file-store.ts) implementation:

- AES-256-GCM authenticated encryption, fresh 12-byte nonce per entry.
- Each entry encrypted independently — changing one secret doesn't
  rotate the others, and concurrent writes to different keys don't
  tear the file.
- 256-bit key from `crypto.randomBytes(32)`, written on first use.
- Both `secrets.enc` (ciphertext) and `secrets.key` (master key) are
  `chmod 0600` and owned by the daemon user.
- Atomic writes via `writeFileAtomic` — no torn file on crash.
- Auth tag prevents tampering.

This is solidly mid-tier credential storage: stronger than plaintext
config files (which is what many comparable daemons actually do), but
weaker than a hardware-backed keychain because the master key is on
disk.

## Threat model — who can read secrets today

Concretely, for the macOS production deployment
(`secrets.enc` + `secrets.key` in `/Library/Application Support/Gezel/`,
owned by `_gezeld`):

| Adversary | Can read secrets? | Notes |
|---|---|---|
| Remote attacker via our HTTP API | No (gated on loopback + bearer token + TLS) | Even API access is loopback-only |
| Malware running as an unapproved logged-in user (`otheruser`) | Not by filesystem ACL; current shared-client mode still grants API authority | Different uid cannot read the 0600 files directly. Today, however, any local account that can read the shared runtime client credential is a trusted first-party API client and may be able to *use* stored credentials through daemon capabilities. Approved-member isolation still needs an installer group/broker; see `security-architecture.md` §14. |
| User with admin / sudo on this Mac | Yes | They can also extract the login keychain with the approved user's password — admin = game over either way |
| Backup snapshot (Time Machine, etc.) | Yes if backup is unencrypted | FileVault + encrypted Time Machine backups mitigate this |
| Stolen powered-off Mac, disk pulled | Yes if FileVault is off | FileVault on → disk encrypted at rest → useless without password |
| Target Disk Mode / Recovery boot of running Mac | Yes if FileVault is off | Same as above |
| Booted-from-USB to read the SSD | Yes if FileVault is off | Same as above |
| Apple itself / nation-state with Apple's keys | Yes | Out of our threat model |

**The high-impact takeaway**: FileVault carries most of the load
against offline attacks. On a FileVault-on Mac, our file store is
already protected against disk theft. The realistic gap today is the
FileVault-off minority (~5–10% by various surveys, lower among
technical users) plus the "attacker briefly had root then walked away"
scenario.

## Where the keychain would do better

On a system that *can* use the keychain (embedded mode, dev, or a
user-agent design), the OS adds:

- **Hardware-backed master key.** On Apple Silicon, the keychain DB
  itself is wrapped by an Enclave-derived key. `cat
  login.keychain-db` doesn't decrypt — you need the live Mac.
- **Per-app ACLs.** A keychain item created by signed
  `com.bendyline.gezel` lists that signing identity on its ACL; other
  apps are denied or prompted. The file backend has no equivalent —
  anything running as `_gezeld` (or root) reads everything.
- **Key rotation on user password change.** macOS re-wraps the
  keychain master key when the user changes login password. Our key
  never rotates.
- **iCloud sync** (for items in the iCloud keychain). We don't use
  this and wouldn't want to for secrets at this trust level, but it's
  a capability the keychain offers.

We forfeit all of these in production-LaunchDaemon mode. That's the
cost of choosing system-daemon hygiene over user-context features.

## Roadmap — Approach (A): Secure Enclave-wrapped master key

The proposed upgrade: keep `secrets.enc` exactly as it is today, but
stop storing the AES master key as plaintext bytes. Instead, generate
a key inside the Secure Enclave that wraps the AES key, persist only
the wrapped blob to disk. Decryption then requires the live Mac's
specific Secure Enclave to unwrap — disk theft / backup theft alone
becomes useless.

### Mechanism

1. **One-time setup, first boot after upgrade**:
   - Call `SecKeyCreateRandomKey({ kSecAttrTokenID: kSecAttrTokenIDSecureEnclave, kSecAttrAccessControl: ... })`.
     Returns a `SecKeyRef` for a P-256 EC key whose material never
     leaves the chip.
   - Persist the SE key handle via `SecItemAdd` into the **system
     keychain** (`/Library/Keychains/System.keychain`) with a custom
     `kSecAttrAccessGroup` and `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.
     `_gezeld` needs read access; we'd configure that on the
     keychain item.
   - Use the SE key's public half to ECIES-wrap our 32-byte AES key.
     Write the wrapped blob to `secrets.key.enc`.
   - Delete the plaintext `secrets.key`.

2. **Each daemon boot**:
   - Read `secrets.key.enc` from disk.
   - Look up the SE key handle by access group via `SecItemCopyMatching`.
   - Ask the SE to unwrap the blob → AES key in process memory.
   - Existing `FileSecretStore` decrypt path works unchanged from here.

3. **Migration from existing installs**:
   - On first run of an SE-capable build: if `secrets.key` exists and
     `secrets.key.enc` doesn't, generate SE key, wrap the existing
     AES key, write `.enc`, only then `unlink` the plaintext.
   - Migration is one-way for now — once on SE, you can't go back
     without re-entering all credentials. (Acceptable given the
     security improvement.)

### What it costs to build

| Item | Effort | Notes |
|---|---|---|
| Native module (Swift or Objective-C) wrapping `Security.framework` | ~300–500 LoC | Nothing on npm wraps SE access cleanly; `@napi-rs/keyring` is generic keychain, not SE |
| node-api bindings + prebuilds for arm64 | Moderate | Need prebuildify pipeline; sign the `.node` dylib so it loads under hardened runtime |
| Code signing prerequisites | Hard dependency | SE access requires Developer ID Application cert, `keychain-access-groups` entitlement. Ad-hoc-signed builds will fail. This is forced by Apple — and is also a prerequisite for shipping anything notarized, so it's not new work specifically for SE. |
| System-keychain access group for `_gezeld` | Verification work | Need to confirm on real hardware that a LaunchDaemon-as-`_gezeld` can read an item from the system keychain with the right access group. Likely yes, but "test it, don't assume it." |
| Migration path | ~50 LoC | Wrap existing plaintext key; delete only after wrapped version is durable |
| Fallback for non-Apple-Silicon | Forced by build matrix | We're already arm64-only on macOS — no fallback needed. If we ever re-add x64 / pre-T2 Intel, those would stay on the plain file backend. |
| Real-hardware test gate | Process work | Can't fully test in CI on Linux runners; need a macOS-on-real-hardware lane (GitHub's Apple Silicon runners are likely OK but SE behavior in virtualized runners is murky enough to require a manual sanity check before each release) |
| Hardware tie-in handling | Documented limitation | SE-wrapped keys are permanently bound to that chip. Logic board swap / Time Machine restore to a new Mac → key unrecoverable. We accept the "re-enter API keys on a new Mac" UX rather than building an export flow. |

**End-to-end estimate: 1–2 weeks of focused work**, conditional on
Developer ID signing already being in place.

### Threat model improvement

| Scenario | Today (file) | With SE wrapping |
|---|---|---|
| Stolen powered-off Mac, disk pulled, FileVault on | Useless | Useless |
| Stolen powered-off Mac, disk pulled, FileVault off | Decryptable | **Useless** |
| Time Machine backup, encrypted | Useless without password | **Useless even with password — needs the original Mac's chip** |
| Target Disk Mode / Recovery, FileVault off | Decryptable | **Useless** |
| Attacker has root on running Mac | Decryptable (can read files) | Still decryptable (can ask the running daemon to unwrap) |
| Remote attacker via HTTP API | No (loopback + token) | Same |
| Malware as user (not root) | No direct file read; shared-client API authority remains | Same |

The rows where SE buys us something are the **FileVault-off** rows
plus the **encrypted backup theft** case (where SE adds protection
even FileVault doesn't, because the backup is by definition portable
across machines).

For the FileVault-on majority, the improvement is real but narrow:
encrypted backups become useless to a thief, and the "logic board
swap" recovery vector closes.

### Why we're not doing it today

- Forced precondition: proper Developer ID signing must land first.
  We can't even *try* SE access on an ad-hoc-signed binary.
- The benefit overlaps heavily with FileVault, which the user-base
  largely already has on. We're moving from "good" to "very good,"
  not from "broken" to "fixed."
- The native-module + signed-dylib + prebuilds + real-hardware test
  pipeline is real work that adds maintenance surface.
- There's nothing the current design is letting through that
  represents an active security incident risk.

### When to do it

After Developer ID signing is in place and the release pipeline is
producing properly signed + notarized builds. At that point, SE
wrapping becomes a contained native-module project rather than a
multi-front effort, and we ship it as a quiet 0.x.0 improvement.

## Alternatives we considered and rejected

### "Device-bound" key derivation without SE

Derive the on-disk key from `IOPlatformUUID` (the Mac's hardware UUID)
plus a per-install nonce plus PBKDF2. Stolen disk → attacker has the
ciphertext but, unless they also know the source machine's UUID,
can't derive the key.

**Rejected** because it's a clever-but-not-actually-secure pattern.
`ioreg -d2 -c IOPlatformExpertDevice` from the running Mac dumps the
UUID; any attacker who got the disk almost certainly had access to
get the UUID at the same time (it's a 30-second extra step). It
adds the *appearance* of hardware binding without the substance, and
it would lock us out of the option to do real SE later if users came
to depend on the false sense of security. Either do real SE or stay
honest about the file backend's threat model.

### Switch to a per-user LaunchAgent

Move the whole daemon from LaunchDaemon (system, non-login) to
LaunchAgent (user, login session). Inherits the user's keychain
access for free; the keychain becomes the production backend.

**Rejected** as the default because it loses:
- Boot-time start (only runs after user login)
- Survive-logout / fast-user-switching
- Multi-user multi-tenancy (each user would have an independent
  service instance)
- Scheduled job semantics (jobs die with the user session)

It's still available as the *embedded* path today for users who
want this trade-off (see [com.bendyline.gezel.plist](../packages/app/installer/com.bendyline.gezeld.plist)
for the LaunchDaemon design; embedded mode in the supervisor
covers the user-context case). Not the default but a supported
operational shape.

### Split-architecture: LaunchDaemon + per-user secrets helper

Run gezeld as a LaunchDaemon for the HTTP / always-on serving, but
spawn a per-user LaunchAgent helper that owns secrets and exposes
them to the daemon over a local socket. Helper has keychain access;
daemon calls the helper.

**Rejected for now** because it's the most complex option (two new
processes, IPC contract, lifecycle coordination, two installers) for
a benefit (per-app keychain ACLs across other apps on the machine)
that isn't a top-tier threat for us. Worth reconsidering if we ever
need to share secrets cross-process with non-gezel tooling, which
we don't currently.

## What to do when revisiting this

Order of operations if and when we pick this up:

1. Verify Developer ID Application + Installer certs are wired into
   the release pipeline; remove the ad-hoc-signing fallback in
   electron-builder config.
2. Stand up a real-hardware macOS test lane (a single Apple Silicon
   runner is enough) so SE behavior can be verified pre-release.
3. Prototype the native module on a side branch. Goal: a Node
   module that exposes `generateSEKey()`, `wrap(aesKey)`,
   `unwrap(blob)`. Validate it on the real-hardware lane with the
   daemon-as-`_gezeld` access path.
4. Wire it into [FileSecretStore.ensureKey](../packages/service/src/secrets/file-store.ts)
   behind a feature flag. Migration code reads existing plaintext
   key, wraps it, writes `.enc`, deletes plaintext only after the
   wrapped version verifies.
5. Ship behind the flag for an internal release cycle; flip default
   on once telemetry / manual smoke is clean.
6. Update this document with what we actually shipped.
