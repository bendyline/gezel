# syntax=docker/dockerfile:1.7
#
# The Gezel container image (ADR 0029, docs/container.md). Built from a
# context staged by scripts/stage-docker-context.mjs, where every input was
# checked against the pins in this checkout. Apart from apt, this file only
# copies.
#
#   docker build --build-arg FLAVOR=cpu -t gezel release/docker-context/linux-x64-cpu
#
# The release workflow passes BASE_IMAGE pinned by digest and records it.

ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}

# cpu | vulkan | cuda — decides the GPU userspace installed below; the
# matching engines are already in the staged native-bin/.
ARG FLAVOR=cpu
# 1 installs the libraries Chromium needs, for browser tools and document
# previews. The browser itself downloads into the home on first use.
ARG WITH_BROWSER_LIBS=1
ARG GEZEL_VERSION=0.0.0
ARG NATIVE_RELEASE=unknown
ARG VCS_REF=unknown

LABEL org.opencontainers.image.title="Gezel" \
      org.opencontainers.image.description="Your crew of local AI helpers: the workshop in a browser, OpenAI-compatible local models for your other apps, and craftbooks you can run on a folder." \
      org.opencontainers.image.source="https://github.com/bendyline/gezel" \
      org.opencontainers.image.url="https://gezelgilde.com/platform/" \
      org.opencontainers.image.documentation="https://gezelgilde.com/docs/gezel-in-docker/" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="Bendyline" \
      org.opencontainers.image.version="${GEZEL_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      io.gezel.flavor="${FLAVOR}" \
      io.gezel.native-release="${NATIVE_RELEASE}"

ENV DEBIAN_FRONTEND=noninteractive
RUN set -eux; \
    packages="ca-certificates tini ffmpeg git procps"; \
    if [ "$FLAVOR" = vulkan ]; then packages="$packages libvulkan1 mesa-vulkan-drivers"; fi; \
    if [ "$WITH_BROWSER_LIBS" = 1 ]; then \
      packages="$packages fonts-liberation libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 \
        libatspi2.0-0t64 libcairo2 libcups2t64 libdbus-1-3 libdrm2 libgbm1 libglib2.0-0t64 \
        libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 libxcomposite1 libxdamage1 libxext6 \
        libxfixes3 libxkbcommon0 libxrandr2"; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends $packages; \
    rm -rf /var/lib/apt/lists/*

# A fixed, unprivileged uid well clear of the system range and of the
# desktop installer's `gezel` service account.
RUN set -eux; \
    groupadd --gid 10001 gezel; \
    useradd --uid 10001 --gid gezel --home-dir /gezel --no-create-home --shell /usr/sbin/nologin gezel; \
    mkdir -p /gezel /work; \
    chown gezel:gezel /gezel /work

COPY node/ /opt/gezel/node/
COPY pnpm/ /opt/gezel/pnpm/
COPY duckdb/ /opt/gezel/duckdb/
COPY native-bin/ /opt/gezel/native-bin/
COPY licenses/ /usr/share/doc/gezel/
COPY app/ /opt/gezel/app/
COPY --chmod=0755 entrypoint.sh /usr/local/bin/gezel-entrypoint
COPY image.json /opt/gezel/image.json

# Everything the daemon would otherwise fetch on a first boot is here; only
# models download at runtime. The listener and accounts are ADR 0029's
# container mode. Loopback inside the container is the container's own, so
# the internal listener stays plain HTTP.
ENV PATH="/opt/gezel/node:/opt/gezel/app:${PATH}" \
    GEZEL_HOME=/gezel/home \
    GEZEL_CONTAINER=1 \
    GEZEL_CONTAINER_PORT=6228 \
    GEZEL_PORT=16228 \
    GEZEL_INSECURE_TRANSPORT=1 \
    GEZEL_SERVICE_ROLE=user \
    GEZEL_NATIVE_BIN_DIR=/opt/gezel/native-bin \
    GEZEL_NODE_PATH=/opt/gezel/node/node \
    GEZEL_PNPM_PATH=/opt/gezel/pnpm/bin/pnpm.mjs \
    GEZEL_DUCKDB_BIN=/opt/gezel/duckdb/duckdb \
    GEZEL_SECRETS_BACKEND=file \
    GEZEL_LAN_DISCOVERY=0 \
    GEZEL_DISABLE_MACHINE_SHARED=1 \
    GEZEL_DISABLE_MACHINE_ENGINE=1 \
    GEZEL_INITIAL_MODE=reactive+tasks \
    NVIDIA_DRIVER_CAPABILITIES=compute,utility,graphics

USER gezel
WORKDIR /work
VOLUME ["/gezel"]
EXPOSE 6228
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["gezel-entrypoint", "health"]
ENTRYPOINT ["/usr/bin/tini", "--", "gezel-entrypoint"]
CMD ["serve"]
