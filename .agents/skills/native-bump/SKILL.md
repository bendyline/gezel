---
name: native-bump
description: Bump the pinned versions of gezel's native engine binaries (llama.cpp, sd-cpp, whisper.cpp, uv, ds4), push a build through CI, then fetch + eval the result. Use when the user says "update/bump the native binaries", "upgrade llama.cpp / the engines", "cut a native release", or names an engine to update.
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
---

# native-bump

Updates the upstream versions gezel pins for its native engines, drives a CI build, and validates the result: **pick versions → bump pins → build in CI → triage → fetch + eval.**

## Architecture (read once)

Two independent version lines — don't conflate them:

- **`native/engines/<engine>/VERSION`** pins the *upstream* commit each engine is built from (`tag` + full `commit`). This is what "update the binaries" means — repointing at newer upstream.
- **The `native-v<X.Y.Z>` git tag IS the gezel bundle version.** There is no `native/VERSION` file. Cutting that tag is what triggers a build+release of whatever the VERSION files currently pin. (`scripts/cut-native-release.mjs` header explains this.)

The 5 engines:

| Engine | Upstream repo | `tag=` format | How to check latest |
|---|---|---|---|
| **llama-cpp** | ggml-org/llama.cpp | `b####` (cut several times/day) | `gh api repos/ggml-org/llama.cpp/releases/latest --jq .tag_name` |
| **sd-cpp** | leejet/stable-diffusion.cpp | `master-<N>-<shortsha>` | `gh api repos/leejet/stable-diffusion.cpp/tags --jq '.[0].name'` |
| **whisper-cpp** | ggml-org/whisper.cpp | `v1.x.y` (semver) | `gh api repos/ggml-org/whisper.cpp/releases/latest --jq .tag_name` |
| **uv** | astral-sh/uv | `X.Y.Z` (semver) + 5 sha256 | `gh api repos/astral-sh/uv/releases/latest --jq .tag_name` |
| **ds4** | antirez/ds4 (DeepSeek-V4 / DwarfStar) | `main-YYYY-MM-DD` (tracks main) | `git ls-remote https://github.com/antirez/ds4.git HEAD` |

**⚠ Git is the user's.** Per `AGENTS.md`, agents don't commit, push, tag, branch, or run `cut-native-release.mjs` (it pushes a tag) unless the user explicitly asks. This skill's flow: **you edit the VERSION files + code constants; the user commits/pushes and cuts the release** (or tells you to). Everything after the tag exists — watching CI, fetching, evaling — is yours.

---

## Phase 1 — Bump the pins

For each engine the user named (or all, if they said "update the native binaries"):

