---
id: generalist-mode
title: Generalist mode
order: 9.5
summary: One gezel carries a task from first step to last in a single conversation.
---

# Generalist mode

A task in gezel is a recipe — a craftbook — walked one step at a time, with a check at the end of each step. There are two ways to staff that walk.

**Stepwise** is the crew approach: each step names the trade it needs, a specialist for that trade picks it up in a fresh conversation, passes the step's check, and hands the next step to the next specialist. It is how small on-device models get the most out of a recipe, because each conversation stays short and focused.

**Generalist mode** puts one pair of hands on the whole task. A single gezel — the [Generalist](../gezel-roles/role-generalist.md) — reads the outline of the task, works the active step, passes its check, and moves to the next, all in one continuous conversation. What it learned in step two is still in front of it in step five. The steps and their checks are the same ones a crew would walk; nothing is skipped and nothing is merged.

## When it is on

Settings → Artificial Intelligence → **Run in generalist mode** has three keys:

- **Automatic** (the default): on for hosted frontier models — Claude, ChatGPT and Codex, GitHub Copilot — and off for models running on this device.
- **On**: every task runs in generalist mode, whatever the model. Useful for trying a capable local model on a whole task.
- **Off**: every task runs stepwise, even on a frontier model.

The choice is made once, when a task is created, so changing the setting never disturbs a task that is already under way.

## What stays the same

- **Every step, every check.** The Generalist advances one step at a time and each step's check must pass before the next is revealed.
- **Fan-out still fans out.** When a step spawns one child task per item — one story per topic, one invoice per client — each child is its own conversation, so the work still happens in parallel. The Generalist collects the results when the children finish.
- **Your choices win.** If you assigned a task to a particular gezel, that gezel stays the owner; a step that is yours to approve stays yours.

## What changes

- **One owner, one conversation.** No hand-offs between specialists, no re-reading of notes to reconstruct what the previous step found.
- **The whole outline in view.** The gezel sees the goal and every step, marked done, active or pending, so it can shape today's step for tomorrow's.
- **The full bench.** The tools every step in the recipe needs are available from the start.

See also [Tasks and supervision](tasks-and-supervision.md) for how steps, checks and pauses work.
