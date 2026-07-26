---
id: cli-reference
title: The gezel command line
order: 6
summary: Headless gezel — start the service, run one-shot work, export docs.
---

# The gezel command line

The `gezel` command drives the same service the desktop app uses — handy on
servers, in scripts, or when you just live in a terminal.

## Everyday commands

```
gezel start                 ensure the service is running
gezel start --port 8080 --foreground
                            run it attached, on a fixed port
gezel status                is it up, and where
gezel stop                  stop it
gezel run "..."             one-shot: send a prompt, print the reply
```

## Working with the crew

```
gezel agent list            your gezellen
gezel task list             tasks in flight
gezel env skills list       importable skills
```

## This documentation

```
gezel handboek export --out ./site
```

renders the Handboek — the same articles you're reading now — as a static
website, for publishing or offline reading.

Run `gezel --help` (or `--help` on any subcommand) for the full surface.
