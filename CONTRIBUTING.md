# Contributing

Thank you for your interest in improving Gezel.

## Open source, not open contribution

Gezel is free to read, free to fork, and free to propose changes to. The code
itself is written by one team. That is a deliberate choice, made for the same
reason projects like SQLite make it: an agent runtime that runs model-authored
scripts on people's own machines should have a single accountable author for
every line, one set of conventions throughout, and no path by which a change
reaches users without that team having written and reviewed it. The published
builds carry a `SHA256SUMS` manifest and SLSA provenance so that what you
install can be checked against what the pipeline produced. The Handboek's
[Governance](https://gezel.com/docs/governance/) page explains the same model
for people using Gezel rather than building it.

## What We Accept

Code contributions are **not accepted**. Pull requests that add, modify, or
remove source code, tests, build configuration, dependencies, or other
implementation files will be closed. Bug reports, security reports and
proposals are all welcome, and the proposal path below is how ideas from
outside the team reach a release.

We welcome proposals describing fixes or new capabilities. To submit one:

1. Add a Markdown document to [`specs/`](specs/).
2. Describe the problem, the desired behavior, relevant constraints, and
   examples or acceptance criteria.
3. Open a pull request containing only the proposal document and any directly
   related proposal assets.

See the [`specs/` guide](specs/README.md) for a suggested structure. A proposal
is a request for consideration, not a commitment that it will be accepted or
implemented. For requests that do not need a full proposal, you may instead
[open a GitHub issue](https://github.com/bendyline/gezel/issues/new).

## Commit Messages

Commits on `main` follow [Conventional Commits](https://www.conventionalcommits.org/).
No hook or CI job checks them; the release tooling relies on them being right.

This is not a style preference: `multi-semantic-release` derives every published
npm version bump and changelog entry from these messages, so a malformed subject
on `main` changes what the next release publishes. See
[docs/npm-release.md](docs/npm-release.md).

## Submission Terms

By submitting a pull request, you represent that you have the right to submit
its contents. You grant Bendyline LLC and the public a perpetual, irrevocable,
worldwide, royalty-free, non-exclusive license to use, reproduce, modify,
publish, distribute, sublicense, and implement any or all facets of the
submission—including its ideas, specifications, prompts, examples, and other
content—for any purpose, without restriction, attribution, compensation, or an
obligation to use or implement it.

Do not submit confidential information or material that you do not have the
right to share under these terms.

All participation is subject to the [Code of Conduct](CODE_OF_CONDUCT.md).
