# Gezel in a container

The engineering contract for the Gezel image: what is in it, how it runs,
and what the container listener lets through. The decision and its
alternatives are [ADR 0029](decisions/0029-container-hosting-and-accounts.md);
the sign-in side is [accounts.md](accounts.md); the person-facing guide is the
Handboek's [Gezel in Docker](handboek/technical/gezel-in-docker.md).

## Images

| Tag | Platforms | Native keys | Extra packages |
| --- | --- | --- | --- |
| `X.Y.Z`, `X.Y`, `latest` | linux/amd64, linux/arm64 | `linux-<arch>`, `linux-<arch>-cpu` | ffmpeg, git, Chromium's libraries |
| `X.Y.Z-vulkan`, `vulkan` | linux/amd64 | + `linux-x64-vulkan` | + `libvulkan1`, `mesa-vulkan-drivers` |
| `X.Y.Z-cuda`, `cuda` | linux/amd64, linux/arm64 | + `linux-<arch>-cuda` | CUDA EULAs in `/usr/share/doc/gezel/cuda` |

`X.Y.Z` is the `@bendyline/gezel-cli` version at the commit built, so an
image and an npm install of the same version are the same Gezel. The arm64
CUDA build targets GB10 (DGX Spark) only, like the native release it comes
from. The CPU image has no Vulkan engines and no Vulkan drivers. ffmpeg's
dependencies still bring in the Vulkan loader (`libvulkan1`), and the backend
probe settles on the CPU build there (`no bundled vulkan binary, using cpu`).

Registries: `ghcr.io/bendyline/gezel` (primary), mirrored digest for digest
to `docker.io/bendyline/gezel`.

Size, measured on the first local build (linux/amd64, CPU): about 970 MB to
download, 3.6 GB unpacked. The node bundle is most of it (1.5 GB, the ML
runtime above all); the native engines are 180 MB.

## What is baked in, and what downloads

Baked in, verified against this checkout's pins by
`scripts/stage-docker-context.mjs`:

- the node-only bundle (`scripts/build-node-bundle.mjs`): CLI, `gezeld`,
  web UI, ML runtime, node-pty, ripgrep;
- Node (`packages/app/src/node-version.ts`), pnpm
  (`packages/app/src/pnpm-version.ts`), DuckDB
  (`packages/core/src/native/duckdb-pin.ts`);
- the native engines of the pinned release
  (`packages/inference/src/engines/native-manifest.ts`), each archive checked
  against its pinned sha256.

Downloaded at runtime, into the home volume: chat, image and speech models;
Playwright's Chromium (the system bootstrap, as on the desktop); the
embedding and relevance models; the Python environment for video.

## Layout and environment

| Path | What |
| --- | --- |
| `/opt/gezel/{app,node,pnpm,duckdb,native-bin}` | the runtime, read-only |
| `/gezel` | the volume, the `gezel` user's `HOME` and the working directory; `GEZEL_HOME=/gezel/home` inside it, so the home's 0700 never lands on a mount root. A command run here uses the Default project, like the desktop CLI run from a home folder |
| `/projects` | where compose mounts folders to add as projects |

The process runs as uid/gid 10001 under `tini`. The image sets:

| Variable | Value | Why |
| --- | --- | --- |
| `GEZEL_CONTAINER` | `1` | turns on the container listener (below) |
| `GEZEL_CONTAINER_PORT` | `6228` | the published port |
| `GEZEL_PORT` | `16228` | the internal loopback listener: in-container CLI, MCP children, healthcheck |
| `GEZEL_INSECURE_TRANSPORT` | `1` | that loopback is the container's own |
| `GEZEL_SERVICE_ROLE` | `user` | a full product daemon, never the engine broker |
| `GEZEL_NATIVE_BIN_DIR`, `GEZEL_NODE_PATH`, `GEZEL_PNPM_PATH`, `GEZEL_DUCKDB_BIN` | `/opt/gezel/…` | nothing to download at boot |
| `GEZEL_SECRETS_BACKEND` | `file` | no OS keyring in a container |
| `GEZEL_LAN_DISCOVERY`, `GEZEL_DISABLE_MACHINE_SHARED`, `GEZEL_DISABLE_MACHINE_ENGINE` | `0`, `1`, `1` | a container is its own machine |
| `GEZEL_INITIAL_MODE` | `reactive+tasks` | a server's first boot: no proactive work competing with requests (a seed; Settings or `gezel mode` changes it) |

Deployer settings read at boot:

| Variable | Effect |
| --- | --- |
| `GEZEL_INITIAL_SECURITY_LEVEL`, `GEZEL_INITIAL_MODE` | applied once, to a home this boot created (`first-run/boot-seeds.ts`) |
| `GEZEL_OWNER_NAME` + `GEZEL_OWNER_PASSWORD_FILE` | the first account, from a secret file, while none exists |
| `GEZEL_PULL_MODEL` | a catalog id the entrypoint pulls once the service is healthy |
| `GEZEL_SETUP_LINK=0` | no setup link in the logs |
| `GEZEL_PUBLIC_URL` | the address printed in the setup link |
| `GEZEL_ALLOWED_HOSTS` | hostnames the container listener answers (a TLS proxy in front) |
| `GEZEL_LAN=plain-http` | answer LAN IP addresses over plain HTTP |
| `GEZEL_TRUST_PROXY=1` | count sign-in failures by `X-Forwarded-For` |

