# Service host helper

`gezel-service-host` is the first-party Windows service host for gezeld.
It is the ImagePath of the `GezelService` machine service (registered by
the NSIS installer, running as restricted LocalService) and replaces the
vendored NSSM wrapper. Windows-only; the pure logic compiles everywhere
so `--self-test` runs cross-platform during development.

## Why it exists

NSSM is a general-purpose "run anything as a service" tool — even signed
and renamed, a Bendyline-signed copy would be a dual-use persistence
gadget (a classic signed LOLBin). This host's launch contract is
**compiled in**: it can only spawn its sibling `Gezel.exe` running
`C:\ProgramData\Gezel\service\dist\bin\gezeld.js`, with a fixed derived
environment. No flag, subcommand, or config channel makes it run
anything else, and service registration stays in the installer (sc.exe),
so the binary cannot even register services.

## What it does

- Spawns gezeld with the service environment (the former NSSM
  `AppEnvironmentExtra` contract — see `env_overrides` in
  [src/main.cpp](src/main.cpp)), CWD = `C:\ProgramData\Gezel`.
- Redirects child stdout/stderr to `logs\service-{stdout,stderr}.log`
  with 10 MB spawn-time rotation (keep 5).
- Restarts gezeld on crash: 3 restarts per 60 s sliding window, no
  backoff (parity with the Electron supervisor). On budget exhaustion
  the service stops with a service-specific error visible in
  services.msc.
- Graceful stop: the child's stdin is an anonymous pipe whose write end
  the host holds; closing it delivers EOF, which gezeld handles as a
  shutdown request (`GEZEL_SHUTDOWN_ON_STDIN_EOF=1` opts it in). 10 s
  grace, then a job-object kill of the whole process tree. The child
  lives in a kill-on-close Job Object, so nothing survives the host.

## CLI

```text
gezel-service-host run          # SCM service entry; fails outside the SCM
gezel-service-host --self-test  # pure-logic tests (path/env/rotation/budget)
gezel-service-host --help
```

## Build

Windows: `pwsh -File build.ps1` — imports the latest installed Visual Studio
x64 developer environment, configures with Ninja, runs the ctest self-test,
and stages `native/build/win32-x64/gezel-service-host.exe`. Install Visual
Studio Build Tools with the **Desktop development with C++** workload and the
**C++ CMake tools for Windows** component.
Elsewhere (self-test only): `cmake -S . -B .build -DBUILD_TESTING=ON &&
cmake --build .build && ctest --test-dir .build`.

### Version stamp

The Windows build compiles [src/version.rc.in](src/version.rc.in) into a
`VERSIONINFO` resource, so services.msc, Task Manager, Process Explorer, and
EDR consoles show a publisher and description instead of blank fields — this
binary runs continuously as LocalService, and an unlabelled always-on service
process invites exactly the scrutiny the Authenticode signature is there to
answer. The strings deliberately match what electron-builder stamps into
`gezel.exe`, so the two binaries sitting together in `$INSTDIR` agree.

`build.ps1` resolves the version in this order:

1. `GEZEL_SERVICE_HOST_VERSION` (must be `X.Y.Z`) — explicit override;
2. `GITHUB_REF_NAME` when it is `native-vX.Y.Z` — the release tag the native
   pipeline is building, so the stamp cannot drift from the tag and no extra
   workflow wiring is needed;
3. `0.0.0` — manual dispatch runs and local builds, which are not part of any
   release and should not claim to be.

## Invariants

- The child's stdin must stay a host-held pipe. It is the only
  graceful-stop channel that works in the shipping configuration, and
  pointing stdin at `NUL` again would silently turn every stop into a
  hard kill. The host must also close its write end on every path that
  drops a child (stop *and* crash-respawn), or EOF never arrives.
- `AllocConsole` fails on every start in the shipping configuration
  (observed in v1.26210.15) with error **317** (`ERROR_MR_MID_NOT_FOUND`),
  reproduced twice against a real service install. It is deliberately
  logged rather than treated as fatal. Note it is *not* `ACCESS_DENIED`,
  so the service SID type is not the cause — the console subsystem simply
  is not available to a Session 0 service in a non-interactive window
  station. Relaxing the SID type would not bring the console back, and
  the missing console has never been worth fixing: CTRL_BREAK is only a
  best-effort secondary to the stdin channel.
- The service SID is assigned `unrestricted`, and that is a correctness
  requirement, not a weakened control. `restricted` write-restricts the
  token, and libuv creates a named pipe per piped stdio handle before
  every `CreateProcess` — a write the restricted SID list denies. Under
  `restricted` the daemon could spawn nothing at all (engines, GPU
  probes, the stdio MCP server, sandboxed scripts, pnpm, git), every one
  surfacing as `spawn EPERM`; v1.26215.31 shipped that way. This host's
  own `CreateProcessW` of gezeld kept working throughout, because it
  redirects the child to log-file handles rather than pipes — which is
  exactly why the daemon looked healthy while being unable to do any
  work. See the comment above `sc sidtype` in
  `packages/app/installer/nsis-hooks.nsh`.
- The host never creates `C:\ProgramData\Gezel` (the installer owns its
  hardened ACL); a missing home stops the service with
  `ERROR_PATH_NOT_FOUND`.
- The env contract in `env_overrides` is guarded by `--self-test`; the
  installer no longer carries it.
- The machine service binds exactly to port `6228`. User-owned CLI fallback
  daemons use discoverable ephemeral ports so they cannot block it.
