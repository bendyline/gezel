---
name: button-up
description: Shepherd the local branch to a fully green state — install missing dependencies (pnpm deps:install), make lint pass (pnpm lint), then run every build and test (pnpm all), fixing whatever fails and re-running until all three pass back to back with no edits in between. If the branch has an open PR, also triages its failing GitHub CI checks and fixes them locally. Use when the user says "button up", "button it up", "get the branch green", or "make everything pass before I commit".
disable-model-invocation: true
---

# Button Up

Take the current branch plus its uncommitted changes and leave it in a state
the user can commit with confidence: dependencies installed, lint clean, and
`pnpm all` (build, typecheck, lint, unit, published, e2e, bundle, coverage)
green. You find the failures, fix them at the root, and keep cycling until a
full pass needs no further edits.

If the branch has an open pull request, its GitHub CI is part of the job
too: every failing check must end up with a local fix or a clear
explanation.

The gates, in order:

| Gate | Command | What it proves |
|---|---|---|
| PR | `gh pr checks` | the pushed branch's CI failures are understood and fixed locally |
| A | `pnpm deps:install` | `node_modules` matches the lockfile |
| B | `pnpm lint` | biome + every repo guard script (paths, module size, layer direction, patient-fetch, markdown links, NOTICE, audit) |
| C | `pnpm all` | the full validation chain in `validate:unlocked` plus coverage |

## Ground rules

- **Never touch git state.** No commits, pushes, stashes, branches,
  worktrees, resets, or checkouts. The user drives git. Reading
  (`git status`, `git diff`) is fine.
- **Read GitHub, never write to it.** `gh pr view`, `gh pr checks`, and job
  logs are fine. Do not re-run jobs, cancel runs, comment, or change the PR
  without asking; those actions are visible to other people.
- **Run pnpm from the PowerShell tool.** Git Bash's GNU tar breaks the evals
  corpus test on this machine, so `pnpm all` fails spuriously under Bash.
- **Never use bare `pnpm install`** (the repo rejects it). `pnpm deps:repair`
  is the confirmed reconciliation path — ask the user before running it.
- **Fix causes, not symptoms.** Do not `.skip` / `.only` tests, delete
  assertions, widen timeouts to paper over a hang, add lint suppressions,
  raise module-size or budget limits, add exemption comments
  (`patient-fetch-exempt`, biome-ignore, etc.), or edit a guard script to
  make it pass — unless the change is genuinely correct, and then say why in
  your report.
- **Preserve the user's work.** Other sessions and the user's open editor
  may be changing files while you run. Do not revert or rewrite changes you
  did not make except where they are the failure you are fixing, and then
  make the minimal fix.
- **Stay in scope.** Fix what the gates report. Do not refactor, rename, or
  "improve" code the gates are not complaining about.

## Step 0 — Snapshot

Record the starting point so you can tell your edits from the user's:

```powershell
git rev-parse --short HEAD
git status --porcelain
git diff --stat
```

Keep this list. At the end you will compare against it. The user may commit
while you work, so if HEAD moves, re-take the snapshot rather than reading
their committed files as your own edits.

## Gate PR — Pull request CI

Do this first. It is cheap, and it tells you what the local gates have to
catch. If you come to it while `pnpm all` is already running, triage in
parallel; it only reads.

```powershell
gh pr view --json number,url,state,isDraft,headRefOid
git rev-parse HEAD
git status -sb
```

- No PR (`no pull requests found`), or the PR is merged/closed → skip this
  gate and say so in the report.
- `headRefOid` differs from local HEAD, or `git status -sb` shows
  `[ahead N]` → CI ran against an older commit. Its failures may already be
  fixed by unpushed commits or the working diff, so verify each one rather
  than assuming either way.

```powershell
gh pr checks <number>
```

Exit code 1 means some check failed; 8 means some are still pending. The
job id is the last segment of each check's URL
(`…/actions/runs/<runId>/job/<jobId>`).

**Getting logs.** `gh run view --log-failed` refuses while *any* job in the
run is still in progress, which is common because slow jobs (coverage,
stability, iOS) keep the run open long after the failure. Fetch the failed
job's log directly instead. It is available as soon as that job finishes:

