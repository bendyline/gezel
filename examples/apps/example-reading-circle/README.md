# example-reading-circle

The full shape: a crew, craftbooks both ways, a schedule, and a dependency lock.

What it demonstrates:

- **A crew.** Two gezel-template items; the host is marked `voorman: true` and delegates record-keeping to the archivist.
- **An embedded, type-private craftbook.** `session-prep` lives inside the project type at `versions/1.0.0/craftbooks/session-prep.json` — it ships with the app and appears in no catalog.
- **A craftbook-template item.** `example-reading-digest` is a separate versioned item with a `craftbook.json` and a `test.json` eval sidecar, the reusable form.
- **A night-shift schedule.** The digest runs during the Night Shift window, consent-gated (`consent: "ask"`).
- **A dependency lock.** The digest craftbook needs the `web-search` toolset; packing resolves it to an exact version in the manifest's `dependencies`, and install checks it is available. The type also lists it under `toolsets` with `need: "required"`, so adoption installs it — which is what lets the night-shift schedule create its host task.

Try it:

```bash
gezel app validate examples/apps/example-reading-circle
gezel app pack examples/apps/example-reading-circle
gezel app add example-reading-circle-1.0.0.gezapp --yes
gezel app apply example-reading-circle
```
