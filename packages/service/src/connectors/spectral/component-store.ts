/**
 * Published Prismatic components, downloaded when a connection that needs
 * one is made (`connectorComponentsDir`). A Spectral type's manifest pins the
 * package exactly — name, version, tarball and entry hashes, the SDK range
 * it was published for, its license — and nothing runs unless every pin
 * holds:
 *
 * - the tarball's SHA-256 matches before anything is extracted;
 * - the package has no dependencies of any kind, so nothing is installed and
 *   no install script can run (the runner's own SDK serves its imports);
 * - the license and SDK range are the ones the manifest reviewed, and the
 *   runner's pinned SDK satisfies that range;
 * - the entry file's hash matches, here and again in the runner before every
 *   spawn.
 *
 * Downloads are refused in store builds (which may not fetch code) and when
 * the security level keeps connector data off this computer's network.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative } from 'node:path';
import {
  KeyedLock,
  type SpectralComponentPin,
  createLogger,
  resolveDistributionProfile,
  satisfiesRange,
} from '@bendyline/gezel';
import {
  extractNpmPackageTarball,
  fetchPinnedNpmTarball,
  publishStagedNpmInstall,
  recoverInterruptedNpmInstall,
} from '@bendyline/gezel-catalog';
import { connectorComponentsDir } from '@bendyline/gezel/paths';

const log = createLogger('connectors');
const MARKER = '.gezel-component.json';
const DAY_MS = 24 * 60 * 60_000;

export interface InstalledComponent {
  /** The package folder (holds `package.json`). */
  dir: string;
  entry: string;
  entrySha256: string;
}

export interface ComponentPolicy {
  /** Why a download is refused right now, or undefined when it is allowed. */
  refusal(): Promise<string | undefined> | string | undefined;
}

export interface ComponentStoreOptions {
  home: string;
  /** Registry override for tests; production uses the public npm registry. */
  registry?: string;
  policy?: ComponentPolicy;
  /** The runner's pinned SDK version; read from the installed runner when absent. */
  sdkVersion?: string;
  now?: () => number;
}

export interface ComponentReadiness {
  package: { name: string; version: string };
  installed: boolean;
  /** When not installed: whether connecting will download it. */
  downloadable: boolean;
  reason?: string;
}

export class ComponentRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComponentRefusedError';
  }
}

interface Marker {
  pin: SpectralComponentPin;
  installedAt: string;
  lastUsedAt: string;
}

/** `@scope/name@1.2.3-<sha12>`, made safe as one folder name. */
export function componentFolderName(pin: SpectralComponentPin): string {
  return `${pin.name.replace('/', '__')}@${pin.version}-${pin.sha256.slice(0, 12)}`;
}

/** The runner's pinned SDK, resolved where the runner resolves it. */
export function runnerSdkVersion(): string {
  const require = createRequire(import.meta.url);
  const runner = require.resolve('@bendyline/gezel-connectors-spectral/run');
  const manifest = createRequire(runner)('@prismatic-io/spectral/package.json') as {
    version: string;
  };
  return manifest.version;
}

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

export class ComponentStore {
  private readonly root: string;
  private readonly locks = new KeyedLock();
  private readonly now: () => number;

  constructor(private readonly opts: ComponentStoreOptions) {
    this.root = connectorComponentsDir(opts.home);
    this.now = opts.now ?? Date.now;
  }

  folderFor(pin: SpectralComponentPin): string {
    return join(this.root, componentFolderName(pin));
  }

  /** The verified install for a pin, or undefined when it is missing or altered. */
  async resolveInstalled(pin: SpectralComponentPin): Promise<InstalledComponent | undefined> {
    const folder = this.folderFor(pin);
    const marker = await this.readMarker(folder);
    if (!marker || JSON.stringify(marker.pin) !== JSON.stringify(pin)) return undefined;
    const dir = join(folder, 'package');
    try {
      const entry = await this.entryPath(dir, pin.entry);
      if ((await sha256File(entry)) !== pin.entrySha256) {
        log.warn(
          `[connectors] ${pin.name}@${pin.version} changed on disk; it will be downloaded again`,
        );
        return undefined;
      }
    } catch {
      return undefined;
    }
    await this.touch(folder, marker);
    return { dir, entry: pin.entry, entrySha256: pin.entrySha256 };
  }

  async readiness(pin: SpectralComponentPin): Promise<ComponentReadiness> {
    const pkg = { name: pin.name, version: pin.version };
    if (await this.resolveInstalled(pin))
      return { package: pkg, installed: true, downloadable: true };
    const reason = await this.refusal(pin);
    return { package: pkg, installed: false, downloadable: !reason, ...(reason ? { reason } : {}) };
  }

  /** The verified install for a pin, downloading it first when needed. */
  async ensure(pin: SpectralComponentPin): Promise<InstalledComponent> {
    return this.locks.run(componentFolderName(pin), async () => {
      const ready = await this.resolveInstalled(pin);
      if (ready) return ready;
      const refusal = await this.refusal(pin);
      if (refusal) throw new ComponentRefusedError(refusal);
      return this.install(pin);
    });
  }

