# 0027 — Issue triage: outside coding apps judge the night shift's leads

Status: Accepted (2026-10). Builds on [0023](0023-harness-tools.md).
Contract: [issue-triage.md](../issue-triage.md).

## Context

Every night the Boekwachter review pass has a small local model flag
suspected problems in each file it reviews; each becomes a tracked BW issue.
The volume is large and the quality low: one squisq project held 2,389 open
issues, none of them triaged, and frontier models reject much of what small
models flag, especially the low-grade leads. Nothing recorded who closed an
issue or why, a dismissal suppressed only the exact message text, and the
reviewer never learned what had been judged wrong, so a rejected lead came
back the next night in new words.

The person usually already has a capable coding app (Claude Code, Codex,
Cursor, VS Code) and, since ADR 0023, a way to give it Gezel's tools.

## Decision

1. **One verdict vocabulary and one owner.** `fixed`, `confirmed`,
   `not_a_bug` (with a reason), `nit`, `wont_fix`, `duplicate`, `unsure`, in
   core. Every surface (the person's issue row, a gezel's
   `set_file_issue_status`, an outside app, an imported document) goes
   through `applyIssueVerdicts`. `nit` is kept apart from `not_a_bug` so a
   picky frontier model rejecting a true but minor lead does not count
   against the reviewer.
2. **Who decided comes from the credential.** Person, gezel, app or import;
   never a request field. An imported document is never the person.
3. **An append-only verdict log** (`boekwachter-verdicts.jsonl`) beside the
   issue registry: the history, the input to calibration, and immune to an
   older daemon rewriting the registry without the new fields.
4. **The tools are the return channel; a document is the fallback.** An
   outside app lists issues and reports verdicts through two harness tools,
   validated at the boundary. A markdown handoff document with a response
   block per issue serves apps without the tools and is read back by a
   tolerant parser. It cannot be a file in Gezel's home the app reads,
   because under the system service apps cannot read that home, and Gezel
   never writes into the person's folder.
5. **The "skill" is an MCP prompt.** `triage_issues` and `fix_issues` are
   served by Gezel with the batch embedded: nothing to install or keep up to
   date, and run by the person, so they need no CLAUDE.md line to get used.
6. **Verdicts teach the reviewer, narrowly.** A new lead that rewords one
   already judged is linked to it by a strict, model-free rule and inherits
   its outcome (major leads stay open). The review prompt lists up to five
   leads judged not worth reporting on that file, in the reviewer's own
   earlier words. Free-text notes enter only when the person wrote them; an
   app's notes are untrusted model output.
7. **Calibration orders and sets aside; it never deletes.** Verdict rates per
   reviewer model and category order the queue, and a category is set aside
   only with at least 40 verdicts and a valid-rate 95% upper bound under 25%,
   never for major issues, with one still sampled per batch.

## Consequences

- An outside app gets its first write into issue state. The guard bounds it:
  the `issues` setting (off · read · triage), the bound project only, 25
  verdicts a call and 400 an hour per app and project, and no verdict on an
  issue a task is working on. The person sees who decided and can reopen any
  issue, which the log records as an override that counts against the app.
- Noise stays. The design measures it (valid, actionable and wrong rates)
  and lowers it over time instead of promising clean leads.
- Context about a file reaches the reviewer only when the file next changes:
  reviews are keyed by content hash, and forcing re-reviews costs hours on a
  local model.
- A rewording replaces its stale predecessor (`supersededBy`), so the open
  count stops growing every time the model rephrases itself.
