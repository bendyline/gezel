# example-habit-tracker

The middle step: state, scripts, tools, and a live Output page.

What it demonstrates:

- **Both script forms.** `habit-store` is a sidecar file at `versions/1.0.0/scripts/habit-store.ts` (nice to edit and typecheck); `streaks-report` is inline in the version manifest's `scripts` map. `gezel app pack` folds sidecars into the map, so the packed app is identical either way.
- **Script-backed tools with `bind`.** Three narrow tools share one store script; `bind` pins the operation so a caller cannot swap it.
- **A page-only tool with a reaction.** `log_habit` is listed in `pages.tools`, so the model never sees it; when the dashboard invokes it, the `reaction` summons the coach with the tool output interpolated into the prompt.
- **Workspace seeds** (`habits.json`) and an **Output page** that reads them (`gezel.data.read`/`watch`) and follows the light/dark theme contract.

Try it:

```bash
gezel app validate examples/apps/example-habit-tracker
gezel app pack examples/apps/example-habit-tracker
gezel app add example-habit-tracker-1.0.0.gezapp --yes
gezel app apply example-habit-tracker
```

Next step up: [example-reading-circle](../example-reading-circle/README.md) adds a crew, craftbooks, a schedule, and a dependency lock.