1. **Resolve the target tag + full commit.**
   ```bash
   # tag → 40-char commit (deref annotated tags with ^{})
   git ls-remote https://github.com/ggml-org/llama.cpp.git refs/tags/<tag>
   ```
   Record the **40-char** sha (tags move; shas don't).

2. **Edit `native/engines/<engine>/VERSION`** — set `tag=` and `commit=` together. Then verify reachability:
   ```bash
   git ls-remote https://github.com/<owner>/<repo>.git refs/tags/<tag>   # sha must equal the commit you pinned
   ```

3. **llama-cpp ONLY — sync the cache-bust constant.** `packages/core/src/native/llama-engine-version.ts` has `LLAMA_ENGINE_VERSION`, which **must equal the new `b####`**. Its doc says "Bumped alongside `native/engines/llama-cpp/VERSION`"; a stale value causes backend-probe cache thrash. *(This is the #1 missed step — it was already stale `b8892` vs VERSION's `b9843` when this skill was written.)*

4. **uv ONLY — refresh all 5 sha256 digests.** `build.sh`/`build.ps1` verify the downloaded archive against the pin. Target→key mapping:
   | VERSION key | uv release asset |
   |---|---|
   | `sha256_darwin_arm64` | `uv-aarch64-apple-darwin.tar.gz` |
   | `sha256_darwin_x64` | `uv-x86_64-apple-darwin.tar.gz` |
   | `sha256_linux_x64` | `uv-x86_64-unknown-linux-gnu.tar.gz` |
   | `sha256_linux_arm64` | `uv-aarch64-unknown-linux-gnu.tar.gz` |
   | `sha256_win32_x64` | `uv-x86_64-pc-windows-msvc.zip` |
   ```bash
   V=<uv-version>; for a in uv-aarch64-apple-darwin.tar.gz uv-x86_64-apple-darwin.tar.gz \
     uv-x86_64-unknown-linux-gnu.tar.gz uv-aarch64-unknown-linux-gnu.tar.gz uv-x86_64-pc-windows-msvc.zip; do
     echo "$a: $(curl -fsSL https://github.com/astral-sh/uv/releases/download/$V/$a.sha256 | awk '{print $1}')"; done
   ```

5. Hand the diff to the user to commit. `native/engines/*/build.{sh,ps1}` almost never change for a version bump — only touch them if the upstream build interface moved.

---

## Phase 2 — Trigger the build *(user drives git)*

Two paths — ask the user which (default: **test build first, then release**):

- **Release** (publishes a `native-v*` GitHub release): the user runs
  ```bash
  node scripts/cut-native-release.mjs <X.Y.Z>   # validates semver>latest, on main, clean, up-to-date; tags + pushes
  ```
- **Test build** (artifacts only, no release): `gh workflow run build-native.yml` (optionally `-f engines=llama-cpp`). Fetch its output with `--run <id>` in Phase 4 before committing to a release.

**⚠ Dispatch race — verify the SHA.** `gh workflow run` right after a push can build the *pre-push* commit. Before watching:
```bash
sleep 20; git ls-remote origin HEAD                       # confirm remote HEAD
gh run list --workflow build-native.yml -L1 --json databaseId,headSha
gh run view <id> --json headSha --jq .headSha             # must match the commit you intend
```

---

## Phase 3 — Watch CI + triage

```bash
gh run watch <id> --interval 30 || true
gh run view <id> --json jobs --jq '.jobs[] | select(.conclusion!="success") | {name,conclusion}'
```

**Release gating: `release` has `needs: build`.** ANY red matrix leg skips the whole release. So one broken platform blocks everything — you must get every leg green (or drop that leg from the matrix) to publish.

**Runner-image drift is the usual cause — not gezel code.** The failure catalog + where the fixes live (`.github/workflows/build-native.yml` `env:` + `matrix:`):

| Symptom | Cause | Fix (scope to the failing leg only) |
|---|---|---|
| `CMAKE_C_COMPILER not set` / cmake syntax | runner CMake 4.x vs old `cmake_minimum_required` | `env.CMAKE_MIN` floor / preflight; don't hard-pin a CMake that drops the VS generator |
| `find_package(SPIRV-Headers)` fails | Vulkan SDK missing the CMake config | Linux → `VULKAN_SDK_VERSION` (tarball has it); Windows → `VULKAN_SDK_VERSION_WINDOWS` (needs 1.4.x installer) |
| `nvcc error: 'cudafe++' died 0xC0000005` | `windows-latest` = VS 2026, ⊥ CUDA front-end | pin that leg's `runner: windows-2022` (already done for win32 CUDA) |
| CUDA `sm_121` / Blackwell / DGX Spark | needs CUDA ≥ 12.9 | that leg's `cuda_pkg`/arch (`CUDA_VERSION`, linux-arm64 uses `12-9` + `sm_121`) |
| `release` job 403 on download-artifact | transient artifact-service auth | re-run the failed job; `actions: read` perm is already set |

**Rule:** fix the one red leg; never perturb green legs. A bare `maxDuration`/timeout with no compiler error is often a flake — re-run before editing.

---

## Phase 4 — Fetch + eval

1. **Fetch the built binaries** into `packages/app/native-bin/<platform>[-<variant>]/` (where dev `pnpm app`, packaging, and the eval harness all read):
   ```bash
   node scripts/fetch-native-binaries.mjs                 # latest release, all variants for this platform
   node scripts/fetch-native-binaries.mjs --run <id>      # from a workflow_dispatch build (pre-release)
   node scripts/fetch-native-binaries.mjs --version 0.1.X # a specific release
   ```
   Needs a `repo`-scoped token (`GEZEL_GITHUB_TOKEN` / `GITHUB_TOKEN` / `gh auth token`) — the repo is private.

2. **Verify the build number** matches what you pinned:
   ```bash
   packages/app/native-bin/darwin-arm64-metal/gezel-llama-server --version   # → "version: 9843 (86b94708)"
   ```

3. **Eval it** — invoke the **`/eval-run`** skill against `--provider llama-cpp` (not MLX) to confirm capability didn't regress. A version bump should be capability-neutral: composite flat, only t/s moves. Score with the eval-run rubric.

---

## Critical files

| Purpose | Path |
|---|---|
| Upstream pins (tag + commit; uv + 5 sha256) | `native/engines/<engine>/VERSION` |
| llama cache-bust constant (**sync on every llama bump**) | `packages/core/src/native/llama-engine-version.ts` |
| CI matrix + version-pin env (runner-drift fixes) | `.github/workflows/build-native.yml` |
| Cut a release (tag + push) — *user runs* | `scripts/cut-native-release.mjs` |
| Fetch built binaries locally | `scripts/fetch-native-binaries.mjs` |
| Build scripts (rarely touched) | `native/engines/<engine>/build.{sh,ps1}` |

## Gotchas checklist
- [ ] Pinned the **40-char** commit, and `git ls-remote` confirms it's reachable from the tag.
- [ ] **`LLAMA_ENGINE_VERSION` synced** to the new `b####` (llama bumps only).
- [ ] uv: all **5** sha256 digests refreshed.
- [ ] Left git to the user (commit / push / `cut-native-release.mjs`).
- [ ] Verified the workflow ran against the **intended commit** (dispatch race).
- [ ] Every matrix leg green — remember `release` needs ALL of them.
- [ ] Fetched + ran `--version` + eval'd via `/eval-run` (llama-cpp provider).
- [ ] Engine-specific: ds4 can't yet load some hybrid MoE (e.g. qwen-agentworld crashes on load) — an upstream engine gap, not a bump error.
