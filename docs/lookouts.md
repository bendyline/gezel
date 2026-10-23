# Lookouts

A **lookout** is the person's standing instruction to a project: *keep a
lookout for X, then do Y.* Today X is judged by a camera
([device-connectors.md](./device-connectors.md)); the shape is general so mail
and feed connectors can be sources later. The person-facing article is
[Cameras and lookouts](./handboek/conceptual/cameras-and-lookouts.md); the
decision record is [ADR 0026](./decisions/0026-lookouts.md).

"Lookout", not "watch" or "trigger": `watch` already names workspace watchers
and the notification gate's "the person is watching", and craftbooks and the
Keurmeester already have `triggers`.

## The rule that holds it together

**The lookout engine never calls a model.** The camera's vision review asks
every armed lookout's question in its one structured call and returns
yes/no answers. `LookoutManager` admits a yes against the lookout's limits,
records the firing, and runs the actions. Actions fire on structured
answers, never on vision prose: text visible in the scene can steer what the
vision model writes, so camera text is cut to one line, stripped of links,
addresses, numbers and markdown, always quoted and labeled, and never becomes
a recipient, a parameter, a task description, or an instruction
([core lookouts/templates.ts](../packages/core/src/lookouts/templates.ts)).

## Data

| File | Owner | Notes |
|---|---|---|
| `projectPrivateDir/lookouts.json` | the person, through `Store.listLookouts` / `writeLookouts` | Not `project.json`: its `updatedAt` reads as "activity". |
| `projectPrivateDir/lookout-state.json` | `LookoutManager` only | Per-lookout counters (local day, fired, follow-ups, episodes fired, `sure` yes counts) and the last 25 firings. Survives a restart. |
| `~/.gezel/lookouts/daily.json` | `LookoutManager` | Install-wide ceilings: 60 firings, 30 outside messages, 10 AI follow-ups a day. On disk so a restart loop cannot reset them. |
| `~/.gezel/lookouts/{sounds,speech}/` | `SoundPlayer`, `speak` | Synthesized clips and spoken alerts. Derived, safe to delete. |

`Lookout` ([schemas/lookout.ts](../packages/core/src/schemas/lookout.ts)):
`source` (`camera` + binding), `condition` (`motion`; `subject`; or `ask`
with the person's question and `strictness: 'normal' | 'sure'`), `actions`,
`limits` (`cooldownMinutes` 10, `maxPerDay` 12, `followUpsPerDay` 4),
optional `activeHours` (local time, may wrap past midnight), `snoozedUntil`,
`state` (`proposed` | `armed` | `retired`), and `createdBy`.

## Admission

`admitLookout` ([core lookouts/admission.ts](../packages/core/src/lookouts/admission.ts)),
in this order: armed and enabled → not snoozed → inside active hours → the
condition matched (`motion` on episode start; `subject`/`ask` on a review
whose answer is a **confident** yes — a low-confidence match counts as no; a
`sure` lookout needs two yeses in the episode) → not already fired for this
episode → past its cooldown → under its daily limit. A lookout fires at most
once per episode. The manager also requires engagement that allows task work,
`config.lookouts.paused` off, and `projectAcceptsLiveWork`.

## Actions and their gates

Each action runs on its own (60 s timeout); a held one never silences the
rest, and every outcome is recorded with a plain-language reason
([core lookouts/gates.ts](../packages/core/src/lookouts/gates.ts)).

| Action | Runs through | Gate |
|---|---|---|
| `notify` | the `lookout_fired` global event; Electron and the in-app toast | always |
| `sound` | `SoundPlayer` — PowerShell `Media.SoundPlayer` / `afplay` / `pw-play`→`paplay`→`aplay`; clips synthesized in code | always |
| `speak` | on-device TTS, falls back to the chime | always |
| `push` | `ChannelManager.send` (ntfy, Slack, …) | `allowAppNetwork`, a channel configured, outbound ceiling |
| `email` | the bound mail connector's `send` (draft → commit) with `standingRecipients` | `allowMail` (Free), the binding's recipient allowlist, only the lookout's own recipients, outbound ceiling |
| `ask-gezel` | `ChatManager.deliverReaction` with a seed that leads with the person's instruction and labels the camera text untrusted; keyframes as image refs | task work allowed; follow-up limits; held for a cloud provider unless the camera allows cloud AI |
| `run-craftbook` | `startCraftbookRun` ([tasks/craftbook-run.ts](../packages/service/src/tasks/craftbook-run.ts)) with origin `{ kind: 'lookout' }` and the episode's attachments folder as the book's first `input` param | same as `ask-gezel`; skipped while a run from the same lookout is live |

`commit(…, { standingRecipients })` skips the night-shift deferral only when
every recipient is one the person typed on the lookout — a 3 a.m. alert is no
use at breakfast — and still runs the `recipient-allowlist` enforcer.
Lookout-started tasks are unattended (`tasks/unattended.ts`): they never post
questions.

## Notifications

Lookout alerts are the one earned notification that skips the 4-second
grouping and the daily cap (`EarnedKind 'lookout'`, `admitLookoutAlert`);
each lookout's own limits bound them instead. While a window is focused the
OS notification stays quiet and the in-app toast shows, with **Stop sound**.
Chat events are not replayed, so the desktop app asks
`GET /api/lookouts/recent-alerts` on every (re)connect; the ledger keeps each
firing to one notification.

## Proposals

A gezel can propose (`propose_lookout`, `POST /:id/lookouts/proposals`) a
camera, an optional yes/no question, simple alert actions and an optional
follow-up instruction. The proposal is stored `proposed` and disabled; the
person approves it in the project's Lookouts. A gezel can never arm, edit, or
widen a lookout: session tokens reach only the list and the proposal route,
and at most five proposals may wait per project.

## Routes

`/api/projects/:id/lookouts` — `GET`, `POST`, `PUT /:lid`, `DELETE /:lid`,
`POST /:lid/{approve,test,snooze}`, `POST /firings/:fid/feedback`,
`POST /proposals`; `/api/projects/:id/cameras/look`; `/api/lookouts/stop-sound`
and `/api/lookouts/recent-alerts`. Mutations need an owner caller.

## Not yet

Lookouts on other connectors (`connector-records` sources evaluated after a
sync with keywords or a one-shot JSON question), lookout presets in project
types (`consent: 'ask'`), a question-card approval flow, email attachments,
and the gilde content (a `wachter` template, `lookout-sighting` and
`lookout-patterns` craftbooks, a `home-watch` project type).
