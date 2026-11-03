# docker/

The Gezel container image. The contract is [docs/container.md](../docs/container.md);
the guide people read is the Handboek's
[Gezel in Docker](../docs/handboek/technical/gezel-in-docker.md).

| File | |
| --- | --- |
| `Dockerfile` | builds from a context staged by `scripts/stage-docker-context.mjs`; only copies, plus apt |
| `entrypoint.sh` | `serve` (default), `health`, or any `gezel` command |
| `compose.yaml` | the CPU image on this computer |
| `compose.nvidia.yaml`, `compose.amd.yaml` | GPU overlays |
| `compose.lan.yaml`, `Caddyfile` | HTTPS on your network |
| `smoke.mjs` | runs an image the way people use it, and cleans up |

Build one locally, on Linux:

```sh
pnpm build
pnpm docker:stage --flavor cpu        # or vulkan, cuda
docker build --build-arg FLAVOR=cpu -t gezel:cpu release/docker-context/linux-x64-cpu
pnpm docker:smoke gezel:cpu
```

Releases are built by `.github/workflows/release-docker.yml`.
