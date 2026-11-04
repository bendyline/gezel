# gezeld

The Gezel background service, `gezeld`, under its short name. It installs
[`@bendyline/gezel-service`](https://www.npmjs.com/package/@bendyline/gezel-service)
and runs its `gezeld` command, so the two are the same program.

Most people never start it directly: the `gezel` command line starts the
service when it needs one.

```bash
npx gezel-cli
```

To run the service on its own, for example on a server:

```bash
npx gezeld --help
```

Gezel needs Node.js 24 or newer. See
[Gezel on a server](https://gezel.com/docs/gezel-on-a-server/) for a headless
setup.

MIT licensed. Source and issues at
[github.com/bendyline/gezel](https://github.com/bendyline/gezel).
