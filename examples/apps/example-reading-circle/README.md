# example-reading-circle

The full shape: a crew, craftbooks both ways, a schedule, and a dependency lock.

What it demonstrates:

- **A crew.** Two gezel-template items; the host is marked `voorman: true` and delegates record-keeping to the archivist.
- **An embedded, type-private craftbook.** `session-prep` lives inside the project type at `versions/1.0.0/craftbooks/session-prep.json` — it ships with the app and appears in no catalog.
- **A craftbook-template item.** `example-reading-digest` is a separate versioned item with a `craftbook.json` and a `test.json` eval sidecar, the reusable form.
- **A night-shift schedule.** The digest runs during the Night Shift window, consent-gated (`consent: "ask"`).
- **A dependency lock.** The type lists the `docblocks` toolset under `toolsets` with `need: "required"`; packing resolves it to an exact version in the manifest's `dependencies`, and install checks it is available. DocBlocks is an npm package, so adoption lists it for you to install rather than downloading code on its own. The digest craftbook marks it `optional`, so the night-shift schedule arms at adoption and the digest adds a Word copy once DocBlocks is installed.

Try it:

```bash
gezel app validate examples/apps/example-reading-circle
gezel app pack examples/apps/example-reading-circle
gezel app add example-reading-circle-1.0.0.gezapp --yes
gezel app apply example-reading-circle
```
