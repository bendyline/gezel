/**
 * The runtime discovery directory and the service-role decision.
 *
 * Both answer "what is this daemon, and how do local clients reach it?" —
 * `~/.gezel/runtime/` is the only state a machine-scope daemon exposes to
 * other accounts, so its permission handling is deliberate rather than left
 * to the service manager's umask.
 */
import { chmod, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type ServiceRole, createLogger } from '@bendyline/gezel';
import type { gezelPaths } from '@bendyline/gezel/paths';
import type { LoopbackCert } from './http/cert.js';

const log = createLogger('service');

export async function writeRuntime(args: {
  paths: ReturnType<typeof gezelPaths>;
  port: number;
  token: string;
  pid: number;
  cert: LoopbackCert | null;
  webUiToken: string | null;
  serviceRole: ServiceRole;
}): Promise<void> {
  const isSystemScope = process.env.GEZEL_SYSTEM_SCOPE === '1';
  const discoveryMode = isSystemScope ? 0o644 : 0o600;
  // Do not rely on the service manager's umask for discovery metadata.
  // Machine-wide brokers run with umask 0077 so all non-runtime state stays
  // private, while user daemons still need the discovery files to adopt the
  // loopback engine. Per-user daemons keep them owner-only.
  await writeFile(args.paths.runtime.port, `${args.port}\n`, {
    encoding: 'utf8',
    mode: discoveryMode,
  });
  await writeFile(args.paths.runtime.pid, `${args.pid}\n`, {
    encoding: 'utf8',
    mode: discoveryMode,
  });
  try {
    await chmod(args.paths.runtime.port, discoveryMode);
    await chmod(args.paths.runtime.pid, discoveryMode);
  } catch {
    /* windows, or a filesystem that doesn't care */
  }
  const rolePath = join(dirname(args.paths.runtime.port), 'service-role');
  await writeFile(rolePath, `${args.serviceRole}\n`, {
    encoding: 'utf8',
    mode: discoveryMode,
  });
  try {
    await chmod(rolePath, discoveryMode);
  } catch {
    /* windows, or a filesystem that doesn't care */
  }
  // This is the first-party client credential, never the daemon root
  // credential. Per-user installs lock it to 0600. System-scope installs
  // use 0644 on POSIX because user daemons run as different accounts; the
  // engine broker itself is deliberately unprivileged in that mode.
  // Unlink before exclusive creation. On Windows, overwriting a file keeps
  // its existing DACL and owner; a planted runtime credential could
  // otherwise retain permissions inherited before installer hardening.
  // `wx` also fails closed if another process races us with a file/symlink.
  await rm(args.paths.runtime.token, { force: true });
  await writeFile(args.paths.runtime.token, args.token, {
    encoding: 'utf8',
    mode: discoveryMode,
    flag: 'wx',
  });
  try {
    await chmod(args.paths.runtime.token, discoveryMode);
  } catch {
    /* windows, or a filesystem that doesn't care */
  }
  // Web-UI token: write it with the same first-party credential handling
  // when web mode is on, and proactively clear
  // any stale file from a prior web launch when it's off, so the runtime
  // dir never advertises a token that isn't live.
  if (args.webUiToken) {
    await rm(args.paths.runtime.webUiToken, { force: true });
    await writeFile(args.paths.runtime.webUiToken, args.webUiToken, {
      encoding: 'utf8',
      mode: discoveryMode,
      flag: 'wx',
    });
    try {
      await chmod(args.paths.runtime.webUiToken, discoveryMode);
    } catch {
      /* windows tolerance, as above */
    }
  } else {
    await rm(args.paths.runtime.webUiToken, { force: true }).catch(() => {});
  }
  if (args.cert) {
    // Public cert PEM is always world-readable — it's the trust anchor
    // any local CLI / curl needs to talk to us. The private key never
    // touches disk; it lives in process memory only and rotates with
    // the daemon. Fingerprint is what the supervisor pins in Electron.
    await writeFile(args.paths.runtime.cert, args.cert.certPem, 'utf8');
    await writeFile(args.paths.runtime.fingerprint, `${args.cert.sha256Hex}\n`, 'utf8');
    try {
      await chmod(args.paths.runtime.cert, 0o644);
      await chmod(args.paths.runtime.fingerprint, 0o644);
    } catch {
      /* same windows tolerance as above */
    }
  } else {
    // A daemon may be restarted with GEZEL_INSECURE_TRANSPORT=1 after an
    // HTTPS launch. Discovery treats cert presence as the transport signal,
    // so stale public material would make clients attempt HTTPS against the
    // new HTTP listener.
    await Promise.all([
      rm(args.paths.runtime.cert, { force: true }),
      rm(args.paths.runtime.fingerprint, { force: true }),
    ]);
  }
}