## The entrypoint

`docker/entrypoint.sh`: no argument or `serve` execs `gezeld`; `health` is
the HEALTHCHECK; `sh`, `bash`, `node` and absolute paths run as themselves;
anything else runs `gezel <args>`. `gezeld` runs directly, not under
`gezel start --foreground`, which would pipe stdin and stop on its EOF.

## The container listener

`http/container-listener.ts`. Enabled when `GEZEL_CONTAINER=1` and the
process is in a container (`/.dockerenv`, `/run/.containerenv`, or a
container cgroup); `GEZEL_CONTAINER_FORCE=1` overrides the detection. It
binds `0.0.0.0:6228` with a second app from `buildApp(…, { listener:
'container' })`:

- **Host policy.** Loopback names always; an IP literal only with
  `GEZEL_LAN=plain-http`; a hostname only when listed in
  `GEZEL_ALLOWED_HOSTS`. Everything else is `forbidden_host`.
- **Credentials.** Account sessions and approved app grants only. The
  owner runtime credential (`desktop-client`), the web-UI token, root,
  session, harness and paired-device tokens are refused here
  (`admittedOnContainerListener`), and still work on loopback.
- **Routes left out** (404): local-connect, harness-connect, the Office
  host and its enrollment, device pairing and paired-device inference,
  `/v1/identity`, the pairing code, machine serving, and every
  integration-setup route (`CONTAINER_DENIED_PREFIXES`).
- **Health** answers liveness and `apiCompat`, never pid or host.
- **Grants** registered through it are always verified by code, never
  auto-approved, budgeted separately (`MAX_PENDING_NETWORK_GRANTS`), and
  labeled "from the network" in Integrations.
- **Ollama emulation** is never mounted.

The listener speaks plain HTTP. The default publish (`127.0.0.1:6228`)
keeps it on the Docker host. Anything wider goes through a TLS proxy
(`docker/compose.lan.yaml`, Caddy) or the explicit `GEZEL_LAN=plain-http`.

## One home, one daemon

The single-instance lock (`packages/inference/src/runtime-lock.ts`) records
pid, process start time, boot id, pid namespace, hostname and an instance
id, and its mtime is a heartbeat every 10 s. A holder in another pid
namespace (another container) is alive while the heartbeat moves; a second
container on the same volume refuses to start with a pointer to `docker
exec`. A killed container's lock goes stale after 40 s and is reclaimed.

## Scripts with no network

Containers have no `systemd-run --user`, so `denyNet` scripts run under
`gezel-sandbox --deny-net` (`native/helpers/sandbox`): a small helper that
installs a seccomp filter allowing only `AF_UNIX` sockets, then execs. The
runner checks that `--features` lists `deny-net`, then probes it with a
real `AF_INET` connect, exactly as it probes systemd, and prefers systemd
where both work. It ships in the native release from 0.1.57; without it,
`denyNet` scripts in a container fail closed. The helper does not confine
files yet: that is the Node permission model's job, and Landlock is its
planned next rule.

## Sizing

Memory reads `process.constrainedMemory()` and thread counts read the
cgroup `cpu.max` quota (`packages/inference/src/system/host-memory.ts`), so
a container started with `--memory`/`--cpus` picks models and threads for
its limit, not the host's.

## Building and releasing

- Locally, on Linux: `pnpm build`, `pnpm docker:stage --flavor cpu`, then
  the `docker build` command it prints. `pnpm docker:smoke <image>` runs
  `docker/smoke.mjs`.
- CI: `.github/workflows/release-docker.yml`, called by `publish-npm.yml`
  when a run released the CLI, or dispatched by hand (push off by
  default). Native runners per architecture, push by digest, smoke by
  digest, then versioned tags with provenance and SBOM attestations, then
  the floating tags and the Docker Hub mirror.
- Verify a published image: `gh attestation verify
  oci://ghcr.io/bendyline/gezel:X.Y.Z --owner bendyline`.

## Compose

`docker/compose.yaml` runs the CPU image on this computer; overlay
`compose.nvidia.yaml`, `compose.amd.yaml` or `compose.lan.yaml` (Caddy with
`tls internal`, `GEZEL_ALLOWED_HOSTS`, `GEZEL_TRUST_PROXY`) as needed.

## Known limits

- Every account can do everything, including open a terminal: a shell in
  the container. Never mount `docker.sock`.
- Plain HTTP is HTTP/1.1, so many open tabs share Chromium's six
  connections; the TLS proxy gives HTTP/2.
- Docker on macOS has no GPU; Docker Desktop on Windows passes NVIDIA
  through WSL2 and has no Vulkan.
- Files written into a bind mount belong to uid 10001; run with `--user
  "$(id -u):$(id -g)"` to keep your own.
