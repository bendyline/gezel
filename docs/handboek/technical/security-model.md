---
id: security-model
title: "The security model: tokens, sandboxing, and consent"
order: 5
summary: The guardrails between your crew and your computer.
---
# The security model

Giving AI hands means deciding, carefully, what those hands may touch.

**It is important to note: gezel is still in early beta.** Undoubtedly there are still security flaws or broader design holes in the security regimen of gezel.

**Our security model is not designed to be perfect.** In many places, the security design focuses on keeping honest models honest via layers of "defense in depth". This lets gezel still be useful without requiring you to make every fiddly technical security decision, and without requiring exotic and complicated isolation mechanisms (e.g., containers). Think of the security design like multiple 5-foot-tall chain-link fences: it keeps things corralled, but a determined attacker (a purpose-built malicious program already on your machine) could hop over them.

Also, most of this guidance applies whenever a model acts through gezel's own tools — local models and direct API providers (OpenAI and Anthropic keys) alike. If you work through the Claude CLI, Codex CLI, or GitHub Copilot, those harnesses run their own tool loops under their own security designs: gezel configures them — permission modes, sandbox settings — but the enforcement is theirs. Like us, those providers put a lot of work and thought into securely managing threads, but flaws can happen anywhere.

## How gezel secures a model's hands

Gezel layers its guardrails:

### The service is locked to your machine

The background service only accepts connections from your own computer, over an encrypted local channel, with a token that rotates every time the service starts. Other software on the machine can't impersonate the app, and nothing is reachable from the network.

### Workspaces have walls

A gezel working in a project sees that project's workspace — not your whole disk. Paths a model asks for are checked against the workspace boundary before any file is read or written, so "../" tricks and symlink hops end at the wall.

### Scripts run in layered isolation

When a gezel runs code, that code doesn't run inside the app and doesn't get your full user powers. It runs in a separate process wrapped in several independent layers, so no single slip opens the whole machine:

- **Its own small world.** The script gets a fresh scratch area, and its writes are confined to that area and the project workspace — not your disk. The JavaScript runtime itself enforces the file boundary.
- **No calling for backup.** The script can't launch other programs, spawn workers, or load native extensions. A script also can't quietly open its own connection to the internet — when a gezel needs the web, it goes through gezel's named tools (search, fetch, the browser), which are policy-checked and show up in History. In most configurations, whatever a gezel does, it does alone, inside the fence of the project workspace.
- **The operating system holds the outer wall.** When a script is meant to run without network access, that's enforced by the OS itself — macOS's sandbox on Mac, a confined service on Linux — not by asking the code to behave. If the machine can't provide that wall, gezel refuses to run the script at all rather than quietly settle for less.
- **A time and memory leash.** Every run has a deadline and can be capped on memory, so a runaway script gets stopped instead of dragging your machine down.

The layers deliberately overlap: even if one were bypassed, the next is still standing.

### Mutations need consent

Reading is cheap; changing things is not. Writes to project files, anything touching git, and outward-facing actions go through per-project consent you control in Settings. Git itself stays yours: gezellen work in your working copy but don't commit, branch, or push on their own.

### Where possible, we never let a gezel directly connect to services

We still want gezel to be useful, and being useful means connecting to services like e-mail or data services. But we never let the local gezel just have access to pull that data directly. Instead, outside of the purview of a gezel, we have a system of connectors and toolsets that pull down data and place it in the gezel workspace; for example, each e-mail is a file in your workspace folder. The gezel can then reason over that e-mail as a file in an isolated folder. If it needs to work with e-mail (e.g., send an e-mail), it does so through an abstracted request, with your permission.

### Leverage the node.js/NPM open source ecosystem

At your direction, gezel can download additional scripts and tools to extend what you can do with gezel. For this, we use the NPM (node.js) package manager. NPM is a package catalog owned and managed by GitHub/Microsoft, and is used by millions of developers for building many of the apps you may already be using. NPM is not perfect, and there have been compromises of NPM. Gezel applies the standard hardening locally: packages install with their install-time scripts disabled — the classic supply-chain trick never runs — and the code they bring executes inside the script sandbox described above. The collective eyes of the community on this open source catalog, coupled with those local practices, help make this the best but always imperfect system for people to leverage other people's honest open source at scale.

### Everything is on the record

Tool calls, project changes, crew changes — all land in the History log. Supervision you can't audit isn't supervision; the log is the floor the rest stands on.
