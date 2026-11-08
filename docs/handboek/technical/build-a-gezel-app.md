---
id: build-a-gezel-app
title: 'Build a Gezel app: the complete guide'
order: 10.5
summary: Everything a person or an AI agent needs to build a Gezel app on one page, from the working loop and the rules to the four maintained guides.
subcategory:
  id: developer
  title: Developer
  order: 3
---

# Build a Gezel app: the complete guide

This is the page to read, or to hand to an AI agent, before building a Gezel app. It starts with the working loop and the rules that keep an app working, then gives the four maintained guides: how an app is put together, how its page talks to Gezel, how it looks, and how it is organized. The exact references are linked at the end.

A **Gezel app** is an experience: a page people use, a crew that works it, the craftbooks the crew follows, and the actions it takes. A **project type** is the app's reusable composition, a **project** is one person's copy of it, and a `.gezapp` is a package that carries the composition to another computer. Use only the parts an app needs: a page and a folder are already an app.

## For AI agents: start here

Work the same loop a person does, using its machine-readable ends:

1. Install the command line with `npm install -g @bendyline/gezel-cli` (Node.js 24 or newer). `gezel app guide` prints this page for the version you installed. Add `--download` to any command that needs a model (`gezel run`, `gezel do`): it downloads the on-device engine and the model that fits this computer, printing each step, instead of stopping to ask.
2. Start from `gezel app new <name> --with-page`, or from one of the [sample apps](https://github.com/bendyline/gezel/tree/main/examples/apps).
3. Read the file formats with `gezel app schemas --json`. They are rendered from the build you installed, so they are never out of date.
4. Run `gezel app validate <folder> --json`. Fix every finding and run it again until `ok` is `true`.
5. Run `gezel app pack <folder>` to make the `.gezapp`.
6. Report what the app does, which files it owns, what it can read and change, what you tested, and how to install it with `gezel app add`.

These rules keep an app working:

- **Decide data and permissions first.** Name the files the app owns, what its page reads (`pages.reads`), where it adds files (`pages.imports`), and what each action may change.
- **Use the page API, not a bridge of your own.** Pages talk to Gezel through `window.gezel` and inherit Gezel's fonts. Never copy font files or platform scripts into an app, and never build a private file or query bridge.
- **Change files only through declared tools.** A page has no raw write API, and nothing may get around the workspace write policy.
- **Reuse the shared file components.** Anything that shows or adds files uses `gezel.ui.components.fileCard` and `fileAdder`.
- **Reuse before you add.** Prefer existing roles and craftbooks. Extend the shared runtime only when a reusable capability is missing.
- **Organize the page the Gezel way.** Home plus a tab per noun, actions as keys that open dialogs, and actions on the records themselves.
- **Test what people will use.** Try a real Gezel flow as well as the standalone demo, in both themes and at a narrow width.

The rest of this page is the four maintained guides, in this order:

::handboek-include{id=building-ai-apps-inside-gezel}

::handboek-include{id=gezel-page-apis}

::handboek-include{id=gezel-app-page-style-guide}

::handboek-include{id=gezel-app-ux-guide}

## References

Open these when you need an exact detail:

- [Output Pane API reference](https://github.com/bendyline/gezel/blob/main/docs/output-pane-api.md): every page method, permission, mode, limit, and error code.
- [TypeScript declarations for pages](https://github.com/bendyline/gezel/blob/main/packages/sdk/src/page.ts): the same API as types.
- [Project-type specification](https://github.com/bendyline/gezel/blob/main/docs/project-types.md): composition, adoption, upgrades, and the `.gezapp` format.
- [Writing scripts with gezel-sdk](writing-scripts-with-gezel-sdk.md): deterministic actions and the checks that hold a craftbook step until its work is right.
- [Sample apps](https://github.com/bendyline/gezel/tree/main/examples/apps): three complete source folders, kept working by Gezel's test suite.
- [Sharing an app page with app serve](https://github.com/bendyline/gezel/blob/main/docs/app-serve.md): a page outside the desktop app.
