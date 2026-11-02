#!/bin/sh
# Gezel container entrypoint (docs/container.md). The image is the CLI:
#
#   docker run … ghcr.io/bendyline/gezel              run the service (same as `serve`)
#   docker run … ghcr.io/bendyline/gezel do <book>    any `gezel` command
#   docker exec <container> gezel account create Ana  commands against a running one
#
# `health` answers the image's HEALTHCHECK. `sh`, `bash`, `node` and absolute
# paths run as themselves, so a shell is still one `docker run -it … sh` away.
set -eu

GEZELD=/opt/gezel/app/node_modules/@bendyline/gezel-service/dist/bin/gezeld.js

health() {
  node -e '
    const port = process.env.GEZEL_PORT || "16228";
    fetch(`http://127.0.0.1:${port}/api/health`)
      .then((res) => process.exit(res.ok ? 0 : 1), () => process.exit(1));
  '
}

wait_healthy() {
  tries=0
  while [ "$tries" -lt 180 ]; do
    if health; then return 0; fi
    tries=$((tries + 1))
    sleep 1
  done
  return 1
}

# GEZEL_PULL_MODEL=<catalog id>: download that model once the service is up,
# so a compute node is ready without anyone running `gezel model pull`.
pull_model_when_ready() {
  if [ -z "${GEZEL_PULL_MODEL:-}" ]; then return 0; fi
  (
    if wait_healthy; then
      gezel model pull "$GEZEL_PULL_MODEL" ||
        echo "[entrypoint] could not pull $GEZEL_PULL_MODEL; see 'gezel model list --available'" >&2
    fi
  ) &
}

case "${1:-serve}" in
  serve)
    pull_model_when_ready
    exec node "$GEZELD"
    ;;
  health)
    health
    ;;
  sh | bash | node | /*)
    exec "$@"
    ;;
  *)
    exec gezel "$@"
    ;;
esac
