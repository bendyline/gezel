---
id: what-leaves-this-computer
title: "What leaves this computer"
order: 5.5
summary: Every kind of network traffic Gezel can make, and which security level allows it.
subcategory:
  id: how-gezel-works
  title: How Gezel works
  order: 1
---

# What leaves this computer

Gezel has no Bendyline account and no Bendyline server between you and your work. Your projects, chats and files stay on this machine unless something on this page sends them somewhere. Below is every kind of traffic Gezel can make, what it carries, and which of the three security levels allows it.

You choose the level in **Settings → Security & compliance**, or with `gezel security level set <level>` on the command line. A new install starts at `lockdown`.

## The table

| Traffic | What it carries | `super-lockdown` | `lockdown` | `free` |
| --- | --- | --- | --- | --- |
| Local models (llama.cpp, MLX, DwarfStar, Ollama) | Nothing leaves; the model runs on this machine | Allowed | Allowed | Allowed |
| Cloud model providers (API keys, Claude and Codex command-line tools, Copilot) | Your conversation, and any files Gezel reads in it, to the provider you chose | **Blocked** | Allowed | Allowed |
| Web search, Wikipedia lookups, and pages a gezel opens on its own | What Gezel searches for or the address it opens | **Blocked** | **Blocked** | Allowed |
| Saved web pages: sites a project follows, a web address in a message you send, and links a gezel asks for from a followed site | Requests for those pages, with your saved sign-in for a site you signed in to | **Blocked** | Allowed, and followed sites refresh on their own | Allowed, and followed sites refresh on their own |
| Mail sync and sending | Your mailbox, to and from your mail provider | **Blocked** | **Blocked** | Allowed |
| Connectors (mail, calendars, issue trackers and similar) | The connected account's data, copied into the project | **Blocked**: no data moves | When you start a sync; connections that only read, such as feeds and wikis, also refresh on their own | Also syncs in the background |
| Repositories a gezel clones | The repository's address, to the code host | **Blocked** | Public code hosts only: GitHub, GitLab, Bitbucket, Codeberg, Gitea and SourceHut | Any host |
| Third-party toolsets (community MCP servers) | Whatever that toolset sends; it is outside code Gezel cannot confine | **Blocked** | **Blocked** | Allowed |
| Package scripts Gezel runs (`npm run`, `npx`) | Whatever the script sends; package scripts run with network access | **Blocked** | **Blocked** | Allowed |
| Automatic update checks (the app, and live catalog updates if you turn them on) | Version checks to Gezel's GitHub releases and to npm | **Blocked** | Allowed | Allowed |
| Downloads you start: models, on-device engines, knowledge catalogs, page libraries | Requests for those files, from Hugging Face, Gezel's GitHub releases and npm | Allowed | Allowed | Allowed |
| Models Gezel downloads on its own when it first needs them: the text search model, and an image reader for an on-device chat model that cannot read images | Requests for those model files, from Hugging Face | Allowed | Allowed | Allowed |
| Search models Gezel downloads on its own: the relevance model and the media-search model | Requests for those model files, from Hugging Face | **Blocked** | Allowed | Allowed |
| Page libraries Gezel downloads on its own the first time a page needs one (three.js, Chart.js, React and others) | Requests for those packages, from npm | **Blocked** | Allowed | Allowed |
| Catalog updates you turn on: installed knowledge catalogs, and live catalog content | Requests for the new versions, from Hugging Face and npm | **Blocked** | Allowed | Allowed |
| First-start tool setup | Downloads of the browser-automation tools from npm and Playwright | Allowed | Allowed | Allowed |

The levels are presets. **Settings → Security & compliance** can turn individual switches on or off; a combination that matches no preset is shown as **Custom**.

## What the rows mean

**Local models** never send your words anywhere. A downloaded model runs in an engine on this machine, and Gezel treats Ollama, which you run yourself, the same way.

**Cloud model providers** receive what you would send them using their own product, under their terms. Gezel talks to them directly from this machine and adds no middleman. At `super-lockdown`, the service refuses to start a cloud chat at all, whichever path asks for one.

**Web search and pages a gezel opens on its own** carry what Gezel is researching. They are the main reason `lockdown` and `free` differ: a model that can reach the open web can be steered by what it reads there, so this is off by default.

**Saved web pages** are fetched by the service, not the model, and Gezel works from the saved copies. At `lockdown` and `free`, sites a project follows refresh on a schedule. A web address you write in a message is saved when you send it, unless you press **×** on the line above the message box first. A gezel can ask for a page only when it is a link Gezel already found on a site the project follows, and you can make it ask you every time instead. Turning off **App network** in **Settings → Security & compliance** stops all of this. [Saved web pages](../conceptual/saved-web-pages.md) has the details.

**Connectors** are run by the service, not the model. The service holds the credential, fetches the data and writes it into the project as files Gezel reads. At `lockdown`, a connection that can send or post moves data only when you start a sync, while one that only reads, such as a feed or a wiki, also refreshes on its own. At `free` every connection keeps itself in sync. Some connection types download the component they run from npm when you first connect them.

**Repositories a gezel clones** go to the code host as an address. At `lockdown` a gezel can clone over https from the six public code hosts in the table, so reviewing a public repository keeps working; any other host needs `free`.

**Third-party toolsets and package scripts** are code Gezel did not write and cannot sandbox, so they may reach the network whatever they like. They are available at `free` only. (One narrow exception: Gezel's own local preview browser may run at lower levels, locked to pages inside your project.)

**Update checks** carry a version number, not your work. You can also turn off automatic update checks on their own, without changing the level.

**Downloads you start** fetch files; they do not upload your work. Model files are checked against their published hashes, and the on-device engines against fingerprints built into the release you installed.

**Downloads Gezel starts on its own** also fetch files and upload nothing. The text search model comes the first time Gezel needs it to search your files or memories by meaning. An image reader comes with an on-device chat model that cannot read images, unless **Settings → Image recognition** is set to **Never**. The relevance model is on for new installs, and the media-search model is on unless you turn media search off in **Settings → Image recognition**; a new install waits for its first project to finish, or for background work to begin, before fetching it. Libraries for pages a gezel writes, such as three.js or Chart.js, come from npm the first time a page needs one; **Settings → More settings → Page libraries** can turn that off. The search models and page libraries follow the security level, so `super-lockdown` stops them.

**Catalog updates you turn on** download new versions of your installed knowledge catalogs, and new catalog content when live catalog updates are on (**Settings → About**). Both are off until you turn them on.

## What the levels do not change

- **Nothing goes to Bendyline.** No level sends your chats, files or usage to us. The Bendyline-published places Gezel contacts are its GitHub releases and its npm packages, for updates, engines and tools, and Bendyline's Hugging Face datasets, for knowledge catalogs.
- **Keys go only to their own service.** A provider key is sent to that provider and nowhere else. Gezel keeps keys in your operating system's keychain, or in an encrypted file in its own folder where no keychain exists.
- **The service answers only on this machine.** It listens on this computer alone unless you pair another device to it for remote inference.

[Local-first: your data stays on your disk](../conceptual/privacy-local-first.md) covers the same ground in plainer terms, and [The security model](security-model.md) explains how each level is enforced.
