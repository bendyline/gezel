/**
 * Shared scaffolding for connector tests: an in-memory SecretStore, a fake
 * project Store, a throwaway artifacts tree, and readers that turn a written
 * corpus back into data a test can assert on.
 *
 * `assertCorpusInvariants` is the safety half of every adapter test. It checks
 * the rules connector-standards.md §1 and §7 promise for *every* driver — the
 * record filename grammar, trust frontmatter on every record, no record
 * outside the corpus root, a sidecar entry per record — so an adapter that
 * builds a path or drops a frontmatter key wrongly fails here once, instead of
 * in each test that happens to look.
 */

import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import type { SecretStore } from '@bendyline/gezel-inference/internal/secrets/types';
import type { Store } from '../../fs/store.js';
import { connectorSecretKey } from '../registry.js';
import type { AdapterDeps, ConnectorBindingRef } from '../types.js';

type SecretKeyLike = { toolsetId?: string; fieldId?: string; kind?: string };

/** A SecretStore backed by a Map, with the raw map exposed for assertions. */
export function memorySecrets(): { secrets: SecretStore; map: Map<string, string> } {
  const map = new Map<string, string>();
  const key = (k: SecretKeyLike) => `${k.toolsetId ?? k.kind}:${k.fieldId ?? ''}`;
  const secrets = {
    get: async (k: SecretKeyLike) => map.get(key(k)) ?? null,
    set: async (k: SecretKeyLike, v: string) => {
      map.set(key(k), v);
    },
    delete: async (k: SecretKeyLike) => {
      map.delete(key(k));
    },
    has: async (k: SecretKeyLike) => map.has(key(k)),
  } as unknown as SecretStore;
  return { secrets, map };
}

export interface ConnectorTestEnv {
  /** Temp root; removed by `dispose()`. */
  root: string;
  /** Project artifacts root (what the engine calls `storageDir`). */
  artifactsDir: string;
  /** Private quarantine root. */
  quarantineDir: string;
  secrets: SecretStore;
  secretMap: Map<string, string>;
  /** A minimal Store: one project, artifacts/quarantine dirs, updates in memory. */
  store: Store;
  /** The fake project's current record (bindings, cursors). */
  project(): FakeProject;
  /** `AdapterDeps` for constructing an adapter directly. */
  deps(extra?: Partial<AdapterDeps>): AdapterDeps;
  /** Store a credential blob for a binding under the real connector secret key. */
  storeCredential(binding: ConnectorBindingRef, credential: unknown): Promise<void>;
  /** Read a binding's credential blob back (parsed). */
  readCredential<T = Record<string, unknown>>(binding: ConnectorBindingRef): Promise<T | null>;
  dispose(): Promise<void>;
}

export interface FakeProject {
  id: string;
  name?: string;
  connectors?: {
    id: string;
    type: string;
    displayName?: string;
    corpusDir?: string;
    cursor?: unknown;
    config?: Record<string, unknown>;
    lastSyncedAt?: string;
    lastError?: string;
    disabled?: boolean;
  }[];
  grantedCredentials?: string[];
  credentialAllowedOrigins?: Record<string, string[]>;
}

export async function createConnectorTestEnv(projectId = 'p1'): Promise<ConnectorTestEnv> {
  const root = await mkdtemp(join(tmpdir(), 'gezel-connector-'));
  const artifactsDir = join(root, 'artifacts');
  const quarantineDir = join(root, 'private', 'quarantine');
  // Production creates both before a pass (connectorCorpusStorage); the
  // writer's realpath containment check needs the base to exist.
  await mkdir(artifactsDir, { recursive: true });
  await mkdir(quarantineDir, { recursive: true });
  await mkdir(join(root, 'workspace'), { recursive: true });
  const { secrets, map } = memorySecrets();
  let project: FakeProject = { id: projectId, name: 'Connector test' };
  const store = {
    getProject: async () => project,
    updateProject: async (_id: string, patch: Partial<FakeProject>) => {
      project = { ...project, ...patch };
      return project;
    },
    readConfig: async () => ({}),
    projectWorkspaceDir: async () => join(root, 'workspace'),
    projectArtifactsDir: () => artifactsDir,
    projectQuarantineDir: () => quarantineDir,
    get historyManager() {
      return undefined;
    },
  } as unknown as Store;

  return {
    root,
    artifactsDir,
    quarantineDir,
    secrets,
    secretMap: map,
    store,
    project: () => project,
    deps: (extra) => ({ secrets, store, projectId, ...(extra ?? {}) }),
    storeCredential: async (binding, credential) => {
      await secrets.set(
        connectorSecretKey(binding.type, binding.id),
        typeof credential === 'string' ? credential : JSON.stringify(credential),
      );
    },
    readCredential: async <T>(binding: ConnectorBindingRef) => {
      const blob = await secrets.get(connectorSecretKey(binding.type, binding.id));
      return blob ? (JSON.parse(blob) as T) : null;
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

export interface CorpusRecord {
  /** Path relative to the corpus dir, with `/` separators. */
  path: string;
  frontmatter: Record<string, string>;
  body: string;
}

const RECORD_FILE_RE = /^(\d{3})--.*--([0-9a-f]{8})\.md$/;

/** Parse the writer's frontmatter (values may be JSON-quoted). */
export function parseRecordFile(content: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  if (!content.startsWith('---\n')) return { frontmatter: {}, body: content };
  const end = content.indexOf('\n---\n', 4);
  if (end < 0) return { frontmatter: {}, body: content };
  const frontmatter: Record<string, string> = {};
  for (const line of content.slice(4, end).split('\n')) {
    const i = line.indexOf(': ');
    if (i <= 0) continue;
    const key = line.slice(0, i);
    const raw = line.slice(i + 2);
    let value = raw;
    if (raw.startsWith('"')) {
      try {
        value = JSON.parse(raw) as string;
      } catch {
        value = raw;
      }
    }
    frontmatter[key] = value;
  }
  return { frontmatter, body: content.slice(end + 5).replace(/^\n/, '') };
}

/** Every record file under a corpus dir (skipping `_` entries and attachments). */
export async function readCorpus(artifactsDir: string, corpusDir: string): Promise<CorpusRecord[]> {
  const rootAbs = join(artifactsDir, corpusDir);
  const out: CorpusRecord[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('_')) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'attachments') await walk(abs);
        continue;
      }
      if (!RECORD_FILE_RE.test(e.name)) continue;
      const parsed = parseRecordFile(await readFile(abs, 'utf8'));
      out.push({ path: relative(rootAbs, abs).split(sep).join('/'), ...parsed });
    }
  }
  await walk(rootAbs);
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Every file of any kind under a dir, relative, `/`-separated. */
export async function listFiles(dirAbs: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[] = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else out.push(relative(dirAbs, abs).split(sep).join('/'));
    }
  }
  await walk(dirAbs);
  return out.sort();
}

