# Issue triage

The night shift's reviewer flags suspected problems as BW issues. This is how
the person, a gezel or an outside coding app judges them, how Gezel takes the
verdicts in, and how the verdicts make the reviewer less noisy over time. The
decision is [ADR 0027](decisions/0027-issue-triage.md); the outside-app side
builds on [harness-tools.md](harness-tools.md).

## The pieces

| Piece | Where |
|---|---|
| Vocabulary, lifecycle mapping, labels, definitions | [core issue-triage/verdicts.ts](../packages/core/src/issue-triage/verdicts.ts) |
| Schemas | [core schemas/file-review.ts](../packages/core/src/schemas/file-review.ts), [schemas/api/issue-triage.ts](../packages/core/src/schemas/api/issue-triage.ts) |
| Registry and verdict log | [service fs/boekwachter-issue-store.ts](../packages/service/src/fs/boekwachter-issue-store.ts), `Store.boekwachterIssues` |
| Applying verdicts | [service issue-triage/verdicts.ts](../packages/service/src/issue-triage/verdicts.ts), actor in [actor.ts](../packages/service/src/issue-triage/actor.ts) |
| Triage queue | [issue-triage/queue.ts](../packages/service/src/issue-triage/queue.ts) |
| Repeat linking | [issue-triage/echo.ts](../packages/service/src/issue-triage/echo.ts) |
| What the reviewer is told | [issue-triage/prior-verdicts.ts](../packages/service/src/issue-triage/prior-verdicts.ts), used by `reviewFile` |
| Calibration | [issue-triage/calibration.ts](../packages/service/src/issue-triage/calibration.ts) |
| Handoff document | [core issue-triage/handoff.ts](../packages/core/src/issue-triage/handoff.ts), [service issue-triage/handoff-report.ts](../packages/service/src/issue-triage/handoff-report.ts) |
| Outside-app tools and prompts | [mcp harness/issues.ts](../packages/mcp/src/harness/issues.ts), [core tools/harness-prompts.ts](../packages/core/src/tools/harness-prompts.ts) |
| Client | `client.issueTriage` ([client issue-triage.ts](../packages/client/src/issue-triage.ts)) |

## Verdicts

| Kind | Meaning | Issue becomes |
|---|---|---|
| `fixed` | real, fixed now | resolved |
| `confirmed` | real, not fixed | open (the night-fix planner takes these first) |
| `not_a_bug` + `incorrect` · `handled_elsewhere` · `intended` | the lead is wrong | dismissed (`not_an_issue`) |
| `nit` | true, too small to matter | dismissed (`wont_fix`) |
| `wont_fix` | real, left on purpose | dismissed (`wont_fix`) |
| `duplicate` + `duplicateOf` | same as another BW issue | dismissed (`duplicate`) |
| `unsure` | cannot tell | open |

Gezel writes `recurred` (a fixed lead came back, or its fix was reverted),
`echo` (a rewording of a judged lead), `superseded` (an open lead replaced by
its rewording) and `reopened` (the person overriding a verdict).

`applyIssueVerdicts` is the only way in. It reads each file's live hash
first: "fixed" on a file whose content is still the content the lead was
reported on is accepted but marked `unverified`. A gezel or an app may not
judge an issue a task is working on (`in_progress` with a `taskRef`); the
person may. Each call writes one `project.issue.verdicts` history event.

**Who** is decided by the credential (`issueVerdictActorFor`): the owner's
clients are the person, a session token is its gezel, a harness token is its
app, and the import route stamps `{kind:'import', declaredApp?}`. Request
bodies never name an author; the harness guard refuses a body that tries.

**The log** is `projects/<id>/boekwachter-verdicts.jsonl`, append-only, one
entry per verdict, snapshotting the lead (path, category, severity, message,
reviewer model) as it read when judged. The issue record keeps only
`latestVerdict`.

## Handing issues to an outside app

- **Tools.** `list_issues` returns the next batch, grouped by file with
  absolute paths; `report_issue_verdicts` takes up to 25 verdicts with a note
  each. Both need the `issues` setting (`read` to list, `triage` to judge).
- **Prompts.** `triage_issues` (verdicts only) and `fix_issues` (fix the real,
  small ones and run the tests) embed the batch. Claude Code runs them as
  `/mcp__gezel__triage_issues`, VS Code as `/mcp.gezel.triage_issues`.
