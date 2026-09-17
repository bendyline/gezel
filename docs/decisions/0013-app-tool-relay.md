# 0013 — Apps register tools the daemon relays back to them

Status: Accepted (2026-09)

## Context

`@bendyline/gezel-app-sdk/host` lets an application host a gezel daemon and put
a crew to work inside its own product. The motivating case is a travel app with
a chat bot: it can now provision a model, install its `.gezapp`, and chat with
the guide it created. What it could not do is let that guide *act on the app's
own state* — award travel points, open a booking, mark a place visited.

Everything a gezel can already do goes through a tool, so the question was only
how an application supplies one. Three shapes were available:

- **A sandboxed project script** ([docs/project-types.md](../project-types.md)'s
  script-tools). Excellent for logic that belongs to the project, useless here:
  the app's state lives in the app's process, behind its own data layer.
- **`SessionOpts.externalTools`**, the advertise-and-halt path `/v1/chat/completions`
  already uses. The provider halts on the first tool call and hands it back to
  the caller, who executes it and replays the history. That works for a caller
  that owns its whole agent loop, which is exactly what a stateful gezel
  session is not: halting the turn discards the session's tool loop, its
  transcript, and its continuation budget.
- **The app runs its own MCP server** and registers it as an `http-mcp` toolset.
  Wire-complete today. It asks every application to implement an MCP server,
  open a loopback port, and mint a bearer secret, and it puts the tools under
  `allowNonBuiltinToolsets`, a policy written for third-party servers the
  daemon spawns.

## Decision

The daemon hosts the MCP server on the application's behalf and relays each
call to it.

An app opens a **relay** (`POST /api/app-tools/relays`), holds one SSE stream,
and declares tools against a project. For every matching session, the chat
manager adds one bridge whose transport is an in-process linked pair
(`kind: 'in-memory'` on `McpServerSpec`); the server half lists the declared
tools and, on a call, emits `tool_call` up the app's stream and waits for
`POST …/calls/:callId/result`.

Three consequences make this the cheap shape rather than the clever one:

- **Nothing about the tool surface is special-cased.** Timeouts, output caps,
  redaction, argument coercion, the unresolved-failure ledger, the `tool` chat
  event and the `tool.called` history entry all live in the bridge and pool, so
  an app tool gets every one of them by being a bridge at all.
- **One path for hosted and external daemons.** The app talks HTTP either way,
  so an app that hosts its own daemon and one that connects to the user's Gezel
  run identical code.
- **The app implements a function, not a server.** No MCP dependency, no port,
  no secret to mint.

### Registrations are ephemeral, on purpose

A registration lives with its event stream plus a short grace window, and is
never written to disk. It is a claim that the app is standing by to answer, and
no restart of either side can carry that claim across. A persisted registration
would advertise a tool whose handler is gone — the model calls it, waits out the
timeout, and learns nothing. A missing tool is strictly better than a tool that
cannot answer.

Two smaller rules follow from the same reasoning: a call against a disconnected
app fails immediately rather than queueing (the model is blocked on it, and the
honest answer now beats the same answer after a timeout), and a result that
arrives after its call timed out is refused rather than applied.

### Relay tools bypass `allowNonBuiltinToolsets`

That ceiling exists because a third-party MCP server is code the daemon spawns
and cannot confine. A relay tool is code in the app's own process, running under
a grant the user approved for that app by name; only JSON arguments leave the
daemon. Gating it on a policy about spawned servers would deny the tools without
denying anything the policy is about.

They are withheld in two cases: a **visitor** session (app-serve) is an
untrusted guest of the project, and a provider that runs its own tool loop
outside our bridge (Copilot, the CLI providers) could never call them, so
advertising them would promise a call it cannot make.

### Session tokens may not register

A gezel's own MCP subprocess holds a `session` token. If it could register
tools, a gezel could grant itself any capability it liked with a user approval
attached to something else entirely. `/api/app-tools` refuses that scope
outright.

## Alternatives rejected

- **Extending `externalTools` to stateful sessions.** It halts the turn by
  design; making it not halt is rebuilding the bridge with fewer of its
  protections.
- **A short-circuit for hosted daemons.** An in-process app could hand the
  registry a function directly and skip HTTP. It would mean two code paths for
  the behaviour least likely to be tested twice, for a loopback round trip that
  costs nothing next to a model turn.
- **Persisting registrations.** See above: the failure it creates is silent and
  lands on the model.

## Consequences

- `McpServerSpec` gains a third kind. Every site that narrowed "not http ⇒
  stdio" was corrected to narrow on `isStdioSpec`; a spec carrying a live
  function must never reach the Claude CLI worker, which is a structured clone
  away.
- Tools registered after a session opened appear on the next turn: the project's
  app-tool surface is fingerprinted onto `LiveSessionState`, and the existing
  drift check rebuilds when it moves.
- App tool descriptions reach the system prompt, capped at 1000 characters each.
