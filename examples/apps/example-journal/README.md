# example-journal

The smallest complete AI App, and the place to start reading.

What it demonstrates:

- The source-folder layout: a minimal `gezapp.json` beside `items/`, with each item split into an identity `manifest.json` (stable across versions) and a `versions/1.0.0/` payload.
- A solo project type: `mode: "solo"` with a `leadLabel`, so the one gezel presents as "Journalkeeper" instead of a generic crew.
- Adoption params: `params.subject` feeds `nameTemplate`, `about.md`, and `mission.md` through `{{subject}}` substitution.
- A gezel role template: the `example-journal-keeper` item whose `about.md` becomes the gezel's working character.

Try it:

```bash
gezel app validate examples/apps/example-journal
gezel app pack examples/apps/example-journal
gezel app add example-journal-1.0.0.gezapp --yes
gezel app apply example-journal   # run inside the folder you want the journal in
```

Next step up: [example-habit-tracker](../example-habit-tracker/README.md) adds seeds, scripts, tools, and an Output page.
