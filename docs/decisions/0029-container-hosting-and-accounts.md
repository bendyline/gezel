# 0029 — Container hosting: a container listener, and accounts for network sign-in

Status: Accepted (2026-11). Amends [0004](0004-accounts-and-project-acls.md) option (c).
Contracts: [container.md](../container.md), [accounts.md](../accounts.md).

## Context

Gezel ships as a desktop app and as `@bendyline/gezel-cli` on npm. Neither is
a sealed unit someone can drop on a server, a GPU box or a CI runner, and
both make local AI depend on the host's C library, Node and drivers. A Docker
image fixes that, and it should be one command:

```sh
docker run -d --name gezel -p 127.0.0.1:6228:6228 -v gezel:/gezel ghcr.io/bendyline/gezel
```

Five things stood in the way:

1. **The daemon could not be reached.** The main listener binds `127.0.0.1`
   (`http/loopback-listener.ts`). Docker forwards a published port to the
   container's interface, never its loopback.
2. **Nobody could sign in.** The only browser credential is the one-time
   `?token=` URL of `gezel start --web`, which dies at every restart, and
   `docs/remote-access.md` defers durable remote credentials to accounts
   (ADR 0004).
3. **Two daemons could share a home.** The single-instance lock held only a
   pid. Containers have separate pid namespaces, so a one-shot
   `docker run --rm … do` on the serving container's volume saw the holder as
   dead and took the lock.
4. **Scripts that must not reach the network could not run.** The Linux
   boundary is `systemd-run --user`, which containers do not have, so those
   runs fail closed with exit 126.
5. **Sizing ignored the container's limits.** `os.totalmem()` reports the
   host, so the first-run model pick could exceed a `--memory` limit and get
   the container killed.

## Decision

1. **A container listener, never a widened loopback app.** With
   `GEZEL_CONTAINER=1` and a container detected, the daemon builds a second
   app (`buildApp` with a host policy and a route denylist) and binds it on
   `0.0.0.0:6228`. The main listener stays on loopback for the in-container
   CLI, MCP children and the healthcheck. The container's network namespace
   and Docker's publish (`127.0.0.1:` by default) bound who can connect. The
   listener requires a signed-in account or an app token, never the owner
   runtime credential, and it does not mount the routes that trust a local
   caller (`local-connect`, `harness-connect`, the Office host, paired-device
   inference, integration setup).
2. **Accounts for network sign-in.** ADR 0004 rejected Gezel-managed
   accounts while the operating system could say who is calling. A browser
   reaching a container, or any other device on a network, carries no OS
   identity, which is the condition 0004 named for reconsidering. So:
   - Accounts are `{ id, name, role, passwordHash, … }` in
     `<home>/accounts.json`, and sessions are hashed tokens in
     `<home>/account-sessions.json`. Neither lives in `tokens.json`, whose
     loader refuses unknown kinds and durable `ui` grants and would stop an
     older image from starting.
   - A session resolves to the `ui` scope plus 0004's principal,
     `account: { id, source: 'password', label }`. `source: 'device'` stays
     reserved for paired devices.
   - Every account is an `admin` for now. `role` is stored from day one, a
     role this build does not know cannot sign in, and account management
     goes through one guard, so `member` and per-project ACLs attach later
     without reshaping anything.
   - Accounts are required on every network-facing surface: the container
     listener now, first-class remote access later, and `gezel start --web`
     when asked. The desktop app and the same-machine CLI keep the owner
     credential; `gezel app serve` visitors stay a separate model.
   - The first account comes from a single-use setup link in the logs, a
     Docker secret, or `gezel account create` in the container's shell.
     Recovery is the shell.
3. **Lock identity.** The lock records pid, process start time, boot id,
   hostname and a heartbeat. A fresh lock from another host refuses to start
   with a pointer to `docker exec`; a stale heartbeat is reclaimed.
4. **A second Linux network boundary.** `gezel-sandbox`, a small native
   helper, starts a script under rules it cannot lift. Its `--deny-net` rule
   installs a seccomp filter that allows only `AF_UNIX` sockets (the same
   property `RestrictAddressFamilies=AF_UNIX` gives systemd), then execs the
   script. Each rule is a flag, an unknown flag is refused rather than
   ignored, and `--features` lists the rules a build has, so later rules
   (Landlock, resource limits) join without changing what existing callers
   get. The runner reads `--features`, then probes `--deny-net` the way it
   probes `systemd-run`.
5. **cgroup-aware sizing.** Memory reads `process.constrainedMemory()`;
   thread counts respect `cpu.max`.

## Alternatives considered

- **Bind the main listener to `0.0.0.0` in a container.** One flag would
  have made every loopback-trusting route reachable from the network.
  0004 and `remote-access.md` both say a remote surface mounts what it
  serves deliberately.
- **A TCP forwarder in the image** (socat to `127.0.0.1`). It needs no
  daemon change, but it hides the network caller from the daemon, so nothing
  could require sign-in or refuse the local-trust routes.
- **A deployer-set passcode instead of accounts.** Smaller, but there is no
  per-person sign-out, reset or attribution, and the store would be reshaped
  when accounts arrive.
- **Accounts with an owner/member split now.** Every first-party route would
  need a role guard; deferred, not foreclosed.
- **HttpOnly cookie sessions.** Better against script theft, but the UI
  sends bearer tokens everywhere today; a later hardening step.

## Regression surface

- The container listener's route table: every denied route answers 404
  there and still works on loopback; the owner runtime credential is refused
  there.
- Accounts: an unknown role cannot sign in; the last admin cannot be
  removed; a password change ends the account's other sessions; the setup
  code works once and only while no account exists.
- An older token-store loader ignores the account files.
- The lock: a fresh lock from another hostname refuses; a stale one is
  reclaimed; the same pid in a new container reclaims its own.
- The gezel-sandbox probe: an `AF_INET` socket fails and an `AF_UNIX` one
  works; a run with no rule, or a rule the build lacks, is refused.
