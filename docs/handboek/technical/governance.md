---
id: governance
title: "Governance: who writes Gezel, and how"
order: 6.5
summary: Open source, not open contribution — how proposals reach a release, how changes are checked, and what keeps working if we stop.
subcategory:
  id: how-gezel-works
  title: How Gezel works
  order: 1
---

# Governance: who writes Gezel, and how

Gezel is open source under the MIT license. Anyone can read it, audit it, fork it and build it. It is not open to outside code: every line in the repository is written by one team at Bendyline. This page explains why, how an idea from outside reaches a release anyway, and what checks a change has to pass.

## Open source, not open contribution

Gezel runs scripts that models write, on people's own machines, with access to their files. For software like that, we think the safer arrangement is one accountable author for every line, one set of conventions throughout, and no path by which a change reaches you without that team having written and reviewed it. SQLite has worked this way for more than twenty years, for much the same reasons.

So pull requests that change source code, tests, build configuration or dependencies are closed, however good they are. That is not a judgment on the change. It keeps the answer to "who wrote this?" simple.

## How proposals work

Ideas from outside are welcome, and this is how they get in:

1. **Write the problem down.** Add a Markdown document to the [`specs/`](https://github.com/bendyline/gezel/tree/main/specs) folder: the problem, the behavior you want, the constraints, and examples or acceptance criteria.
2. **Open a pull request containing only that document.** It is a request for consideration, not a commitment that it will be built.
3. **If it is accepted, the team implements it** in the codebase's own conventions, with its tests.

For something smaller, [open an issue](https://github.com/bendyline/gezel/issues/new). The submission terms in [`CONTRIBUTING.md`](https://github.com/bendyline/gezel/blob/main/CONTRIBUTING.md) grant Bendyline and the public a license to use what you submit, so an accepted idea can ship without any further paperwork.

## How changes are written and checked

Much of Gezel's code is written by AI coding agents, directed by the team. Nothing written that way reaches a release on the agent's say-so. Every change lands through the team and passes the same automated checks:

- **Build, lint, type check and the unit suites,** with the UI, service and terminal suites repeated three times on every change, so a test that only sometimes passes is caught rather than shipped.
- **Model-facing contract checks.** The tool names and descriptions a model sees are checked against what each role is really allowed to call, so a prompt cannot advertise a tool the security level has removed.
- **Platform checks** for the Windows service, its sandbox and engine discovery, on both x64 and ARM.
- **Packaging checks** on a release-stamped build: the packaged service loads, the published package shapes are right, and a software bill of materials is generated.
- **Pinned dependencies in the build itself.** Every GitHub Action the workflows use is pinned to an exact commit, and a scheduled audit raises an alarm on known vulnerabilities in production dependencies.

## What a security-relevant change must preserve

The [security architecture](https://github.com/bendyline/gezel/blob/main/docs/security-architecture.md) document is the reference for every change that touches what a model can reach. It ends with the rules a change must not break, among them:

- Check a permission where the action happens, not only where a tool is offered, so no route around the check exists.
- Work out who is asking from their credentials, never from what the request claims about itself.
- Keep secrets on the service side; scripts and tools get results, never keys.
- Send paths through the path-safety helpers and outbound requests through the request guard, and start processes without a shell.
- Classify every new model-reachable tool against the security levels before it ships.
- Make code and comments agree. A comment that promises a protection the code does not have is treated as a defect.

## Releases you can check

Every release publishes a `SHA256SUMS` manifest and SLSA build provenance for each installer, and the macOS and Windows installers are signed. [Verifying your download](verifying-your-download.md) shows how to check that what you installed is what the release pipeline built.

## Reporting a security problem

Email [support@bendyline.com](mailto:support@bendyline.com) with the subject `[Gezel Security]`. Please do not post exploitable details in a public issue. Fixes are made against the latest release.

## If Bendyline stops

Nothing about how Gezel runs depends on us staying in business:

- **The license.** MIT lets anyone fork the code and carry on, and the catalog of craftbooks, roles and models is MIT-licensed too.
- **Your data.** Projects, crews, memories and history are Markdown, JSON and SQLite files on your own machine, readable without Gezel.
- **No account or server.** There is no Bendyline sign-in and no Bendyline service in the path of your work, so an installed copy keeps working.
- **Standard model files.** Models are ordinary GGUF and MLX model files, downloaded from Hugging Face and usable by other tools.

What would stop is new releases. Engine downloads and update checks go to Gezel's GitHub releases, so a fresh install would need those releases to stay up, or someone to build them from source.
