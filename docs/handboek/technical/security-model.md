---
id: security-model
title: "The security model: tokens, sandboxing, and consent"
order: 5
summary: The guardrails between your crew and your computer.
subcategory:
  id: how-gezel-works
  title: How Gezel works
  order: 1
---
# The security model

Giving AI hands means deciding, carefully, what those hands may touch.

**It is important to note: gezel is still in early beta.** Undoubtedly there are still security flaws or broader design holes in the security regimen of gezel.

**Our security model is not designed to be perfect.** In many places, the security design focuses on keeping honest models honest via layers of "defense in depth". This lets gezel still be useful without requiring you to make every fiddly technical security decision, and without requiring exotic and complicated isolation mechanisms (e.g., containers). Think of the security design like multiple 5-foot-tall chain-link fences: it keeps things corralled, but a determined attacker (a purpose-built malicious program already on your machine) could hop over them.

Also, most of this guidance applies whenever a model acts through gezel's own tools — local models and direct API providers (OpenAI and Anthropic keys) alike. If you work through the Claude CLI, Codex CLI, or GitHub Copilot, those harnesses run their own tool loops under their own security designs: gezel configures them — permission modes, sandbox settings — but the enforcement is theirs. Like us, those providers put a lot of work and thought into securely managing threads, but flaws can happen anywhere.

## How gezel secures a model's hands

Gezel layers its guardrails:

### The service is locked to your machine

The background service listens only on your computer, over an encrypted
loopback channel, and requires a credential that rotates every time the
service starts. The desktop app also pins the service's certificate. These
controls keep the service off your local network and reject clients that do
not have a current credential.

They are not a wall against malicious software already running as **your**
operating-system account, or against an administrator. Software with those
powers can generally read files your account can read, including Gezel's
user-scoped connection details. The separately installed machine engine has a
credential that local user daemons can discover by design, but that credential
is limited to inference and model management — it cannot read projects,
gezellen, chats, tools, or credentials.

### Workspaces have walls

A gezel using Gezel's workspace tools sees that project's workspace — not your
whole disk. Paths those tools receive are checked against the workspace
boundary before a file is read or written, so "../" tricks and symlink hops
end at the wall. Provider-native tools and explicitly approved full-trust
commands are different execution classes; their limits are described below.

### Scripts run in layered isolation

Gezel's **sandboxed standalone-script tools** run code in a separate process
wrapped in several independent layers:

- **Its own small world.** The script gets a fresh scratch area, and its writes are confined to that area and the project workspace — not your disk. Node's permission model checks the file boundary as one layer of the sandbox.
- **No calling for backup.** The script can't launch other programs, spawn workers, or load native extensions. A script also can't quietly open its own connection to the internet — when a gezel needs the web, it goes through gezel's named tools (search, fetch, the browser), which are policy-checked and show up in History. In most configurations, whatever a gezel does, it does alone, inside the fence of the project workspace.
- **The operating system holds the outer wall where it can.** Untrusted code that must run without network access starts only when Gezel can apply a supported OS boundary — macOS Seatbelt, or a probed systemd boundary for compatible Linux jobs. Otherwise Gezel refuses to start it. One narrow compatibility path exists for byte-verified first-party scripts shipped in Gezel's standard library or catalog: on Windows and Linux jobs that cannot use the OS boundary, those trusted bytes may run with the remaining filesystem limits, subprocess/worker/addon denial, environment scrubbing, and JavaScript network-denial layers. Edited, user-authored, and model-authored scripts do not receive that exception.
- **A time and memory leash.** Every run has a deadline and can be capped on memory, so a runaway script gets stopped instead of dragging your machine down.

The layers deliberately overlap, but they are defense in depth rather than a
promise that hostile code can never escape.

Some tools deliberately run with more authority. After showing the exact
command and receiving your approval, **package scripts and installed package
binaries** (`run_package_script` and `run_npx`) run as your operating-system
account. They may start other programs, use the network, and read or change
files outside the project. A persistent approval is tied to the exact command,
its arguments, and the content hashes of local inputs Gezel can identify — such
as `package.json`, a referenced script, relative static imports, or an installed
binary entry. Changing one of those files asks for approval again. Commands can
still discover files dynamically, load implicit configuration, resolve other
programs through `PATH`, use outside-project or directory/glob inputs, or fetch
code from the network, so this binding is not a complete dependency graph and
does not turn package commands into a sandbox.
Third-party MCP servers are also not inside the
standalone-script sandbox; because they are unconfined local or remote code,
Gezel enables them only under the corresponding Security & Compliance setting.

### Mutations need consent

Reading is cheap; changing things is not. Changes made through Gezel-managed
tools — project-file writes, git operations, and outward-facing actions — go
through the policy and per-project consent you control in Settings. Approving a
full-trust package command authorizes that command as a whole; Gezel cannot
separately mediate every side effect produced inside it. Git itself stays
yours in the default managed workflow: gezellen work in your working copy while
you control commits, branches, and pushes. A full-trust command can perform any
of those operations if the command you approve includes them.

### Prefer mediated connections to services

Being useful means connecting to services like e-mail or data systems.
Wherever possible, Gezel keeps that connection in a named, policy-checked
connector or tool and gives the model a file or a narrow operation instead of
the raw credential. For example, e-mail can arrive as files in the workspace,
and sending uses a reviewed request.

That is the preferred path, not a universal guarantee. An approved full-trust
package command or an enabled third-party MCP server can make its own network
connections. Provider-native tools follow that provider's security and
permission model.

### Leverage the node.js/NPM open source ecosystem

At your direction, Gezel can download additional scripts and tools from NPM
(the Node.js package catalog). NPM is widely used, but it is not perfect and
has experienced compromises. Gezel installs packages with their install-time
scripts disabled, preventing that common supply-chain execution path.

Gezel's ordinary install flow accepts packages from the NPM registry only: a
package name plus a version, semver range, or dist-tag. It does not accept a
URL, Git repository, local file or directory, workspace reference, package
alias, or command-line option in that field. Installs can target only the
private package directory of an existing project; project identifiers and the
resolved destination are checked before the package manager starts. Alternate
package sources would need a separate, explicitly approved feature with their
own network and path protections.

What happens later depends on the tool type. A standalone script uses the
sandbox described above. A package command runs with your account's authority
after explicit approval. A third-party MCP server is unconfined and requires
the security posture that permits non-builtin toolsets. Review the package,
publisher, requested capabilities, and exact command before granting that
authority.

### What History records

Gezel writes durable History events for project and crew changes and for tool
completions it can observe. Calls through Gezel's own MCP bridge have the
strongest coverage. Provider-native tool loops — such as Claude CLI, Codex CLI,
or GitHub Copilot — are recorded when their SDK or event stream exposes enough
information, so a missing History entry is not proof that an external provider
performed no action.

Copilot's built-in tools are disabled by default in favor of Gezel's scoped MCP
tools. The explicit `sandboxCopilot: false` compatibility setting restores those
built-ins. Their observed completions may still appear in History, but they do
not receive Gezel's MCP scope and action-level sink checks, and their audit
detail can be incomplete.

History is a useful, user-owned local activity record. It is not a
tamper-evident compliance ledger.