- **The queue** (`buildIssueHandoffQueue`) takes open issues with no task,
  not held by another app's lease, not on a file a proposal targets, not
  superseded; info-level only on request.
  - **Triage batches.** Until a project has 20 decided verdicts, a batch is
    sampled: current major issues, then categories round-robin, then 20% at
    random. After that, the likeliest real first (calibration), each
    bringing up to four issues from its file, since the app reads a file once.
  - **Fix batches** (`mode: 'fix'`, the `fix_issues` prompt) never sample and
    never pack by file. They take confirmed issues first, then by severity,
    then by each category's worth-fixing rate (`categoryPrior`: bug-like
    0.56, error-handling and performance 0.12, everything else 0.05),
    pulled toward the project's own verdicts as they arrive. On trial t1's
    night reviews this put all 35 flagged planted bugs into the first 40
    issues, against 23 for the triage batch.
  - Handing issues to an app leases them to it for two hours, so the night
    shift does not start fixing them meanwhile.
- **The handoff document** (`reports/issue-handoff.md`, rewritten nightly when
  its issues change; also "Write now" in Reports) lists the batch with a
  response block per issue:

  ```
  <!-- gezel:response BW-17 -->
  Verdict: not a bug
  Reason: handled elsewhere
  Notes: The caller checks the length (src/rows.ts:40).
  <!-- /gezel:response -->
  ```

  Reports → Issues for review offers Copy, Save… and Import answers….
  `parseIssueHandoffResponses` finds blocks by their comments, falls back to
  `BW-n` headings when an app dropped them, accepts everyday words ("won't
  fix", "false positive", "by design"), and skips empty blocks. A document
  made for another project is refused.

## The morning

The nightly codebase report opens with **New tonight** (issues first flagged
in the last day, minus repeats and set-aside categories) and a **Triage so
far** tally; from 20 decided verdicts it adds how many leads were true, worth
fixing, or wrong. The morning card adds one sentence when there are new
issues. No new notification source.

## Less noise over time

- **Repeat linking.** When a review reports a lead with a new fingerprint,
  `matchEarlierLead` compares it with the file's earlier leads this review
  did not repeat word for word. A match needs the same normalized category,
  the same identifiers (backticked, camelCase, snake_case), lines within 15
  when both have one, and word overlap of at least 0.5. A repeat of a
  dismissed lead is created dismissed (`duplicate`, `echoOf`) unless it is
  major; at most five per file per review. A rewording of an open lead
  supersedes it and inherits a `confirmed` or `unsure`.
- **What the reviewer is told.** `withPriorVerdicts` loads each file's
  dismissed leads once per review batch; `reviewFile` adds up to five to the
  prompt (the reviewer's own earlier message, the verdict and reason, a note
  only when the person wrote it), skips files whose content is shared by
  another path, gives each window of a large file only its own leads, and
  takes the block out of the window budget. It applies when the file next
  changes; nothing forces a re-review.
- **Calibration.** `issueVerdictStats` counts the latest decisive verdict per
  issue, by reviewer model and category. Rates: valid (fixed, confirmed, nit,
  wont_fix), actionable (fixed, confirmed), wrong (not_a_bug). The queue orders
  by actionable rate smoothed toward a prior. A category is set aside
  (`isLowConfidence`) only with 40 verdicts and an actionable-rate Wilson
  upper bound under 15%, never for major issues; one set-aside issue is still
  sampled per batch. The rule reads "worth fixing", not "true": in the
  2026-10-22 evaluation the valid rate sat at 50-72% in every category and
  never separated them, while the actionable rate split bugs (56%) from
  smells (5%). A set-aside issue is still listed, marked `lowConfidence` on
  the wire (`list-file-issues`, `file-review`); `counts.lowConfidence` says
  how many of `counts.total` they are. The file tree's badges and total, the
  morning card's new-issue line and the report's "New tonight" leave them
  out, the night-fix planner skips them unless someone confirmed that one,
  and the issue row says "Low confidence". A person reopening an app's dismissal counts against
  that app (`apps[].reopenedByPerson`). `GET /api/projects/:id/index/issue-stats`
  serves the numbers.

## Evaluation

The plan's evaluation (labeled corpus, triage quality against the person's
labels, the round trip, the feedback loop, calibration) runs from the
experiment kit, `D:\gh\harness-eval\scripts\triage\`; results go to
`evals/runs/ISSUE-TRIAGE-<date>.md`.
