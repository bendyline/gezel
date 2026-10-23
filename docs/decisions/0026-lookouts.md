# 0026 — Lookouts: a person's standing instruction to a project

Status: Accepted (2026-10). Builds on [0025](0025-device-connectors.md).
Contract: [lookouts.md](../lookouts.md).

## Context

Gezel starts work in narrow ways — cron and night-shift hosts, page
reactions, step hooks — and nothing reacts to what a source *saw*. "When the
mud room camera sees the cat on the floor, play the alarm and email me"
needed an event → condition → action concept, readable by a person who has
never heard the word trigger.

## Decision

1. **A lookout is the person's sentence.** Source, condition, actions,
   limits; stored in the project's private sidecar, never `project.json`.
   Named "lookout" because `watch` and `triggers` are taken.
2. **The engine never calls a model.** The source answers each lookout's
   yes/no question (the camera, in its one structured review); the engine
   admits a confident yes and acts. Vision prose is untrusted and never
   becomes an instruction, parameter, or recipient.
3. **Bounded by construction.** Once per episode, a cooldown, a daily limit
   per lookout, and install-wide daily ceilings on disk. Every action is
   gated and recorded on its own with a plain-language reason.
4. **Actions reuse what exists.** Notifications (a new earned kind that skips
   grouping and the daily cap), the channel manager, the mail connector's
   draft/commit (with a standing approval that only waives night-shift
   deferral, only for the lookout's own recipients), `deliverReaction`, and
   one shared craftbook-run helper.
5. **Gezels propose; people arm.** A proposal is stored disabled; session
   tokens cannot create, edit, test, or approve.

## Consequences

- Lookout alerts are the one notification that is not grouped or capped; the
  notification docs say why.
- A cloud gezel asked to follow up on a camera is held unless that camera
  allows cloud AI — the firing log says so in words.
- The same shape takes other sources later (a mail sync's new records with a
  keyword or one-shot question) without changing the engine.

## Alternatives considered

- **Lookouts as task schedule hosts.** Hosts can only launch work; a sound or a
  notification is not a task.
- **Letting the vision model decide actions.** One sign held up to the
  camera would send email.
- **A dedicated project tab.** Lookouts sit beside the cameras in the
  project's Connections area for now, where the only sources live.
