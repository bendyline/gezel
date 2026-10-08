import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type Craftbook,
  CraftbookSchema,
  CraftbookStepSchema,
  type CraftbookSummary,
  type ProjectCraftbookProvenance,
  ProjectCraftbookProvenanceSchema,
  nowIso,
} from '@bendyline/gezel';
import {
  craftbookTemplateDir,
  craftbookTemplateManifestFile,
  craftbookTemplateVersionDir,
  craftbookTemplateVersionManifestFile,
  craftbookTemplatesRoot,
  projectLocalCraftbookDir,
  projectLocalCraftbooksRoot,
} from '@bendyline/gezel/paths';
import { WorkspaceWriteDeniedError, type WorkspaceWriteDeniedReason } from '../workspace/errors.js';
import { writeFileAtomic } from './atomic.js';
import {
  readProjectCraftbookDocument,
  updateProjectCraftbookDocument,
} from './project-craftbook-document.js';

export interface CraftbookStoreOptions {
  home: string;
  projectWorkspaceDir: (projectId: string) => Promise<string>;
  assertWorkspaceWritable: (
    projectId: string,
  ) => Promise<
    | { ok: true; workspaceDir: string }
    | { ok: false; reason: WorkspaceWriteDeniedReason; workingDir: string }
  >;
}

/**
 * The craftbook fields a stored version manifest carries beyond
 * `steps`/`entryStepId`, and the fields read back out of it.
 *
 * These two functions exist because the local-template pair and the
 * project-local pair were hand-maintained copies of the same list and
 * drifted: the project pair carried the full declaration while the local
 * pair silently dropped `triggers`, `toolsets`, `connectors`, `hooks`,
 * `paramSchema`, `command` and `requirements`, and NEITHER carried
 * `spawn`. Since `craftbook_write(create: true)` routes every
 * model-authored book to the LOCAL writer, that meant a model could author
 * a parameterized or fanning-out recipe, be told it saved, and read back a
 * book with the declaration gone.
 *
 * A dropped field here is invisible: the write succeeds and the loss only
 * shows up as a recipe that does not do what its author wrote. Adding a
 * field to `CraftbookSchema` that belongs in a stored book means adding it
 * to BOTH functions below and nowhere else.
 */
function craftbookVersionManifest(book: Craftbook): Record<string, unknown> {
  return {
    schemaVersion: 1,
    version: book.version ?? '1.0.0',
    releasedAt: book.updatedAt,
    about: 'about.md',
    entryStepId: book.entryStepId,
    steps: book.steps,
    ...(book.basedOn ? { basedOn: book.basedOn } : {}),
    ...(book.plan !== undefined ? { plan: book.plan } : {}),
    ...(book.defaultAssignee ? { defaultAssignee: book.defaultAssignee } : {}),
    ...(book.triggers ? { triggers: book.triggers } : {}),
    ...(book.toolsets ? { toolsets: book.toolsets } : {}),
    // connectors decide whether the launch runs connector prep at all —
    // the same drop that once disabled the feature for every catalog
    // craftbook (see runtimeCraftbookFromTemplate). Without them a book
    // launches with no corpus and `{{corpusScope}}` survives interpolation
    // straight into the step prompts and gates.
    ...(book.connectors ? { connectors: book.connectors } : {}),
    ...(book.commands ? { commands: book.commands } : {}),
    ...(book.models ? { models: book.models } : {}),
    ...(book.services ? { services: book.services } : {}),
    ...(book.hooks ? { hooks: book.hooks } : {}),
    ...(book.paramSchema ? { paramSchema: book.paramSchema } : {}),
    ...(book.command ? { command: book.command } : {}),
    ...(book.requirements ? { requirements: book.requirements } : {}),
    ...(book.recommends ? { recommends: book.recommends } : {}),
    ...(book.runModes ? { runModes: book.runModes } : {}),
    // Declarative fanout. Dropping this turned a spawn host into an
    // ordinary linear book whose `spawnFanout` step fans out over nothing.
    ...(book.spawn ? { spawn: book.spawn } : {}),
    ...(book.diffpackCapable !== undefined ? { diffpackCapable: book.diffpackCapable } : {}),
    ...(book.capabilityFloor ? { capabilityFloor: book.capabilityFloor } : {}),
    ...(book.scripts ? { bundledScripts: Object.keys(book.scripts).map((n) => `${n}.ts`) } : {}),
  };
}

