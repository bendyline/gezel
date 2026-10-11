# 0022 — Windows scripts run in Microsoft's MXC process container

Status: Accepted (2026-10).

## Context

Gezel runs the Node scripts gezels write (`run_nodejs_script`, `derive_file`,
craftbook node-run gates, project-type and SDK scripts) and two shipped
workers (document conversion, the Spectral connector) through one runner,
`runInSandbox`. macOS wraps every run in Seatbelt; Linux restricts address
families with systemd for scripts without RPC. Windows had no OS boundary at
all. Scripts that need a network boundary failed closed with exit 126, the
MCP surface hid `run_nodejs_script` and `derive_file` unless the policy
already allowed the network, and the shipped workers ran with only Node's
permission model, which Node does not offer as a defence against malicious
code.

Microsoft released MXC (github.com/microsoft/mxc, SDK 1.0.0, 2026-10) for
exactly this workload: untrusted code from models and plugins. Its Windows
backend, `processcontainer`, uses the OS sandbox API (BaseContainer) on
current Windows 11 builds, with per-container filesystem grants and WFP
egress filtering.

## Decision

Wrap every Windows run of `runInSandbox` in an MXC process container when an
executable probe shows one works. Nothing else changes: the permission model,
the JS network neutralizer, the env allowlist and the timeouts all stay.

- **The standalone launcher, not the SDK.** Microsoft's signed `wxc-exec.exe`
  (12 MB, no other files) takes the policy as one `--config-base64` argument
  and passes stdin, stdout and stderr through, so it is a wrapper command
  like `sandbox-exec` and `systemd-run`. The Node SDK would add about 165 MB
  of native dependencies (koffi, node-pty, every platform's binaries) for an
  in-process API we do not need. The launcher is pinned and redistributed
  unmodified, like DuckDB (`core/src/native/mxc-pin.ts`), bundled by the
  Windows installer and downloaded by npm and CLI installs.
- **The policy mirrors the permission model** and adds what it cannot
  enforce: denied egress for denyNet runs, no host loopback or inbound ever,
  no clipboard or input injection. Win32k stays on because node.exe cannot
  start without it. The tier that rewrites host DACLs is refused.
- **Guards before launch.** A grant on a drive or share root cascades to the
  whole volume (measured; MXC's docs say otherwise for write grants), so it
  is refused, as is a grant containing the home folder or `GEZEL_HOME`, or a
  write grant over the launcher or the Node binary. Document conversion's
  read root now stops below the home folder for the same reason.
- **Module resolution through a hook.** The container makes every ancestor
  of a grant unreadable, and Node's realpath walks them, so runs use
  `--preserve-symlinks(-main)`. That alone breaks pnpm's junction layout (a
  package cannot find its own dependencies), and `fs.realpathSync.native` is
  refused too. A preloaded `module.registerHooks` resolver computes real
  paths by following links inside the grants, which restores both resolution
  and Node's one-identity-per-module rule. Workspace installs keep pnpm's
  default layout.
- **RPC over stdio.** The container passes no handle beyond the standard
  three, so a script's RPC moves from fd 3 to stdin and stdout. Init is the
  first stdin line and stdin stays open for replies; frames on stdout carry a
  per-run nonce marker so text a script prints (a fetched page, a user's data)
  can never be read as a call. Both transports cap a frame at 64 MB.
- **On by default, decided by an executable probe.** At boot the service runs
  Node in a container that must write inside its grant, fail to write a
  read-only grant, fail to read a sibling, and have a raw socket refused.
  `wxc-exec --probe` alone is not trusted: it reports a usable tier where
  node.exe then fails to start. The result feeds the tool surface and the
  gezel-mcp child (`GEZEL_SCRIPT_DENY_NET_BOUNDARY`), so nothing probes
  synchronously. Settings → Security & Compliance shows the state and has an
  off switch (`scriptSandbox.windowsContainer`); `GEZEL_MXC=off` overrides.
- **No service-host change.** Under LocalService in Session 0, node.exe fails
  DLL init in a container because that window station grants nothing to app
  containers. Scripts never run there in shipped installs: `GezelService`
  runs only the machine-engine role, and the product daemon runs as the
  signed-in user. The probe reports Session 0 hosts (the `legacy-full`
  fallback, SSH logons) as unavailable, and they keep failing closed.

## Consequences

- On Windows 11 builds with BaseContainer, `run_nodejs_script` and
  `derive_file` appear and run, and denyNet scripts run instead of exiting
  126. Like macOS, Windows scripts now lose network access even when External
  services is on (`workspaceScriptDeniesNetwork`).
- Conversion and Spectral become filesystem-confined on Windows.
- Each run costs about 60 ms more with egress denied and 360 ms more with it
  allowed. Containers are capped at max(8, cores) at once.
- Older Windows, Windows Server images and Session 0 callers behave exactly
  as before. CI's Windows job records the probe and asserts fail-closed where
  it does not pass; the full suite needs an interactive Windows 11 runner.
- Out of scope: `run_package_script`, `run_npx`, `npm_install`, Playwright,
  MCP servers and engines. Linux RPC scripts still fail closed; the stdio RPC
  channel could carry them under systemd in a follow-up.
- When newer builds report `baseContainerSupportsEnumeratePaths`, granting
  ancestors enumerate-only could replace the preserve-symlinks flags and the
  resolve hook.
