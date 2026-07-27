---
id: security-model
title: "The security model: tokens, sandboxing, and consent"
order: 5
summary: The guardrails between your crew and your computer.
---

# The security model

Giving AI hands means deciding, carefully, what those hands may touch. Gezel layers its guardrails:

## The service is locked to your machine

The background service only accepts connections from your own computer, over an encrypted local channel, with a token that rotates every time the service starts. Other software on the machine can't impersonate the app, and nothing is reachable from the network.

## Workspaces have walls

A gezel working in a project sees that project's workspace — not your whole disk. Paths a model asks for are checked against the workspace boundary before any file is read or written, so "../" tricks and symlink hops end at the wall.

## Scripts run in a sandbox

When a gezel runs code, it runs in a separate, constrained process with its own working area — not inside the app, and not with your full user powers.

## Mutations need consent

Reading is cheap; changing things is not. Writes to project files, anything touching git, and outward-facing actions go through per-project consent you control in Settings. Git itself stays yours: gezellen work in your working copy but don't commit, branch, or push on their own.

## Everything is on the record

Tool calls, project changes, crew changes — all land in the History log. Supervision you can't audit isn't supervision; the log is the floor the rest stands on.
