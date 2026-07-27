---
id: tasks-and-supervision
title: Tasks, scheduled work, and supervision
order: 7
summary: Work that runs without you watching — and the guardrails around it.
---

# Tasks, scheduled work, and supervision

## Tasks

A **task** is a unit of work with a life of its own: it has an assignee, a status, steps, and notes. When you hand a gezel something bigger than one chat reply — "prepare the quarterly review" — it becomes a task the crew can pick up, advance, and report on. The Tasks tab shows what's in flight.

## Scheduled work

Some work should happen on a rhythm: a weekly status report, a nightly check. Projects can carry schedules that fire a craftbook automatically — with your consent, and visible in the same Tasks view as everything else. For schedules to run while the app is closed, enable the background service in Settings.

## Supervision

Autonomy is earned, not assumed. Several layers keep unattended work safe:

- **Gates.** Craftbook steps declare checks; a step that fails its checks doesn't advance, no matter how confident the model felt.
- **Model floors.** A role's steps only run unsupervised on a model tier that can handle them; below the floor, work waits for a stronger model or for you.
- **Consent.** Anything that touches your files, your git history, or the outside world goes through explicit permission — per project, inspectable in Settings.
- **The audit log.** Every meaningful action lands in History, so "what did the crew do overnight?" always has an answer.
