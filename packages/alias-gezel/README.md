# gezel

Gezel on the command line. Put a crew of AI helpers, called *gezels*, to work
from your terminal. They run on your own computer, or on a cloud model if you
prefer.

```bash
npx gezel
```

The first time, Gezel picks a model that fits your computer, downloads it,
and opens in your terminal. Or ask for something directly, in the folder it is
about:

```bash
npx gezel run "Summarize the notes in this folder"
```

With no model set up yet, `gezel run` walks you through the same setup first,
then answers.

Gezel needs Node.js 24 or newer. Check with `node --version`. If yours is older,
`brew install node` (macOS), `winget install OpenJS.NodeJS.LTS` (Windows) or
`nvm install 24` (anywhere) gets you a current one.

To keep Gezel installed:

```bash
npm install -g gezel
```

## Learn more

- [Command-line reference](https://gezel.com/docs/cli-reference/)
- [Gezel on a server](https://gezel.com/docs/gezel-on-a-server/)
- [The desktop app](https://gezel.com/#download)

This package is the short name for
[`@bendyline/gezel-cli`](https://www.npmjs.com/package/@bendyline/gezel-cli).
It installs that package and runs its `gezel` command, so the two are the same
program. Install one of them globally, not both: they both provide `gezel`.

MIT licensed. Source and issues at
[github.com/bendyline/gezel](https://github.com/bendyline/gezel).
