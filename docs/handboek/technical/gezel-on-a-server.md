---
id: gezel-on-a-server
title: "Gezel on a server"
order: 10
summary: Run the Gezel service headless, under your own account, with the security level and activity mode a server should have.
subcategory:
  id: gezel-command-line
  title: The Gezel Command Line
  order: 2
---

# Gezel on a server

The Gezel service runs without a screen. The desktop app is one way to drive it; the `gezel` command line is another, and on a server it is all you need. Your projects, crews, craftbooks and history live in plain files on that machine, and the service answers only on that machine unless you deliberately pair another device to it.

This page covers a single-user server: one account that owns the service and its files. For the full list of commands, see [The gezel command line](cli-reference.md).

## What the machine needs

- **Node.js 24 or newer.** The command line checks this and says so if it is missing. On Ubuntu or Debian, `curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs` installs it; on any system, `nvm install 24` does too.
- **The command line itself:** `npm install -g @bendyline/gezel-cli`. Use that package name, including with `npx`: `npx -p @bendyline/gezel-cli gezel`. The bare `gezel` package on npm is not ours.
- **For local models on Linux, a recent C library.** Gezel's on-device engines need glibc 2.38 or newer and the GCC 14.1 C++ runtime. Ubuntu 24.04, Debian 13 and Fedora 40 or later meet that floor. Ubuntu 22.04, Debian 12, RHEL 9 and Fedora 39 do not; see the next section.
- **On Windows,** the Microsoft Visual C++ 2015–2022 Redistributable. The desktop installer adds it for you; an npm install does not.
- **On macOS,** macOS 13.3 or newer for the on-device engines.

## Older Linux: cloud models, or an engine you run yourself

Below the C library floor, the bundled engines cannot start. The system stops them before they can report anything, so a local model simply never loads. Everything else in Gezel still works: projects, crews, craftbooks, tools and the API. You have two ways to give it a model:

- **A cloud provider.** Save a key with `gezel secret set anthropicApiKey --env ANTHROPIC_API_KEY` (or `openaiApiKey`, and so on), then run `gezel` and pick one of that provider's models with `/model`. Cloud models need the `lockdown` or `free` security level; `super-lockdown` refuses them.
- **Ollama, installed and run separately.** Gezel treats Ollama as a local engine, so it is allowed at every security level, including `super-lockdown`.

Install the command line from npm on these systems. The desktop `.deb` and `.rpm` packages enforce the floor for the whole application and refuse to install below it, even if you only mean to use cloud models.

## Keep the service running

`gezel start` starts the service and returns; it keeps running until `gezel stop`. On a server, let the operating system supervise it instead: run `gezel start --foreground` as a service of your own account, so it restarts after a crash or a reboot.

Give the server its own home with `--home`. Everything the service keeps goes there, and a home you name is kept apart from anything a desktop install on the same machine shares.

On Linux, a systemd user service does this. Save the following as `~/.config/systemd/user/gezel.service`, replacing the two paths with the output of `command -v gezel` and `dirname "$(command -v node)"`:

```ini
[Unit]
Description=Gezel service
After=network-online.target

[Service]
Environment=PATH=/path/to/node/bin:/usr/bin:/bin
ExecStart=/path/to/gezel --home %h/gezel-server start --foreground
Restart=on-failure

[Install]
WantedBy=default.target
```

Then:

```sh
systemctl --user daemon-reload
systemctl --user enable --now gezel
loginctl enable-linger "$USER"   # keep it running when you are logged out
```

Every later command against that home takes the same option, for example `gezel --home ~/gezel-server status`. Setting `GEZEL_HOME` in your shell profile does the same without typing it each time.

On macOS, a LaunchAgent with the same command line and `KeepAlive` does the same job.

## Choose the security level

A server should run at a level you chose on purpose. The new-install default is `lockdown`. Set or check it from the terminal:

```sh
gezel security level              # show the current level and what it allows
gezel security level set lockdown
gezel security level set super-lockdown
```

- **`super-lockdown`:** local models only. No cloud models, no web access, no scripts, no automatic update checks, and connectors move no data. Choose this when nothing may leave the machine.
- **`lockdown`:** adds cloud models, sandboxed scripts, the model's Git tools, connector syncs you start, and update checks. Web search, mail and third-party toolsets stay off.
- **`free`:** everything, including web search and third-party toolsets. Rarely right for a shared server.

[What leaves this computer](what-leaves-this-computer.md) sets out, kind by kind, what traffic each level allows.

## Choose the activity mode

The mode decides how much the crew does without being asked. A new install starts in **full play**, which suits a desktop where someone is watching. For a server, use **reactive + tasks**: the crew answers messages, runs the tasks you start and keeps to schedules, but does not nudge or start cross-crew work on its own.

```sh
gezel mode reactive+tasks
```

`gezel stop --keep-running` is the emergency brake: it cancels AI work, unloads the engines and switches to **reactive**, while the service stays up.

## Using it

- `gezel run "..."` sends one prompt and prints the reply; it reads a prompt from standard input with `-`.
- `gezel start --web` serves the web interface on this machine only and prints a sign-in link. From your own computer, reach it through an SSH tunnel to that port rather than opening it to the network.
- `gezel doctor` checks the installation and ends with what to do next.
- `gezel bench` measures the chosen model on this machine with the same tasks as the published [model scorecard](model-scorecard.md).

Back up the home folder like any other data directory; it holds plain Markdown, JSON and SQLite files. [Where files live](where-files-live.md) gives the layout.