```powershell
gh api repos/bendyline/gezel/actions/jobs/<jobId>/logs > "<scratchpad>\ci-<job>.log"
```

Each line starts with a 29-character timestamp. Grep for `##[error]`,
`ELIFECYCLE`, ` FAIL `, `error TS`, `Formatter would`, `Error:`, and
`What went wrong` (Gradle), then read the context around the first real
error. The step that failed, and the exact command it ran, are in the job's
workflow under `.github/workflows/` (search for the job's display name).

**Triage every failing check** into one of these:

- **Already fixed locally.** The working diff or an unpushed commit
  addresses it. Confirm the local gate that covers it passes (or, for a
  platform-only job, that the change actually targets the reported error),
  and map it in the report.
- **Reproducible locally.** Most of the `quality.yml` jobs are in `pnpm all`.
  Fix it, and Gates B/C will validate the fix. If it only fails in CI, the
  usual cause is timing on the 4-vCPU runner: reproduce with `pnpm test:ci`
  (one package at a time, as CI runs it) before touching timeouts.
- **Platform-only** (Android, iOS, macOS/Linux packaging, Windows service).
  Run the job's command locally if this machine can, or else the closest
  proxy (for example, building the web payload the archive verifier
  inspects). Fix what the log proves and say plainly what could not be
  verified on this machine.
- **Conventional commits.** Report it once and move on. It does not block,
  and fixing it would mean rewriting pushed history, which is the user's
  call. Do not propose a rebase.
- **Infrastructure** (lost runner, registry 5xx, network timeouts, cache
  service errors). Report it. Do not re-run the job yourself.

**Pending checks** do not block the loop. Re-run `gh pr checks` at Finish
and triage anything that has failed since then.

Local fixes reach CI only when the user commits and pushes, so the report
has to say which failing check each fix addresses.

## Gate A — Dependencies

```powershell
pnpm deps:status
pnpm deps:install
```

- Success, or "nothing to install" → go to Gate B.
- `deps:status` still says `installed dependency lock differs` after a
  successful `deps:install` → `deps:install` often runs a *filtered* install
  (e.g. `--filter ./packages/catalog`), which never prunes orphans or
  rewrites the whole `node_modules/.pnpm/lock.yaml`. Diff it against the
  wanted lockfile (`git diff --no-index node_modules/.pnpm/lock.yaml
  pnpm-lock.yaml`). If the diff only removes orphaned versions, or the
  changed entries already resolve correctly on disk (check the symlink under
  `node_modules/.pnpm/<pkg>/node_modules/`), the tree is usable: note it and
  move on. Only a missing or wrong package on disk is a real failure, and
  that needs `deps:repair`, so ask first.
- `ERR_PNPM_EPERM … electron` → something holds electron files open (the
  running dev app, its crashpad handler, or a VS Code debug session mapping
  `default_app.asar`). Identify the locker with the Restart Manager rather
  than guessing, and ask the user to close it — do not kill processes you
  have not positively identified.
- The lockfile itself is out of date (a new workspace package or a
  `package.json` dependency edit) → `deps:install` is frozen-lockfile-only.
  Tell the user what changed and ask before doing a lockfile refresh.
- Vitest later fails with `Failed to resolve entry for package "<x>"` while
  the package is on disk → stale vite optimizer cache; delete
  `packages/<pkg>/node_modules/.vite` (rebuildable) instead of reinstalling.

## Gate B — Lint

```powershell
pnpm lint
```

The chain stops at the first failing checker, so read the output to see
which one failed. When it passes, the output ends with the audit tests, so
check the exit code rather than the last lines. For a list of biome
failures, `pnpm exec biome check .` prints each failing file on a line
starting with `.\`. Formatting failures often sit in files that were
already committed, not in the working diff; they still have to be fixed.

- **biome** failures → run `pnpm lint:fix` (safe fixes only), inspect the
  resulting diff, then fix anything left by hand. Check that `lint:fix` only
  touched files that were failing; if it rewrote unrelated files, the user's
  biome config and checkout disagree — stop and report rather than
  reformatting the tree.
- **Guard scripts** (`check-path-safety`, `check-module-size`,
  `check-layer-direction`, `check-single-owner-symbols`,
  `check-patient-fetch`, `check-provider-default`, markdown links, NOTICE)
  → read the script's header comment for its intent and fix the code to
  satisfy it. The relevant rule is usually spelled out in CLAUDE.md
  (patient-fetch, safe-paths, single owners). A module over its size budget
  is split along a real seam, not trimmed of comments.
- **`test:audit-vulnerabilities`** → a fix usually means a dependency bump,
  which is a lockfile change. Report the advisory and the proposed bump and
  ask before changing dependencies.

Re-run `pnpm lint` until it passes.

## Gate C — Everything

`pnpm all` is long (tens of minutes). Run it in the background with output
captured to the scratchpad, and wait for the completion notification:

```powershell
pnpm all *> "<scratchpad>\button-up-all-<n>.log"; "EXIT=$LASTEXITCODE"
```

The echoed exit code is the verdict, since the log is too long to skim.
Grep the log for `ELIFECYCLE`, `FAIL`, and `Error:` to find where it
stopped.

It is serial and fail-fast: the first failing sub-script ends the run. When
it fails:

1. Find the failing sub-script in the log (the last `> pnpm <script>` line
   before the error) and the specific failures within it.
2. **Iterate on that piece alone**, not the whole chain:
   - one package's tests: `pnpm --filter <pkg> run test` or a single file
     via the root `node_modules\.bin\vitest.CMD run <file>` with the
     package as cwd
   - typecheck: `pnpm typecheck` (or `pnpm --filter <pkg> exec tsc --noEmit`)
   - e2e: `pnpm test:e2e:run` / `pnpm test:e2e:web:run` with a spec filter
   - published/package checks: `pnpm test:published`, `pnpm check:packages`
   - build: `pnpm build`
   Remember e2e loads `packages/app/dist/ui` — rebuild the app package after
   UI edits, or the fix will look ignored.
3. Once that piece is green, restart `pnpm all` from the top. Later steps
   in the chain have not run yet and may fail too.

### Telling real failures from noise

- **Flaky?** Re-run the single failing test once. If it passes, re-run it
  a few more times; an intermittent failure is still a bug, but note it as
  flaky and investigate the race rather than retrying until green.
- **Known local-only failures** on this machine: `meester.spec` (fresh e2e
  homes inherit machine-shared crew) and the security first-run spec's
  `afterAll` teardown hang. Confirm the failure matches that signature, then
  record it as environmental rather than "fixing" it.
- **Pre-existing vs introduced.** Use the Step 0 snapshot and
  `git diff` to judge whether a failure touches the branch's changes. Both
  kinds must be fixed for the branch to be clean, but say which is which in
  the report.

## The loop

```
PR → A → B → C
       ↑        │ any edit made while fixing?
       └────────┘
```

- An edit to `package.json`, the lockfile, or `pnpm-workspace.yaml` →
  restart at A.
- Any other edit → restart at B.
- Done when **B and C pass consecutively with no edits between them**, and
  every failing PR check has been triaged.
- If five full cycles pass without converging, or a fix needs a decision
  that belongs to the user (dependency change, deleting a test, changing a
  guard's budget, an environmental failure you cannot clear), stop and
  report what remains instead of looping.

## Finish

1. **Verify your edits survived.** For every file you changed, grep for one
   distinctive token of your change. An open editor buffer can silently save
   over your edits; re-apply anything missing and re-run the affected gate.
2. **Tidy the tree.** Compare `git status --porcelain` against the Step 0
   snapshot. Remove untracked files the run produced that are not
   gitignored (logs, stray coverage output, scratch files) — only ones you
   are certain came from this run. Logs belong in the scratchpad.
3. **Re-check the PR** (if there is one). Run `gh pr checks` again and triage
   anything that failed after Gate PR, or that was pending then.
4. **Report**, briefly:
   - final status of A, B, C (and the log path of the green `pnpm all` run)
   - PR number and a table of the failing checks, each mapped to the local
     fix that addresses it (or why it has none), noting whether the fix was
     verified locally. End with a reminder that these fixes reach CI only
     after the user commits and pushes.
   - each fix: file, what failed, the root cause, what changed
   - anything flaky, environmental, or left for the user to decide
   - files you touched that were not in the starting diff

Do not commit. The branch is buttoned up; committing is the user's call.