/** Read back what {@link craftbookVersionManifest} wrote. Mirror it exactly. */
function craftbookFieldsFromVersionManifest(v: Record<string, unknown>): Partial<Craftbook> {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
  return {
    ...(isRecord(v.basedOn) ? { basedOn: v.basedOn as Craftbook['basedOn'] } : {}),
    ...(typeof v.plan === 'string' ? { plan: v.plan } : {}),
    ...(v.defaultAssignee
      ? { defaultAssignee: v.defaultAssignee as Craftbook['defaultAssignee'] }
      : {}),
    ...(Array.isArray(v.triggers) ? { triggers: v.triggers as string[] } : {}),
    ...(Array.isArray(v.toolsets) ? { toolsets: v.toolsets as Craftbook['toolsets'] } : {}),
    ...(Array.isArray(v.connectors) ? { connectors: v.connectors as Craftbook['connectors'] } : {}),
    ...(Array.isArray(v.commands) ? { commands: v.commands as Craftbook['commands'] } : {}),
    ...(Array.isArray(v.models) ? { models: v.models as Craftbook['models'] } : {}),
    ...(Array.isArray(v.services) ? { services: v.services as Craftbook['services'] } : {}),
    ...(Array.isArray(v.hooks) ? { hooks: v.hooks as Craftbook['hooks'] } : {}),
    ...(isRecord(v.paramSchema) ? { paramSchema: v.paramSchema as Craftbook['paramSchema'] } : {}),
    ...(typeof v.command === 'string' ? { command: v.command } : {}),
    ...(Array.isArray(v.requirements)
      ? { requirements: v.requirements as Craftbook['requirements'] }
      : {}),
    ...(Array.isArray(v.recommends) ? { recommends: v.recommends as Craftbook['recommends'] } : {}),
    ...(isRecord(v.runModes) ? { runModes: v.runModes as Craftbook['runModes'] } : {}),
    ...(isRecord(v.spawn) ? { spawn: v.spawn as Craftbook['spawn'] } : {}),
    ...(typeof v.diffpackCapable === 'boolean' ? { diffpackCapable: v.diffpackCapable } : {}),
    ...(typeof v.capabilityFloor === 'string'
      ? { capabilityFloor: v.capabilityFloor as Craftbook['capabilityFloor'] }
      : {}),
  };
}

/**
 * Owns user-authored craftbooks on disk: the local templates under
 * `~/.gezel/craftbook-templates/` and the project-local books in a
 * workspace's `.gezel/craftbooks/`.
 *
 * Store remains the public facade for callers; project-local writes still go
 * through its workspace write gate.
 */
export class CraftbookStore {
  private readonly home: string;
  private readonly projectWorkspaceDir: CraftbookStoreOptions['projectWorkspaceDir'];
  private readonly assertWorkspaceWritable: CraftbookStoreOptions['assertWorkspaceWritable'];

  constructor(opts: CraftbookStoreOptions) {
    this.home = opts.home;
    this.projectWorkspaceDir = opts.projectWorkspaceDir;
    this.assertWorkspaceWritable = opts.assertWorkspaceWritable;
  }

  /* ─── Local craftbook templates ─────────────────────────────────────── */