export interface CorpusInvariantOptions {
  /** Frontmatter keys every record of this type must carry (beyond trust/scan). */
  requiredKeys?: string[];
  /** Expected `direction` value (default `inbound`). */
  direction?: string;
  /**
   * Other bindings' corpora share this artifacts tree (a multi-binding
   * project), so files under other `data/<corpus>/` roots are expected.
   * Anything outside `data/` is still a violation.
   */
  sharedArtifacts?: boolean;
}

/**
 * The connector-standards rules every corpus must satisfy, whatever the
 * adapter. Returns the parsed records so a test can continue asserting.
 * Throws an Error listing every violation (not just the first).
 */
export async function assertCorpusInvariants(
  artifactsDir: string,
  corpusDir: string,
  opts: CorpusInvariantOptions = {},
): Promise<CorpusRecord[]> {
  const problems: string[] = [];
  const all = await listFiles(artifactsDir);
  const prefix = `${corpusDir.replace(/\/+$/, '')}/`;
  for (const f of all) {
    const allowed = opts.sharedArtifacts ? f.startsWith('data/') : f.startsWith(prefix);
    if (!allowed) problems.push(`file outside the corpus root: ${f}`);
  }
  const records = await readCorpus(artifactsDir, corpusDir);
  const byDir = new Map<string, CorpusRecord[]>();
  for (const r of records) {
    const dir = r.path.includes('/') ? r.path.slice(0, r.path.lastIndexOf('/')) : '';
    byDir.set(dir, [...(byDir.get(dir) ?? []), r]);
    const fm = r.frontmatter;
    if (fm.trust !== 'untrusted-external') problems.push(`${r.path}: trust is '${fm.trust}'`);
    if (!fm.scan_action) problems.push(`${r.path}: no scan_action`);
    if ((fm.direction ?? '') !== (opts.direction ?? 'inbound')) {
      problems.push(`${r.path}: direction is '${fm.direction}'`);
    }
    for (const key of opts.requiredKeys ?? []) {
      if (!fm[key]) problems.push(`${r.path}: missing frontmatter '${key}'`);
    }
    const name = r.path.slice(r.path.lastIndexOf('/') + 1);
    if (name.length > 140) problems.push(`${r.path}: filename longer than 140 chars`);
    if (/[^A-Za-z0-9._-]/.test(r.path.replace(/\//g, ''))) {
      problems.push(`${r.path}: path has characters outside [A-Za-z0-9._-]`);
    }
  }
  // Sidecar: one entry per record in its directory, naming the live file.
  for (const [dir, recs] of byDir) {
    let sidecar: Record<string, { file?: string }> = {};
    try {
      sidecar = JSON.parse(
        await readFile(join(artifactsDir, corpusDir, dir, '_flags.json'), 'utf8'),
      ) as typeof sidecar;
    } catch {
      problems.push(`${dir || '(corpus root)'}: records without a _flags.json sidecar`);
      continue;
    }
    for (const r of recs) {
      const name = r.path.slice(r.path.lastIndexOf('/') + 1);
      const hash8 = RECORD_FILE_RE.exec(name)?.[2] ?? '';
      if (sidecar[hash8]?.file !== name) problems.push(`${r.path}: sidecar does not name it`);
    }
  }
  // Ordinals unique per directory.
  for (const [dir, recs] of byDir) {
    const ords = recs.map((r) => r.path.slice(r.path.lastIndexOf('/') + 1).slice(0, 3));
    if (new Set(ords).size !== ords.length) problems.push(`${dir}: duplicate ordinals`);
  }
  if (problems.length) {
    throw new Error(`corpus invariants violated:\n  ${problems.join('\n  ')}`);
  }
  return records;
}

/** An ISO timestamp `days` before a fixed or given instant. */
export function daysAgo(days: number, from = new Date()): string {
  return new Date(from.getTime() - days * 86_400_000).toISOString();
}
