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
- Graceful stop: shares its hidden session-0 console with the child and
  sends `CTRL_BREAK` (gezeld handles `SIGBREAK`), 3 s grace, then a
  job-object kill of the whole process tree. The child lives in a
  kill-on-close Job Object, so nothing survives the host.

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

## Invariants

- The child spawn must never gain `CREATE_NO_WINDOW` /
  `DETACHED_PROCESS` / `CREATE_NEW_CONSOLE` — a shared console is what
  delivers CTRL_BREAK, and losing it silently turns every stop into a
  hard kill.
- The host never creates `C:\ProgramData\Gezel` (the installer owns its
  hardened ACL); a missing home stops the service with
  `ERROR_PATH_NOT_FOUND`.
- The env contract in `env_overrides` is guarded by `--self-test`; the
  installer no longer carries it.
