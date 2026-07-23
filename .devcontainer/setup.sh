#!/usr/bin/env bash
# Canonical sandbox setup for the gezel workspace. Runs once at container
# provisioning time (devcontainer postCreateCommand). Optimized for
# read-only / code-review sandboxes like Claude on the web — does NOT
# run the full `pnpm all` because Electron-based E2E and the native
# llama-server / sd-server binaries don't exist on a generic Linux image.
#
# What this gives you:
#   - pnpm pinned to the version in package.json (via corepack)
#   - all workspace dependencies installed
#   - the workspace fully built (so TS imports resolve, dist/ is hot)
#   - sharp + other native deps rebuilt for the container arch
#
# What this skips on purpose:
#   - `pnpm test:e2e`    (needs Playwright + Electron + display)
#   - native binaries    (separate fetch flow, see native/README.md)
#
# Override by editing this file or replacing the postCreateCommand in
# devcontainer.json with `pnpm all` if your sandbox does have a
# display + native binaries staged.
set -euo pipefail

cd "$(dirname "$0")/.."

corepack enable
corepack prepare pnpm@10.33.0 --activate
pnpm install --frozen-lockfile=false
pnpm setup:native
pnpm build
pnpm typecheck

echo
echo "gezel workspace ready. Try:"
echo "  pnpm test                     # vitest across all packages"
echo "  pnpm --filter @bendyline/gezel-evals run test"
echo "  pnpm eval:run tictactoe       # smoke-test the eval harness"
