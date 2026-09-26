import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ExecFn, defaultExec, system32Tool } from './exec.js';

/**
 * Install / remove / check gezel's per-user Office CA in the USER's trust
 * store — never the machine's, so no administrator rights and nothing
 * another account inherits.
 *
 *   macOS   login keychain, trust setting "SSL: Always Trust" (`-p ssl`).
 *           The OS asks for the user's password once.
 *   Windows CurrentUser\Root through `certutil -user`. Windows shows its
 *           own "install this root certificate?" confirmation.
 *
 * Both prompts are the point: they must originate from the user's click in
 * Settings, never from a background reconcile.
 */

export interface TrustAnchor {
  caPem: string;
  /** Uppercase or lowercase hex; normalized here. */
  sha1Hex: string;
  commonName: string;
  /** The listener's leaf, when known: verified exactly as the Office webview would. */
  leafPem?: string;
}

export interface TrustDeps {
  exec?: ExecFn;
  platform?: NodeJS.Platform;
  homedir?: string;
  env?: NodeJS.ProcessEnv;
  tmpRoot?: string;
}

export function trustStoreSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

export function loginKeychainPath(home: string): string {
  return join(home, 'Library', 'Keychains', 'login.keychain-db');
}

export function buildDarwinAddTrustedArgs(pemPath: string, keychain: string): string[] {
  return ['add-trusted-cert', '-r', 'trustRoot', '-p', 'ssl', '-k', keychain, pemPath];
}

export function buildDarwinRemoveTrustedArgs(pemPath: string): string[] {
  return ['remove-trusted-cert', pemPath];
}

export function buildDarwinDeleteCertificateArgs(sha1Hex: string, keychain: string): string[] {
  return ['delete-certificate', '-Z', sha1Hex.toUpperCase(), keychain];
}

export function buildDarwinVerifyLeafArgs(leafPath: string): string[] {
  return ['verify-cert', '-c', leafPath, '-p', 'ssl', '-n', 'localhost', '-L', '-q'];
}

export function buildDarwinFindArgs(commonName: string, keychain: string): string[] {
  return ['find-certificate', '-a', '-Z', '-c', commonName, keychain];
}

/** `security find-certificate -Z` output → the SHA-1 hashes it lists. */
export function parseFindCertificateSha1(stdout: string): string[] {
  const out: string[] = [];
  for (const m of stdout.matchAll(/SHA-1 hash:\s*([0-9A-Fa-f]{40})/g))
    out.push(m[1]!.toLowerCase());
  return out;
}

export function buildCertutilAddArgs(pemPath: string): string[] {
  return ['-user', '-addstore', 'Root', pemPath];
}

export function buildCertutilDeleteArgs(sha1Hex: string): string[] {
  return ['-user', '-delstore', 'Root', sha1Hex.toLowerCase()];
}

export function buildCertutilQueryArgs(sha1Hex: string): string[] {
  return ['-user', '-store', 'Root', sha1Hex.toLowerCase()];
}

async function withTempFile<T>(
  name: string,
  content: string,
  deps: TrustDeps,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(deps.tmpRoot ?? tmpdir(), 'gezel-office-trust-'));
  const path = join(dir, name);
  try {
    await writeFile(path, content, { mode: 0o600 });
    return await fn(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const SECURITY = '/usr/bin/security';

export async function installTrust(anchor: TrustAnchor, deps: TrustDeps = {}): Promise<void> {
  const exec = deps.exec ?? defaultExec;
  const platform = deps.platform ?? process.platform;
  if (platform === 'darwin') {
    const keychain = loginKeychainPath(deps.homedir ?? homedir());
    await withTempFile('gezel-office-ca.pem', anchor.caPem, deps, (pem) =>
      exec(SECURITY, buildDarwinAddTrustedArgs(pem, keychain), { timeout: 5 * 60_000 }),
    );
    return;
  }
  if (platform === 'win32') {
    await withTempFile('gezel-office-ca.cer', anchor.caPem, deps, (pem) =>
      exec(system32Tool('certutil.exe', deps.env), buildCertutilAddArgs(pem), {
        timeout: 5 * 60_000,
      }),
    );
    return;
  }
  throw new Error(`Trusting the Office certificate is not supported on ${platform}.`);
}

export async function uninstallTrust(
  anchor: Pick<TrustAnchor, 'caPem' | 'sha1Hex'>,
  deps: TrustDeps = {},
): Promise<void> {
  const exec = deps.exec ?? defaultExec;
  const platform = deps.platform ?? process.platform;
  if (platform === 'darwin') {
    const keychain = loginKeychainPath(deps.homedir ?? homedir());
    await withTempFile('gezel-office-ca.pem', anchor.caPem, deps, (pem) =>
      exec(SECURITY, buildDarwinRemoveTrustedArgs(pem), { timeout: 5 * 60_000 }).catch(
        () => undefined,
      ),
    );
    await exec(SECURITY, buildDarwinDeleteCertificateArgs(anchor.sha1Hex, keychain)).catch(
      () => undefined,
    );
    return;
  }
  if (platform === 'win32') {
    await exec(system32Tool('certutil.exe', deps.env), buildCertutilDeleteArgs(anchor.sha1Hex), {
      timeout: 5 * 60_000,
    }).catch(() => undefined);
  }
}

/**
 * macOS: with a leaf, ask SecTrust to evaluate it for `localhost` — exactly
 * the question WKWebView asks. Without one, fall back to "is this exact CA in
 * the login keychain". Windows: is this thumbprint in CurrentUser\Root,
 * which is itself the trust decision.
 */
export async function isTrusted(anchor: TrustAnchor, deps: TrustDeps = {}): Promise<boolean> {
  const exec = deps.exec ?? defaultExec;
  const platform = deps.platform ?? process.platform;
  if (platform === 'darwin') {
    if (anchor.leafPem) {
      return withTempFile('gezel-office-leaf.pem', anchor.leafPem, deps, (leaf) =>
        exec(SECURITY, buildDarwinVerifyLeafArgs(leaf)).then(
          () => true,
          () => false,
        ),
      );
    }
    const keychain = loginKeychainPath(deps.homedir ?? homedir());
    const { stdout } = await exec(SECURITY, buildDarwinFindArgs(anchor.commonName, keychain)).catch(
      () => ({
        stdout: '',
        stderr: '',
      }),
    );
    return parseFindCertificateSha1(stdout).includes(anchor.sha1Hex.toLowerCase());
  }
  if (platform === 'win32') {
    return exec(
      system32Tool('certutil.exe', deps.env),
      buildCertutilQueryArgs(anchor.sha1Hex),
    ).then(
      () => true,
      () => false,
    );
  }
  return false;
}
