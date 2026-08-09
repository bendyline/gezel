# Remote access to the product API and web UI

How to reach a gezel daemon's full product surface (`/api/*`, `/v1/*`
Connected Apps, the web UI) from another machine: what works today, why the
direct path is blocked on purpose, and the design for first-class remote
access. **Remote inference between paired devices is a different, shipped
subsystem** (`packages/service/src/remotes/`, `/v1/remote/*`, LAN listener on
6229 with Ed25519 TOFU pairing) and is not this document's subject.

## Why a remote browser or client cannot connect directly

Three independent layers each block it — all deliberate:

1. **Bind.** The main listener hardcodes `127.0.0.1`
   (`service.ts` `bindOnce`); there is no host/bind knob for it.
2. **Host guard.** `hostGuard()` runs before auth and the static UI and 403s
   any non-loopback `Host` authority (`http/host-guard.ts`) — the
   DNS-rebinding defense. Even `/api/health` answers `forbidden_host` to a
   remote-addressed request.
3. **Trust + auth.** The per-launch self-signed cert carries loopback-only
   SANs, and the only browser credential flow is the `gezel start --web`
   one-time `?token=` URL; the Electron shell additionally pins the loopback
   cert fingerprint (`main.ts` verify proc) and defers to Chromium's default
   validation for any non-loopback origin — which rejects self-signed certs.

Consequence for supervisor Branch-1 remote mode (`service:{url,token}` in
`config.json`): pointing it at a bare `https://host:port` fails at every
layer above. It works only through a tunnel that lands on the remote
daemon's loopback.

## Supported interim: loopback-preserving tunnels

A tunnel (SSH `-L`, Tailscale toward loopback, or any TCP relay whose far
end connects to `127.0.0.1`) preserves both properties the daemon checks:
the connection arrives on loopback, and the browser/client addresses
`127.0.0.1`, so the `Host` header stays in the allowlist. Verified working
recipes:

### Full desktop app against a remote daemon (Branch 1)

On the remote host, run the daemon with plain-HTTP transport (safe **only**
because exposure stays loopback-to-loopback inside the tunnel; never bind
insecure transport to a routable interface):

```bash
GEZEL_INSECURE_TRANSPORT=1 gezel start --foreground
```

On the local machine:

```bash
ssh -L 6300:127.0.0.1:<remote-port> user@host
```

then set in local `~/.gezel/config.json` (the `service` key is
schema-declared and survives settings saves):

```json
{ "service": { "url": "http://127.0.0.1:6300", "token": "<remote ~/.gezel/runtime/auth-token>" } }
```

Plain HTTP is required for the Electron shell: Branch-1 remote mode carries
`cert: null`, and the renderer's verify proc refuses loopback TLS with no
pin — a tunneled `https://127.0.0.1:…` presenting the remote daemon's cert
is rejected. Plain HTTP never consults the verify proc; SSH provides the
transport crypto. Caveat: the token rotates on every remote daemon start —
re-copy it after a remote restart (durable remote credentials are
first-class-design scope, below). Misconfiguration stays loud by contract:
a failed probe is an error, never a silent fall-through to embedded mode.

### Browser web UI

On the remote host: `gezel start --web` (mints the `runtime/web-ui-token`
and prints a `?token=` URL on an HTTP loopback port). Tunnel that port, then
open `http://127.0.0.1:<tunnel-port>/?token=<web-ui token>` locally. The
token is scrubbed from the URL into localStorage on first load.

### CLI / SDK

`gezel --connect http://127.0.0.1:<tunnel-port> --token …` through the same
tunnel; the app-sdk accepts an explicit `baseUrl` the same way (with
`tlsCertPath` for a TLS daemon whose cert you copied — note the cert's SANs
are loopback names, which is exactly what a tunnel presents).

Tunnel limits, stated honestly: manual setup, a rotating token with no
per-client revocation (revoking = restarting the remote daemon), and no
remote-user identity — every tunnel holder is the same first-party client.

## First-class remote access (design)

Target: a device or browser connects to `https://<machine>:<port>` directly,
authenticates as a principal, and gets a revocable credential — no tunnel.
Build order is gated on the accounts ADR
([0004](decisions/0004-accounts-and-project-acls.md)): remote principals are
accounts, and shipping remote product access on today's
machine-wide-trust model would freeze that model into the wire contract.

1. **Listener.** A third listener (or an opt-in non-loopback bind of a
   dedicated product listener) following the `remoteServing` pattern:
   explicit enable, IP-literal bind validation, separate allowlist app that
   mounts the product surface deliberately — never a flag that widens the
   loopback app. `hostGuard` gains an exact-allowlist of operator-configured
   names only if name-based addressing is required; IP literals stay the
   default (DNS-rebinding stance unchanged).
2. **Transport trust.** Two candidate shapes: (a) longer-lived cert with the
   machine's names/IPs in SANs, pinned by gezel-native clients exactly like
   device pairing pins the inference listener today (`pinned-fetch.ts`); or
   (b) a local CA whose root the client enrolls once. Browsers push toward
   (b) or toward gezel-native pairing UX in the desktop shell; the Electron
   pin must then carry a real `cert` for Branch-1 targets instead of `null`
   (`supervisor/mode.ts`).
3. **Credentials.** Durable named remote credentials as a grant class
   through the existing Connected-Apps consent flow (`kind: 'device'` for
   gezel clients; a `remote-ui` grant for browsers), bound to an account
   principal per ADR 0004, listed and revocable in Settings — replacing the
   rotating runtime token for remote use entirely. The verification-code
   handshake already used for `product`/`cli` scopes covers the pairing
   confirmation.
4. **Session lifetime.** Browser sessions get expiry + refresh against the
   grant, so revoking the grant kills the session; the one-time `?token=`
   URL pattern stays local-only.

Non-goals, restated from the boundary docs: the machine-engine broker never
serves the product API or UI, on any interface; remote product access is a
user-daemon (or dedicated product-listener) concern; compute sharing and
data sharing remain independent.
