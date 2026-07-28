# Contributing

Thank you for your interest in improving Gezel.

## What We Accept

Code contributions are **not accepted**. Pull requests that add, modify, or
remove source code, tests, build configuration, dependencies, or other
implementation files will be closed.

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

Commits on `main` follow [Conventional Commits](https://www.conventionalcommits.org/)
and are checked by the `commitlint` job in CI on pull requests and on pushes to
`main`. There is no local git hook.

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
