---
id: gezel-in-docker
title: "Gezel in Docker"
order: 11
summary: One command runs Gezel in a container, with every engine inside. Use the workshop from your browser, give your other apps local AI, or put the crew to work on a folder.
subcategory:
  id: gezel-command-line
  title: The Gezel Command Line
  order: 2
---

# Gezel in Docker

The Gezel image is the whole of Gezel in one container: the service, the web
version of the workshop, the command line, and every engine that runs models
on your own hardware. Nothing else needs installing. What it downloads is
models: the one you choose, and smaller ones it uses to search your files and
to read pictures, along with a web browser for tasks that visit websites.

You need Docker. On Linux, Docker Engine; on Windows and macOS, Docker
Desktop works too, with the limits under [Good to know](#good-to-know).

## Your workshop in a browser

```sh
docker run -d --name gezel -p 127.0.0.1:6228:6228 -v gezel:/gezel ghcr.io/bendyline/gezel
docker logs gezel
```

The log ends with a link like `http://localhost:6228/?setup=…`. Open it, pick
a name and a password, and you have the first account on this Gezel. The link
works once, for an hour; if it runs out, run `docker logs gezel` again after
opening `http://localhost:6228`, and a new one appears.

Everything Gezel keeps (your crew, projects, chats, memories and models)
lives in the `gezel` volume, so removing the container and starting a new one
picks up where you left off.

### With a graphics card

| Your GPU | Add to the command | Use the image |
| --- | --- | --- |
| NVIDIA | `--gpus all` | `ghcr.io/bendyline/gezel:cuda` |
| AMD or Intel | `--device /dev/dri --group-add video --group-add $(getent group render \| cut -d: -f3)` | `ghcr.io/bendyline/gezel:vulkan` |

NVIDIA needs the NVIDIA driver and the NVIDIA Container Toolkit on the
computer running Docker. Gezel checks the card when it starts and falls back
to the processor when it cannot use it.

## Local AI for your other apps

Your other programs can use Gezel's models through the same kind of web
address they would use for OpenAI. Make a key for each program:

```sh
docker exec gezel gezel integrations token create my-notebook
```

Then point the program at `http://localhost:6228/v1` with that key. The key
appears in Settings → Integrations, where you can see when it was last used
and revoke it. To have a model ready without opening the workshop, name it
when you start the container:

```sh
docker run -d --name gezel -p 127.0.0.1:6228:6228 -v gezel:/gezel \
  -e GEZEL_PULL_MODEL=<model id> ghcr.io/bendyline/gezel
```

`docker exec gezel gezel model list --available` lists the model ids.

## Put the crew to work on a folder

To run one craftbook on the folder you are in and collect what it makes:

```sh
docker run --rm -v "$PWD:$PWD" -w "$PWD" -v gezel:/gezel ghcr.io/bendyline/gezel \
  do summarize-long "Summarize these notes for the board" --out ./gezel-out
```

Mounting the folder at the same path inside the container keeps each folder
its own project. Gezel reads the folder and writes its results to
`./gezel-out`; it changes nothing else there.

A Windows path cannot be used inside the container, so in PowerShell give
the folder a path of its own there, named after it:

```powershell
docker run --rm -v "${PWD}:/projects/board-notes" -w /projects/board-notes -v gezel:/gezel ghcr.io/bendyline/gezel `
  do summarize-long "Summarize these notes for the board" --out ./gezel-out
```

If a Gezel container is already running on the same volume, use it instead
of starting a second one (Gezel refuses to run twice on one volume):
mount your folders when you start it, then run `docker exec gezel gezel do …`.

## People and passwords

Everyone who signs in has an account. Add people in Settings → Accounts, or
from the computer running Docker:

```sh
docker exec -it gezel gezel account create Ana
```

**Everyone you add can do everything you can**, including open a terminal
in the container. Add only people you would hand the keys to.

If someone forgets their password, anyone who can sign in can set a new one
in Settings → Accounts. If nobody can sign in, set one from the computer
running Docker:

```sh
docker exec -it gezel gezel account reset-password Ana
```

To start without the setup link (for a server you set up by script), give
the first account's name and keep its password in a file:

```sh
docker run -d --name gezel -p 127.0.0.1:6228:6228 -v gezel:/gezel \
  -e GEZEL_OWNER_NAME=you -e GEZEL_OWNER_PASSWORD_FILE=/run/secrets/owner \
  -v ./owner-password.txt:/run/secrets/owner:ro ghcr.io/bendyline/gezel
```

## Security level and activity

A new container starts at the `lockdown` [security level](security-model.md)
and in the **Reactive + tasks** [activity mode](gezel-on-a-server.md#choose-the-activity-mode):
the crew answers, runs the tasks you start and keeps to schedules, but does not
start work of its own, which on a server would compete with your requests.
To start differently, set them for the first start:

```sh
-e GEZEL_INITIAL_SECURITY_LEVEL=super-lockdown -e GEZEL_INITIAL_MODE=reactive+tasks
```

They apply only to a new volume. After that, change them in Settings or with
`docker exec gezel gezel security level set …` and `docker exec gezel gezel mode …`.

## Reaching it from other devices

The commands above keep Gezel on the computer running Docker. To use it from
a phone or another computer on your network, put HTTPS in front of it. The
`docker/` folder of the Gezel repository has a Compose setup that does this
with Caddy:

```sh
GEZEL_HOSTNAME=gezel.home docker compose -f compose.yaml -f compose.lan.yaml up -d
```

Caddy signs with its own certificate, which other devices warn about until
you install Caddy's root certificate on them. Gezel answers only at the name
you give it.

## Updating

Pull the new image and start a new container on the same volume:

```sh
docker pull ghcr.io/bendyline/gezel
docker rm -f gezel
docker run -d --name gezel -p 127.0.0.1:6228:6228 -v gezel:/gezel ghcr.io/bendyline/gezel
```

Image versions match the [command line's](cli-reference.md): `ghcr.io/bendyline/gezel:1.2.12`
is the same Gezel as `npm install -g @bendyline/gezel-cli@1.2.12`. The first
image is 1.2.12. The same images are on Docker Hub as `bendyline/gezel`.

Back up the `gezel` volume like any other data. It holds plain files; see
[Where files live](where-files-live.md).

## Good to know

- **The Gezel app uses port 6228 too.** If it runs on the same computer,
  publish another port and tell the container the address to print in its
  setup link:
  `-p 127.0.0.1:6300:6228 -e GEZEL_PUBLIC_URL=http://localhost:6300`, then
  open `http://localhost:6300`.
- **On a Mac, Docker cannot use the graphics chip**, so models run on the
  processor and are slow. Use the Gezel app on a Mac.
- **Docker Desktop on Windows** passes NVIDIA cards through; it has no
  Vulkan, so AMD and Intel cards are not used there.
- **The NVIDIA image for ARM computers** is built for DGX Spark (GB10).
- **Files Gezel writes into a folder you mounted** belong to user 10001.
  Add `--user "$(id -u):$(id -g)"` to keep them yours.
- **Some craftbook steps run small scripts that must not reach the
  network.** The image runs them in a network sandbox. If a step says no
  sandbox is available, update to a newer image.
