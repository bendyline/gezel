import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  HttpStatusError,
  PNPM_HOISTED_NODE_LINKER,
  type ToolsetManifest,
  resolvePnpmInvocation,
  retryTransient,
} from '@bendyline/gezel';
import * as tar from 'tar';

const DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const MAX_PACKUMENT_BYTES = 5 * 1024 * 1024;
const MAX_TARBALL_BYTES = 100 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 500 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 50_000;
const REGISTRY_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 2 * 60_000;
const INSTALL_TIMEOUT_MS = 5 * 60_000;
/** Registry reads are retried on transient faults; a toolset install shouldn't
 * die because one packument request lost a packet. The tarball write opens
 * with 'wx' and unlinks on failure, so re-running it is safe. */
const NETWORK_ATTEMPTS = 3;

export interface NpmInstallOptions {
  manifest: ToolsetManifest & { runtime: { kind: 'npm-package' } };
  installRoot: string;
  /** Test/private-registry override. Redirects remain pinned to this exact origin. */
  registry?: string;
}

export interface NpmInstallResult {
  installPath: string;
  tarballSha256: string;
}

export async function installNpmPackageToolset(opts: NpmInstallOptions): Promise<NpmInstallResult> {
  const { manifest } = opts;
  const { package: packageName, version, sha256: expectedHash, entry } = manifest.runtime;
  const registry = validateRegistry(opts.registry ?? DEFAULT_REGISTRY);
  const slug = `${packageName.replace('/', '__')}@${version}`;
  const target = join(opts.installRoot, slug);
  const staging = `${target}.staging-${process.pid}-${randomUUID()}`;
  const backup = `${target}.previous`;

  await mkdir(opts.installRoot, { recursive: true });
  await recoverInterruptedNpmInstall(target, backup);
  await mkdir(staging, { recursive: true });
  try {
    const tarballUrl = await retryTransient(
      () => resolveTarballUrl(packageName, version, registry),
      { attempts: NETWORK_ATTEMPTS, label: `${packageName}@${version} metadata` },
    );
    const tarballPath = join(staging, 'package.tgz');
    const actualHash = await retryTransient(
      () => downloadTarball(tarballUrl, tarballPath, registry.origin),
      { attempts: NETWORK_ATTEMPTS, label: `${packageName}@${version} tarball` },
    );
    if (actualHash !== expectedHash) {
      throw new Error(
        `[catalog] sha256 mismatch for ${packageName}@${version}: manifest=${expectedHash} actual=${actualHash}. Refusing to install.`,
      );
    }

    await extractNpmPackageTarball({
      tarballPath,
      destination: staging,
      expectedName: packageName,
      expectedVersion: version,
    });
    await rm(tarballPath, { force: true });

    const packageDir = join(staging, 'package');
    // Hoisted node-linker: the install happens in the staging dir and is
    // renamed into place by `publishStagedNpmInstall` — pnpm's default
    // isolated linker produces a tree that does not survive that rename
    // on Windows (see PNPM_HOISTED_NODE_LINKER's doc comment).
    const pnpm = resolvePnpmInvocation(
      [
        'install',
        '--prod',
        '--ignore-scripts',
        '--frozen-lockfile=false',
        PNPM_HOISTED_NODE_LINKER,
      ],
      {
        pnpmPath: process.env.GEZEL_PNPM_PATH,
        nodePath: process.env.GEZEL_NODE_PATH,
        processExecPath: process.execPath,
        platform: process.platform,
      },
    );
    await runAndWait(pnpm.command, pnpm.args, packageDir, pnpm.shell);
    await resolvePackageEntry(packageDir, entry);

    await publishStagedNpmInstall(staging, target, backup);
    return { installPath: join(target, 'package'), tarballSha256: actualHash };
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/** SHA-256 of a tarball on disk without buffering the archive in memory. */
export async function verifyTarballSha256(tarballPath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(tarballPath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function validateRegistry(input: string): URL {
  const registry = new URL(input.endsWith('/') ? input : `${input}/`);
  const loopback = registry.hostname === '127.0.0.1' || registry.hostname === 'localhost';
  if (
    (registry.protocol !== 'https:' && !(loopback && registry.protocol === 'http:')) ||
    registry.username ||
    registry.password
  ) {
    throw new Error(
      '[catalog] npm registry must be HTTPS (or loopback HTTP) without URL credentials',
    );
  }
  return registry;
}

async function resolveTarballUrl(
  packageName: string,
  version: string,
  registry: URL,
): Promise<string> {
  const url = new URL(encodePackumentPath(packageName), registry);
  const { response, dispose } = await fetchSameOrigin(url, registry.origin, REGISTRY_TIMEOUT_MS);
  try {
    if (!response.ok) {
      throw new HttpStatusError(
        response.status,
        `[catalog] registry returned HTTP ${response.status}`,
      );
    }
    const raw = await readBoundedBody(response, MAX_PACKUMENT_BYTES);
    let packument: { versions?: Record<string, { dist?: { tarball?: string } }> };
    try {
      packument = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new Error('[catalog] registry returned malformed package metadata');
    }
    const tarball = packument.versions?.[version]?.dist?.tarball;
    if (!tarball) throw new Error(`[catalog] version ${version} of ${packageName} was not found`);
    const parsed = new URL(tarball, registry);
    assertSameOrigin(parsed, registry.origin);
    return parsed.href;
  } finally {
    dispose();
  }
}

function encodePackumentPath(packageName: string): string {
  return packageName.startsWith('@') ? packageName.replace('/', '%2f') : packageName;
}

async function downloadTarball(url: string, dest: string, origin: string): Promise<string> {
  const { response, dispose } = await fetchSameOrigin(new URL(url), origin, DOWNLOAD_TIMEOUT_MS);
  const handle = await open(dest, 'wx', 0o600);
  let total = 0;
  const hash = createHash('sha256');
  try {
    if (!response.ok || !response.body) {
      throw new HttpStatusError(
        response.status,
        `[catalog] tarball download returned HTTP ${response.status}`,
      );
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_TARBALL_BYTES) {
      throw new Error('[catalog] tarball exceeds the 100 MiB download limit');
    }
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_TARBALL_BYTES) {
          throw new Error('[catalog] tarball exceeds the 100 MiB download limit');
        }
        hash.update(value);
        let offset = 0;
        while (offset < value.byteLength) {
          const written = await handle.write(value, offset, value.byteLength - offset);
          offset += written.bytesWritten;
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    return hash.digest('hex');
  } catch (err) {
    await rm(dest, { force: true }).catch(() => {});
    throw err;
  } finally {
    dispose();
    await handle.close();
  }
}

export async function extractNpmPackageTarball(opts: {
  tarballPath: string;
  destination: string;
  expectedName: string;
  expectedVersion: string;
}): Promise<string> {
  await inspectTarball(opts.tarballPath);
  await tar.extract({
    file: opts.tarballPath,
    cwd: opts.destination,
    strict: true,
    preservePaths: false,
  });
  const packageDir = join(opts.destination, 'package');
  await validateExtractedPackage(packageDir, opts.expectedName, opts.expectedVersion);
  return packageDir;
}

async function inspectTarball(path: string): Promise<void> {
  let entries = 0;
  let unpackedBytes = 0;
  await tar.list({
    file: path,
    strict: true,
    onentry: (entry) => {
      entries += 1;
      unpackedBytes += entry.size;
      if (entries > MAX_ARCHIVE_ENTRIES || unpackedBytes > MAX_UNPACKED_BYTES) {
        throw new Error('[catalog] package archive exceeds extraction limits');
      }
      validateNpmArchiveEntry(entry.path, entry.type);
    },
  });
}

export function validateNpmArchiveEntry(path: string, type: string): void {
  const withoutDot = path.startsWith('./') ? path.slice(2) : path;
  const clean =
    type === 'Directory' && withoutDot.endsWith('/') ? withoutDot.slice(0, -1) : withoutDot;
  const parts = clean.split('/');
  const hasWindowsUnsafeSegment = parts.some((part) => {
    const stem = part.split('.')[0]?.toUpperCase() ?? '';
    return (
      part.includes(':') ||
      part.endsWith(' ') ||
      part.endsWith('.') ||
      RESERVED_WINDOWS_BASENAMES.has(stem)
    );
  });
  if (
    clean.includes('\\') ||
    clean.includes('\0') ||
    clean.startsWith('/') ||
    parts[0] !== 'package' ||
    parts.some((part) => part === '..' || part === '' || part === '.') ||
    hasWindowsUnsafeSegment ||
    !['File', 'Directory'].includes(type)
  ) {
    throw new Error(`[catalog] unsafe package archive entry: ${path}`);
  }
}

async function validateExtractedPackage(
  packageDir: string,
  expectedName: string,
  expectedVersion: string,
): Promise<void> {
  const raw = await readFile(join(packageDir, 'package.json'), 'utf8');
  const parsed = JSON.parse(raw) as { name?: unknown; version?: unknown };
  if (parsed.name !== expectedName || parsed.version !== expectedVersion) {
    throw new Error('[catalog] extracted package identity does not match the pinned manifest');
  }
}

async function resolvePackageEntry(packageDir: string, entry: string): Promise<string> {
  const root = await realpath(packageDir);
  const candidate = await realpath(resolve(root, entry));
  const rel = relative(root, candidate);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error('[catalog] package entry escapes the installed package');
  }
  if (!(await stat(candidate)).isFile()) throw new Error('[catalog] package entry is not a file');
  return candidate;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) throw new Error('[catalog] registry returned an empty response');
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error('[catalog] registry metadata response is too large');
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('[catalog] registry metadata response is too large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

async function fetchSameOrigin(
  initial: URL,
  origin: string,
  timeoutMs: number,
): Promise<{ response: Response; dispose: () => void }> {
  let current = initial;
  for (let redirects = 0; redirects <= 3; redirects++) {
    assertSameOrigin(current, origin);
    const controller = new AbortController();
    // Abort with a reason: a bare abort surfaces as a generic AbortError, which
    // the retry layer deliberately treats as "the caller cancelled, stop". A
    // registry that ran out the clock is exactly the case worth another pass.
    const timer = setTimeout(
      () => controller.abort(new Error('[catalog] registry request timed out')),
      timeoutMs,
    );
    try {
      const response = await fetch(current, { redirect: 'manual', signal: controller.signal });
      if (response.status >= 300 && response.status < 400) {
        clearTimeout(timer);
        const location = response.headers.get('location');
        if (!location || redirects === 3) throw new Error('[catalog] invalid registry redirect');
        current = new URL(location, current);
        continue;
      }
      return { response, dispose: () => clearTimeout(timer) };
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }
  throw new Error('[catalog] too many registry redirects');
}

function assertSameOrigin(url: URL, origin: string): void {
  if (url.origin !== origin || url.username || url.password) {
    throw new Error('[catalog] refusing to send registry traffic to an untrusted origin');
  }
}

const RESERVED_WINDOWS_BASENAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

export async function publishStagedNpmInstall(
  staging: string,
  target: string,
  backup: string,
): Promise<void> {
  await rm(backup, { recursive: true, force: true });
  let hadTarget = false;
  try {
    await stat(target);
    hadTarget = true;
  } catch {
    /* fresh install */
  }
  if (hadTarget) await rename(target, backup);
  try {
    await rename(staging, target);
  } catch (err) {
    if (hadTarget) await rename(backup, target).catch(() => {});
    throw err;
  }
  await rm(backup, { recursive: true, force: true });
}

export async function recoverInterruptedNpmInstall(target: string, backup: string): Promise<void> {
  try {
    await stat(target);
  } catch {
    try {
      await rename(backup, target);
    } catch {
      /* no interrupted install */
    }
  }
}

function runAndWait(command: string, args: string[], cwd: string, shell: boolean): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      shell,
    });
    let output = '';
    let settled = false;
    const capture = (chunk: Buffer) => {
      if (output.length < 32_000) output += chunk.toString('utf8').slice(0, 32_000 - output.length);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish(new Error(`[catalog] dependency install exceeded ${INSTALL_TIMEOUT_MS}ms`));
    }, INSTALL_TIMEOUT_MS);
    timer.unref?.();
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolvePromise();
    };
    child.on('error', (err) => finish(err));
    child.on('close', (code) =>
      finish(
        code === 0
          ? undefined
          : new Error(`[catalog] dependency install failed (exit ${code}): ${output.trim()}`),
      ),
    );
  });
}

function killProcessTree(child: import('node:child_process').ChildProcess): void {
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    killer.once('error', () => child.kill('SIGKILL'));
    killer.unref();
    return;
  }
  if (child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      /* fall through */
    }
  }
  child.kill('SIGKILL');
}

/** Convenience for callers that want to persist the manifest alongside the install. */
export async function writeInstallMarker(
  installPath: string,
  manifest: ToolsetManifest,
): Promise<void> {
  const marker = join(dirname(installPath), '.gezel-install.json');
  const temp = `${marker}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(
    temp,
    JSON.stringify({ manifest, installedAt: new Date().toISOString() }, null, 2),
    { encoding: 'utf8', mode: 0o600 },
  );
  await rename(temp, marker);
}