export async function resolveEffectiveServiceRole(
  explicit: ServiceRole | undefined,
  env: NodeJS.ProcessEnv,
  home: string,
): Promise<ServiceRole> {
  const configured = env.GEZEL_SERVICE_ROLE;
  const systemScope = env.GEZEL_SYSTEM_SCOPE === '1';
  const requested =
    explicit ??
    (configured === 'user' || configured === 'machine-engine' || configured === 'legacy-full'
      ? configured
      : // A system-scope launch whose host named no role is a misconfigured
        // host, not a pre-split one, and the two are indistinguishable from
        // here. Resolve to the LEAST authority and let the established-state
        // check below promote it back to legacy-full only on the evidence a
        // real pre-split home leaves behind.
        //
        // This defaulted to `legacy-full` and that failed open. v1.26217.38
        // shipped a Windows service host compiled before GEZEL_SERVICE_ROLE
        // existed (the native pin was not bumped for the release that added
        // it), so every Windows machine service silently took this branch,
        // served the full product API, and published its `ui`-scoped token at
        // the cross-account permissions the runtime directory grants — a
        // credential every local account can read. Nothing failed; the split
        // simply never engaged. Least authority is the only safe default when
        // the role is unstated.
        systemScope
        ? 'machine-engine'
        : 'user');

  if (requested !== 'machine-engine' || !systemScope) return requested;

  // If an older full-product system service already has a product layout,
  // never relabel it as engine-only: the next Electron launch would otherwise
  // show an empty per-user home while established machine-home projects remain
  // hidden behind the broker boundary.
  if (await hasEstablishedMachineProductState(home)) {
    log.warn(
      '[service] established machine-home product state detected; preserving legacy-full compatibility until an explicit per-user migration is completed',
    );
    return 'legacy-full';
  }
  return requested;
}

/**
 * Does this system home still hold pre-split product data that a broker would
 * strand?
 *
 * Directory presence alone is NOT the signal, because `legacy-full` itself
 * creates the `default` project and the system crew on every boot. Keying on
 * presence made the compatibility mode self-perpetuating: one boot in
 * legacy-full manufactured the exact evidence that pinned every later boot to
 * legacy-full, so a home could never return to the broker role even once its
 * real data had been migrated out.
 *
 * The signals are the two things only a human produces: a project beyond the
 * auto-created `default`, or a gezel with a persisted session. That is the
 * same "was this home ever actually used" question the supervisor answers in
 * `readHomeUsageSignals`, and deliberately the same answer shape.
 *
 * Deliberately NOT keyed on the machine-shared marker. The marker resolves
 * from platform convention rather than from `home`, so it reports on whatever
 * machine-wide install happens to exist rather than on the home being
 * inspected — wrong for a per-user daemon, and wrong for any home that is not
 * the conventional system one. The usage signals already answer correctly
 * after a migration, because what migration leaves behind is exactly baseline.
 */
async function hasEstablishedMachineProductState(home: string): Promise<boolean> {
  const projects = await listSubdirectories(join(home, 'projects'));
  if (projects.some((name) => name !== 'default')) return true;

  for (const gezelId of await listSubdirectories(join(home, 'gezels'))) {
    const sessions = await listFileNames(join(home, 'gezels', gezelId, 'sessions'));
    if (sessions.some((name) => name.endsWith('.json'))) return true;
  }
  return false;
}

async function listSubdirectories(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function listFileNames(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}