  /**
   * List user-authored craftbook templates from the local catalog source
   * under `~/.gezel/craftbook-templates/`. Returns lightweight summaries
   * — full hydration goes through `getLocalCraftbookTemplate`.
   */
  async listLocalCraftbookTemplates(): Promise<CraftbookSummary[]> {
    const root = craftbookTemplatesRoot(this.home);
    let shards: string[];
    try {
      shards = await readdir(root);
    } catch {
      return [];
    }
    const out: CraftbookSummary[] = [];
    for (const shard of shards) {
      let ids: string[] = [];
      try {
        ids = await readdir(join(root, shard));
      } catch {
        continue;
      }
      for (const id of ids) {
        const book = await this.getLocalCraftbookTemplate(id);
        if (!book) continue;
        out.push({
          id: book.id,
          name: book.name,
          ...(book.description ? { description: book.description } : {}),
          ...(book.version ? { version: book.version } : {}),
          ...(book.basedOn ? { basedOn: book.basedOn } : {}),
          source: 'local',
          stepCount: book.steps.length,
        });
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /**
   * Read every `scripts/*.ts` file in a craftbook version dir into the
   * runtime `scripts` map (name → source). Absent/empty dir → undefined.
   * The hydration half of the inline-scripts contract: sources stay
   * ordinary files on disk; the resolved runtime object carries them.
   */
  private async readCraftbookScriptsDir(dir: string): Promise<Record<string, string> | undefined> {
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return undefined;
    }
    const scripts: Record<string, string> = {};
    for (const f of files.filter((f) => f.endsWith('.ts')).sort()) {
      try {
        scripts[f.slice(0, -3)] = await readFile(join(dir, f), 'utf8');
      } catch {
        /* unreadable entry — skip */
      }
    }
    return Object.keys(scripts).length > 0 ? scripts : undefined;
  }

  /**
   * Persist a `scripts` map into a version's `scripts/` dir. The map is
   * the truth: entries are written, on-disk `.ts` files whose names left
   * the map are deleted. `undefined` leaves the dir untouched (legacy
   * callers that never carried scripts must not clear what the script
   * editor wrote); pass `{}` to clear.
   */
  private async writeCraftbookScriptsDir(
    dir: string,
    scripts: Record<string, string> | undefined,
  ): Promise<void> {
    if (scripts === undefined) return;
    let existing: string[] = [];
    try {
      existing = (await readdir(dir)).filter((f) => f.endsWith('.ts'));
    } catch {
      /* no dir yet */
    }
    const keep = new Set(Object.keys(scripts).map((n) => `${n}.ts`));
    if (Object.keys(scripts).length > 0) await mkdir(dir, { recursive: true });
    for (const [name, source] of Object.entries(scripts)) {
      await writeFileAtomic(join(dir, `${name}.ts`), source);
    }
    for (const f of existing) {
      if (!keep.has(f)) await rm(join(dir, f), { force: true }).catch(() => undefined);
    }
  }

  /**
   * Resolve a local craftbook template into the runtime `Craftbook`
   * shape — identity + version manifest + about.md merged. When
   * `version` is omitted, picks the only present version (v1: local
   * templates have a single `1.0.0` version edited in place).
   */
  async getLocalCraftbookTemplate(id: string, version?: string): Promise<Craftbook | null> {
    const prefix = craftbookShardPrefix(id);
    const identityFile = craftbookTemplateManifestFile(this.home, prefix, id);
    let identity: { id?: string; name?: string; description?: string } = {};
    try {
      identity = JSON.parse(await readFile(identityFile, 'utf8'));
    } catch {
      return null;
    }
    if (identity.id !== id) return null;
    // Discover versions; default to single 1.0.0 for local source.
    const versionsDir = join(craftbookTemplateDir(this.home, prefix, id), 'versions');
    let versions: string[];
    try {
      versions = await readdir(versionsDir);
    } catch {
      return null;
    }
    versions = versions.filter((v) => /^\d+\.\d+\.\d+/.test(v));
    if (versions.length === 0) return null;
    const chosen = version ?? versions.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))[0]!;
    if (!versions.includes(chosen)) return null;
    const versionFile = craftbookTemplateVersionManifestFile(this.home, prefix, id, chosen);
    let raw: string;
    try {
      raw = await readFile(versionFile, 'utf8');
    } catch {
      return null;
    }
    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(raw);
    } catch {
      return null;
    }
    const v = parsedRaw as Record<string, unknown>;
    let steps: Craftbook['steps'] | null;
    try {
      steps = z_array_parse(v.steps);
    } catch {
      return null;
    }
    if (!steps || typeof v.entryStepId !== 'string') return null;
    const scripts = await this.readCraftbookScriptsDir(
      join(craftbookTemplateVersionDir(this.home, prefix, id, chosen), 'scripts'),
    );
    const now = nowIso();
    const candidate: Craftbook = {
      id,
      name: identity.name ?? id,
      ...(identity.description ? { description: identity.description } : {}),
      version: chosen,
      ...craftbookFieldsFromVersionManifest(v),
      steps,
      entryStepId: v.entryStepId,
      ...(scripts ? { scripts } : {}),
      createdAt: typeof v.releasedAt === 'string' ? v.releasedAt : now,
      updatedAt: typeof v.releasedAt === 'string' ? v.releasedAt : now,
    };
    try {
      return CraftbookSchema.parse(candidate);
    } catch {
      return null;
    }
  }

  /**
   * Persist a local craftbook template. Writes the identity manifest
   * once (if absent), then writes the version manifest in place. v1
   * uses a single `1.0.0` version per local craftbook — re-saves
   * overwrite that version rather than minting a new one.
   */
  async writeLocalCraftbookTemplate(book: Craftbook): Promise<void> {
    const prefix = craftbookShardPrefix(book.id);
    const version = book.version ?? '1.0.0';
    const identityFile = craftbookTemplateManifestFile(this.home, prefix, book.id);
    const versionDir = craftbookTemplateVersionDir(this.home, prefix, book.id, version);
    const versionFile = craftbookTemplateVersionManifestFile(this.home, prefix, book.id, version);
    await mkdir(versionDir, { recursive: true });
    let writeIdentity = true;
    try {
      await readFile(identityFile, 'utf8');
      writeIdentity = false;
    } catch {
      /* missing — write fresh */
    }
    if (writeIdentity) {
      const identity = {
        schemaVersion: 1,
        kind: 'craftbook-template',
        id: book.id,
        name: book.name,
        description: book.description ?? '',
        tags: [],
        maintainer: { name: 'local' },
        license: undefined,
        yankedVersions: [],
      };
      await writeFileAtomic(identityFile, `${JSON.stringify(identity, null, 2)}\n`);
    }
    const versionManifest = craftbookVersionManifest(book);
    await writeFileAtomic(versionFile, `${JSON.stringify(versionManifest, null, 2)}\n`);
    if (book.description) {
      await writeFileAtomic(join(versionDir, 'about.md'), book.description);
    }
    await this.writeCraftbookScriptsDir(join(versionDir, 'scripts'), book.scripts);
  }

  /**
   * Remove a local craftbook template entirely. Caller is responsible
   * for refusing the delete when any task's `sourceCraftbookIds`
   * references it — the Store doesn't cross-check that itself.
   */
  async deleteLocalCraftbookTemplate(id: string): Promise<void> {
    const prefix = craftbookShardPrefix(id);
    const dir = craftbookTemplateDir(this.home, prefix, id);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* already absent */
    }
  }

  /* ─── Project-local craftbooks (workspace `.gezel/craftbooks/`) ──────── */

  /**
   * List the project-local craftbooks defined in a project's workspace
   * `.gezel/craftbooks/` folder. These travel with the repo and only
   * surface inside their own project. Flat layout (no shard prefix);
   * otherwise mirrors {@link listLocalCraftbookTemplates}.
   */
  async listProjectCraftbooks(projectId: string): Promise<CraftbookSummary[]> {
    let ws: string;
    try {
      ws = await this.projectWorkspaceDir(projectId);
    } catch {
      return [];
    }
    let ids: string[] = [];
    try {
      const entries = await readdir(projectLocalCraftbooksRoot(ws), { withFileTypes: true });
      ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
    const out: CraftbookSummary[] = [];
    for (const id of ids) {
      const book = await this.getProjectCraftbook(projectId, id);
      if (!book) continue;
      out.push({
        id: book.id,
        name: book.name,
        ...(book.description ? { description: book.description } : {}),
        ...(book.version ? { version: book.version } : {}),
        ...(book.basedOn ? { basedOn: book.basedOn } : {}),
        source: 'project',
        stepCount: book.steps.length,
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  /** Resolve a project-local craftbook into the runtime `Craftbook` shape. */
  async getProjectCraftbook(
    projectId: string,
    id: string,
    version?: string,
    options: { throwOnInvalid?: boolean } = {},
  ): Promise<Craftbook | null> {
    let ws: string;
    try {
      ws = await this.projectWorkspaceDir(projectId);
    } catch {
      return null;
    }
    const dir = projectLocalCraftbookDir(ws, id);
    let identity: { id?: string; name?: string; description?: string } = {};
    try {
      identity = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    } catch {
      return null;
    }
    if (identity.id !== id) return null;
    const versionsDir = join(dir, 'versions');
    let versions: string[];
    try {
      versions = await readdir(versionsDir);
    } catch {
      return null;
    }
    versions = versions.filter((v) => /^\d+\.\d+\.\d+/.test(v));
    if (versions.length === 0) return null;
    const chosen = version ?? versions.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))[0]!;
    if (!versions.includes(chosen)) return null;
    const document = await readProjectCraftbookDocument(
      join(versionsDir, chosen),
      id,
      chosen,
      options,
    );
    if (document !== undefined) return document;
    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(await readFile(join(versionsDir, chosen, 'manifest.json'), 'utf8'));
    } catch {
      return null;
    }
    const v = parsedRaw as Record<string, unknown>;
    let steps: Craftbook['steps'] | null;
    try {
      steps = z_array_parse(v.steps);
    } catch {
      return null;
    }
    if (!steps || typeof v.entryStepId !== 'string') return null;
    const scripts = await this.readCraftbookScriptsDir(join(versionsDir, chosen, 'scripts'));
    const now = nowIso();
    const candidate: Craftbook = {
      id,
      name: identity.name ?? id,
      ...(identity.description ? { description: identity.description } : {}),
      version: chosen,
      ...craftbookFieldsFromVersionManifest(v),
      steps,
      entryStepId: v.entryStepId,
      ...(scripts ? { scripts } : {}),
      createdAt: typeof v.releasedAt === 'string' ? v.releasedAt : now,
      updatedAt: typeof v.releasedAt === 'string' ? v.releasedAt : now,
    };
    try {
      return CraftbookSchema.parse(candidate);
    } catch {
      return null;
    }
  }

  /** Persist a project-local craftbook (flat `.gezel/craftbooks/<id>/` layout). */
  async writeProjectCraftbook(projectId: string, book: Craftbook): Promise<void> {
    const gate = await this.assertWorkspaceWritable(projectId);
    if (!gate.ok) throw new WorkspaceWriteDeniedError(gate);
    const dir = projectLocalCraftbookDir(gate.workspaceDir, book.id);
    const version = book.version ?? '1.0.0';
    const versionDir = join(dir, 'versions', version);
    await mkdir(versionDir, { recursive: true });
    if (await updateProjectCraftbookDocument(versionDir, book)) return;
    const identityFile = join(dir, 'manifest.json');
    let writeIdentity = true;
    try {
      await readFile(identityFile, 'utf8');
      writeIdentity = false;
    } catch {
      /* missing — write fresh */
    }
    if (writeIdentity) {
      const identity = {
        schemaVersion: 1,
        kind: 'craftbook-template',
        id: book.id,
        name: book.name,
        description: book.description ?? '',
        tags: [],
        maintainer: { name: 'project' },
        yankedVersions: [],
      };
      await writeFileAtomic(identityFile, `${JSON.stringify(identity, null, 2)}\n`);
    }
    const versionManifest = craftbookVersionManifest(book);
    await writeFileAtomic(
      join(versionDir, 'manifest.json'),
      `${JSON.stringify(versionManifest, null, 2)}\n`,
    );
    if (book.description) {
      await writeFileAtomic(join(versionDir, 'about.md'), book.description);
    }
    await this.writeCraftbookScriptsDir(join(versionDir, 'scripts'), book.scripts);
  }

  /** Remove a project-local craftbook from the workspace. */
  async deleteProjectCraftbook(projectId: string, id: string): Promise<void> {
    const gate = await this.assertWorkspaceWritable(projectId);
    if (!gate.ok) throw new WorkspaceWriteDeniedError(gate);
    const dir = projectLocalCraftbookDir(gate.workspaceDir, id);
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      /* already absent */
    }
  }

  /**
   * Read the project-type install sidecar for a project-local craftbook
   * (`.gezel/craftbooks/<id>/provenance.json`). Null when the book was
   * user-authored, imported from a SKILL.md, or the sidecar is invalid.
   */
  async readProjectCraftbookProvenance(
    projectId: string,
    id: string,
  ): Promise<ProjectCraftbookProvenance | null> {
    let ws: string;
    try {
      ws = await this.projectWorkspaceDir(projectId);
    } catch {
      return null;
    }
    try {
      const raw = await readFile(join(projectLocalCraftbookDir(ws, id), 'provenance.json'), 'utf8');
      return ProjectCraftbookProvenanceSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /** Stamp the project-type install sidecar next to the book's identity manifest. */
  async writeProjectCraftbookProvenance(
    projectId: string,
    id: string,
    prov: ProjectCraftbookProvenance,
  ): Promise<void> {
    const gate = await this.assertWorkspaceWritable(projectId);
    if (!gate.ok) throw new WorkspaceWriteDeniedError(gate);
    const dir = projectLocalCraftbookDir(gate.workspaceDir, id);
    await mkdir(dir, { recursive: true });
    await writeFileAtomic(join(dir, 'provenance.json'), `${JSON.stringify(prov, null, 2)}\n`);
  }
}

/** First two chars of a craftbook id, lowercased — the catalog shard prefix. */
function craftbookShardPrefix(id: string): string {
  return id.slice(0, 2).toLowerCase();
}

/** Parse a steps array against `CraftbookStepSchema`; throws on invalid rows. */
function z_array_parse(raw: unknown): Craftbook['steps'] | null {
  if (!Array.isArray(raw)) return null;
  const out: Craftbook['steps'] = [];
  for (const item of raw) {
    out.push(CraftbookStepSchema.parse(item));
  }
  return out;
}