  /**
   * Remove installs no connection uses any more, a day after their last use,
   * and staging left by an interrupted download.
   */
  async prune(inUse: Iterable<SpectralComponentPin>, olderThanMs = DAY_MS): Promise<string[]> {
    const keep = new Set([...inUse].map(componentFolderName));
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch {
      return [];
    }
    const removed: string[] = [];
    for (const name of names) {
      const folder = join(this.root, name);
      const staging = name.includes('.staging-') || name.endsWith('.previous');
      if (!staging && keep.has(name)) continue;
      const marker = staging ? undefined : await this.readMarker(folder);
      const last = marker
        ? Date.parse(marker.lastUsedAt)
        : (await stat(folder).catch(() => undefined))?.mtimeMs;
      if (last !== undefined && this.now() - last < (staging ? 60 * 60_000 : olderThanMs)) continue;
      await rm(folder, { recursive: true, force: true }).catch(() => {});
      removed.push(name);
    }
    if (removed.length) log.info(`[connectors] removed ${removed.length} unused component(s)`);
    return removed;
  }

  private async refusal(pin: SpectralComponentPin): Promise<string | undefined> {
    const distribution = resolveDistributionProfile();
    if (!distribution.allowRuntimeCodeDownloads) {
      return distribution.refusalReason('connector-component');
    }
    const policy = await this.opts.policy?.refusal();
    if (policy) return policy;
    const sdk = this.opts.sdkVersion ?? runnerSdkVersion();
    let fits = false;
    try {
      fits = satisfiesRange(sdk, pin.spectral);
    } catch {
      fits = false;
    }
    if (!fits) {
      return `This connection needs a newer Gezel: its component was published for Spectral ${pin.spectral}, and this build carries ${sdk}.`;
    }
    return undefined;
  }

  private async install(pin: SpectralComponentPin): Promise<InstalledComponent> {
    const target = this.folderFor(pin);
    const backup = `${target}.previous`;
    const staging = `${target}.staging-${process.pid}-${randomUUID().slice(0, 8)}`;
    await mkdir(this.root, { recursive: true });
    await recoverInterruptedNpmInstall(target, backup);
    await mkdir(staging, { recursive: true });
    try {
      const tarball = join(staging, 'package.tgz');
      const actual = await fetchPinnedNpmTarball({
        packageName: pin.name,
        version: pin.version,
        dest: tarball,
        ...(this.opts.registry ? { registry: this.opts.registry } : {}),
      });
      if (actual !== pin.sha256) {
        throw new ComponentRefusedError(
          `${pin.name}@${pin.version} from the registry does not match its pin; nothing was installed.`,
        );
      }
      const dir = await extractNpmPackageTarball({
        tarballPath: tarball,
        destination: staging,
        expectedName: pin.name,
        expectedVersion: pin.version,
      });
      await rm(tarball, { force: true });
      await this.checkPackage(dir, pin);
      const at = new Date(this.now()).toISOString();
      const marker: Marker = { pin, installedAt: at, lastUsedAt: at };
      await writeFile(join(staging, MARKER), JSON.stringify(marker, null, 2), { mode: 0o600 });
      await publishStagedNpmInstall(staging, target, backup);
      log.info(`[connectors] installed ${pin.name}@${pin.version}`);
      return { dir: join(target, 'package'), entry: pin.entry, entrySha256: pin.entrySha256 };
    } catch (err) {
      await rm(staging, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  private async checkPackage(dir: string, pin: SpectralComponentPin): Promise<void> {
    const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
      license?: unknown;
      dependencies?: Record<string, unknown>;
      optionalDependencies?: Record<string, unknown>;
      bundleDependencies?: unknown;
      bundledDependencies?: unknown;
      peerDependencies?: Record<string, unknown>;
    };
    const refuse = (why: string) => {
      throw new ComponentRefusedError(`${pin.name}@${pin.version} ${why}; nothing was installed.`);
    };
    const nonEmpty = (v: unknown) =>
      Array.isArray(v)
        ? v.length > 0
        : Boolean(v && typeof v === 'object' && Object.keys(v).length);
    if (
      nonEmpty(manifest.dependencies) ||
      nonEmpty(manifest.optionalDependencies) ||
      nonEmpty(manifest.bundleDependencies) ||
      nonEmpty(manifest.bundledDependencies) ||
      existsSync(join(dir, 'node_modules'))
    ) {
      refuse('has dependencies of its own');
    }
    if (manifest.license !== pin.license)
      refuse(`is licensed ${String(manifest.license)}, not ${pin.license}`);
    if (manifest.peerDependencies?.['@prismatic-io/spectral'] !== pin.spectral) {
      refuse('asks for a different Spectral SDK than its pin');
    }
    const entry = await this.entryPath(dir, pin.entry);
    if ((await sha256File(entry)) !== pin.entrySha256)
      refuse('has an entry file that does not match its pin');
  }

  private async entryPath(dir: string, entry: string): Promise<string> {
    const root = await realpath(dir);
    const path = await realpath(join(root, entry));
    const rel = relative(root, path);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new ComponentRefusedError('the component entry is outside its package');
    }
    if (!(await stat(path)).isFile())
      throw new ComponentRefusedError('the component entry is not a file');
    return path;
  }

  private async readMarker(folder: string): Promise<Marker | undefined> {
    try {
      const raw = JSON.parse(await readFile(join(folder, MARKER), 'utf8')) as Marker;
      return raw?.pin && typeof raw.lastUsedAt === 'string' ? raw : undefined;
    } catch {
      return undefined;
    }
  }

  /** Record a use, at most once an hour, so pruning sees what is live. */
  private async touch(folder: string, marker: Marker): Promise<void> {
    if (this.now() - Date.parse(marker.lastUsedAt) < 60 * 60_000) return;
    const next = { ...marker, lastUsedAt: new Date(this.now()).toISOString() };
    const temp = join(folder, `${MARKER}.tmp-${randomUUID().slice(0, 8)}`);
    await writeFile(temp, JSON.stringify(next, null, 2), { mode: 0o600 }).catch(() => {});
    await rename(temp, join(folder, MARKER)).catch(() => {});
  }
}
