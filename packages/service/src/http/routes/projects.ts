import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  ApplyPatchToProjectWorkspaceFileRequestSchema,
  ApplyProjectTypeRequestSchema,
  CopyArtifactToWorkspaceRequestSchema,
  CreateProjectRequestSchema,
  CreateTypedProjectRequestSchema,
  DriveIndexEnrichmentRequestSchema,
  FetchDiffRequestSchema,
  FetchRepoRequestSchema,
  InsertAtMarkerInProjectWorkspaceFileRequestSchema,
  InstallPackageRequestSchema,
  NpmInstallRequestSchema,
  PNPM_HOISTED_NODE_LINKER,
  ProjectAboutPreviewRequestSchema,
  type ProjectAboutPreviewResponse,
  ProjectFolderPreviewRequestSchema,
  ReferenceFileLocationRequestSchema,
  ReferenceFileLocationResponseSchema,
  ReplaceInProjectWorkspaceFileRequestSchema,
  ReplaceLinesInProjectWorkspaceFileRequestSchema,
  UpdateProjectRequestSchema,
  createLogger,
  getProjectType,
  resolveProjectTypeId,
  resolveSecurityPolicy,
} from '@bendyline/gezel';
import { playwrightBrowsersDir } from '@bendyline/gezel/paths';
import { Hono } from 'hono';
import { previewFolder } from '../../about/folder-preview.js';
import { generateProjectAboutFromRepo } from '../../about/project-generator.js';
import {
  craftbookContextForProject,
  listApplicableCraftbooks,
  missingToolsetsForCraftbooks,
  projectCraftbookSummaries,
  projectHasEstablishedCodebase,
  suggestedCraftbookIdsForType,
} from '../../craftbook/applicable.js';
import { writeFileAtomic } from '../../fs/atomic.js';
import {
  ArtifactPathExistsError,
  ArtifactPathNotFoundError,
  ConnectorCorpusWriteDeniedError,
  ShadowPathWriteDeniedError,
  normalizeArtifactPath,
} from '../../fs/project-artifacts-store.js';
import {
  PathSafetyError,
  intoWorkspaceRelative,
  realpathContained,
  safeJoin,
} from '../../fs/safe-paths.js';
import { ProjectDeleteError } from '../../fs/store.js';
import { isOfficeLockName } from '../../fs/sync-junk.js';
import { resolveProjectBoekwachter } from '../../gezels/autonomous-roles.js';
import { GitError, runGit } from '../../git/git.js';
import { buildEnrichDeps } from '../../index-store/enrich.js';
import { installPackage } from '../../packages/install.js';
import { resolvePnpmCommand, spawnPnpm } from '../../packages/pnpm.js';
import {
  MANAGED_TOOLSET_IMPORT_HOOK_URL,
  nodeOptionsWithManagedToolsetImport,
} from '../../packages/toolset-import-hook.js';
import { applyProjectType } from '../../project-type/apply.js';
import { TypedProjectCreateError, createTypedProject } from '../../project-type/create.js';
import { detectAndPersistProjectType } from '../../project-type/detect.js';
import { GEZAPP_MAX_ARCHIVE_BYTES, importGezapp, packGezapp } from '../../project-type/gezapp.js';
import { readCommandApprovals } from '../../workspace/command-approvals.js';
import { deriveWorkspaceFile } from '../../workspace/derive.js';
import { WorkspaceEditError, WorkspaceWriteDeniedError } from '../../workspace/errors.js';
import {
  type EnsureProjectLeadResult,
  ensureFolderProjectBuilder,
  ensureProjectVoorman,
} from '../../workspace/import-sync.js';
import { readJournalTail } from '../../workspace/journal.js';
import {
  type NpmInstallPackageRequest,
  SHIPPED_ALLOWLIST,
  readProjectAllowlist,
  requestNpmInstalls,
} from '../../workspace/npm.js';
import { runWorkspaceScript } from '../../workspace/runner.js';
import { runNpx, runPackageScript } from '../../workspace/scripts.js';
import type { ServiceContext } from '../context.js';
import { buildTimeline } from './timeline.js';

const log = createLogger('http');

/**
 * Translate the two class-of errors workspace mutations can throw into
 * response envelopes a client / MCP tool can act on. Keeps the route
 * bodies small: the rare `try/catch` bubbles into one helper.
 */
function mapWorkspaceError(err: unknown): { status: number; body: Record<string, unknown> } {
  if (err instanceof WorkspaceWriteDeniedError) {
    return {
      status: 403,
      body: { error: err.message, code: err.code, reason: err.reason, workingDir: err.workingDir },
    };
  }
  if (err instanceof PathSafetyError) {
    return { status: 400, body: { error: err.message, code: err.code } };
  }
  if (err instanceof WorkspaceEditError) {
    return { status: 400, body: { error: err.message, code: err.code } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, body: { error: message } };
}

export function projectRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const projects = await ctx.store.listProjects();
    // ?rollup=1 attaches the deep-pass architecture note per project (one
    // indexed sqlite row each). Opt-in so the hot sidebar path stays a pure
    // store read; consumers: the Meester's list_projects tool, overview UIs.
    if (c.req.query('rollup') !== '1') return c.json({ projects });
    const enriched = await Promise.all(
      projects.map(async (p) => {
        if (p.indexingEnabled === false) return p;
        const architecture = await ctx.contentIndex.architectureNote(p.id).catch(() => null);
        return architecture ? { ...p, architecture: architecture.slice(0, 400) } : p;
      }),
    );
    return c.json({ projects: enriched });
  });

  app.post('/', async (c) => {
    const body = CreateProjectRequestSchema.parse(await c.req.json());
    const created = await ctx.store.createProject(body);
    // Give the project its lead up front so Chat never opens on an arbitrary
    // alphabetical gezel. Folder-backed solo projects get a hands-on Builder;
    // crew projects retain their Voorman. Runs synchronously because both the
    // CLI and desktop open Chat immediately. Best-effort; never blocks creation.
    const ensureLead =
      body.workingDir && body.mode === 'solo' ? ensureFolderProjectBuilder : ensureProjectVoorman;
    const ensured = await ensureLead(
      { store: ctx.store, chat: ctx.chat, home: ctx.home, catalog: ctx.catalog },
      created.id,
    ).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`[projects] ensure-lead failed for ${created.id}: ${message}`);
      return {} as EnsureProjectLeadResult;
    });
    if (ensured.createdGezel) {
      ctx.chatEvents.publishGlobalEvent({
        type: 'gezel_created',
        gezelId: ensured.createdGezel.id,
        name: ensured.createdGezel.name,
      });
    }
    // Classify a folder-backed project up front, off a bounded static scan of
    // the directory. The index tick would get here eventually, but not for the
    // first session: opening a folder and immediately asking "what should I
    // build?" is exactly when the craftbook shortlist and the gezel-role
    // suggestions need to know whether this is code, prose, data, or assets.
    if (body.workingDir) {
      await detectAndPersistProjectType({ store: ctx.store }, created.id);
    }
    // Re-read so the response carries the freshly-set voormanGezelId and
    // detected type; the UI selects the project from this payload and opens
    // Chat on the lead.
    const project = (await ctx.store.getProject(created.id)) ?? created;
    // Announce the new project on the project + global SSE streams so
    // always-mounted surfaces (the left sidebar PROJECTS list) fold it
    // in immediately. Covers every creation path — the New Project
    // dialog and the `start_project` macro both land here. History-free
    // so it isn't replayed to late subscribers.
    ctx.chatEvents.publishProjectEvent(project.id, {
      type: 'project_created',
      projectId: project.id,
      name: project.name,
    });
    // If the new project is linked to a GitHub repo, kick off a clone
    // immediately. We deliberately don't await — cloning a sizeable
    // repo can take a minute, and the New Project dialog has already
    // closed. Failures land in the service log and the status of the
    // checkout can be observed via the existing
    // GET /api/projects/:id/git/status endpoint that the GitHub
    // tab already polls.
    if (project.github?.url) {
      void ctx.git.ensureClone(project).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`[projects] background clone failed for ${project.id}: ${message}`);
      });
    }
    return c.json(project, 201);
  });

  /**
   * Create + apply a catalog project type as one server-owned operation.
   * Nothing is visible in the real Store and no lifecycle event is emitted
   * until the staged aggregate has committed successfully.
   */
  app.post('/typed', async (c) => {
    const body = CreateTypedProjectRequestSchema.parse(await c.req.json());
    try {
      const response = await createTypedProject({ store: ctx.store, catalog: ctx.catalog }, body);
      ctx.chatEvents.publishProjectEvent(response.project.id, {
        type: 'project_created',
        projectId: response.project.id,
        name: response.project.name,
      });
      // Typed-project gezels are staged in an isolated Store and published
      // with filesystem renames, so they bypass the live Store's creation
      // listener. Announce them explicitly after the atomic commit succeeds.
      for (const gezel of response.applied.gezelsCreated) {
        ctx.chatEvents.publishGlobalEvent({
          type: 'gezel_created',
          gezelId: gezel.id,
          name: gezel.name,
        });
      }
      // A project type whose crew nominates a voorman already set one; this
      // is a no-op mark for those. For types that don't suggest a lead (and
      // aren't solo), it promotes/reuses/mints one so Chat opens on a lead
      // rather than the "pick anyone" fallback.
      const ensured = await ensureProjectVoorman(
        { store: ctx.store, chat: ctx.chat, home: ctx.home, catalog: ctx.catalog },
        response.project.id,
      ).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`[projects] ensure-voorman failed for ${response.project.id}: ${message}`);
        return {} as EnsureProjectLeadResult;
      });
      if (ensured.createdGezel) {
        ctx.chatEvents.publishGlobalEvent({
          type: 'gezel_created',
          gezelId: ensured.createdGezel.id,
          name: ensured.createdGezel.name,
        });
      }
      const project = (await ctx.store.getProject(response.project.id)) ?? response.project;
      return c.json({ ...response, project }, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (err instanceof TypedProjectCreateError) {
        return c.json({ error: message, code: err.code }, err.status);
      }
      log.error(`[projects] typed project transaction failed: ${message}`);
      return c.json({ error: message, code: 'PROJECT_CREATE_FAILED' }, 500);
    }
  });

  /**
   * Generate an `about` + `missionObjectives` draft from a repo's
   * README, called by the New Project dialog on URL blur. Foreground
   * (the user is waiting), so we run the one-shot directly without
   * enqueueing — the QueueMeter still surfaces it via the `jobLabel`
   * the generator passes through.
   */
  app.post('/preview-about', async (c) => {
    const body = ProjectAboutPreviewRequestSchema.parse(await c.req.json());
    try {
      const result = await generateProjectAboutFromRepo(ctx.chat, body, c.req.raw.signal);
      const response: ProjectAboutPreviewResponse = result;
      return c.json(response);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 502);
    }
  });

  /**
   * Peek at a local folder for the New Project dialog's "from folder" flow:
   * derive the suggested project name from its basename and, when the folder
   * holds an agent doc at its root (AGENTS.md / CLAUDE.md / agent.md), read it
   * into a draft About. Read-only, non-fatal — an unreadable path still yields
   * a name so the field can populate.
   */
  app.post('/preview-folder', async (c) => {
    const { path } = ProjectFolderPreviewRequestSchema.parse(await c.req.json());
    return c.json(await previewFolder(path));
  });

  // Projects with a "poisoned" session — a non-archived session whose last
  // turn aborted (`lastTurnError` set) and is awaiting a user turn to clear.
  // The ambient scheduler skips these (see tasks/scheduler.ts), so surfacing
  // them lets the UI prompt the user to send a message and recover. Declared
  // before `/:id` so that path segment doesn't swallow `/poisoned`.
  app.get('/poisoned', async (c) => {
    // One pass over every session (already sorted newest-first); keep the
    // most-recent poisoned session per project.
    const sessions = await ctx.store.listSessions();
    const byProject = new Map<
      string,
      { projectId: string; sessionId: string; gezelId: string; error: string }
    >();
    for (const s of sessions) {
      if (s.archived || !s.lastTurnError) continue;
      if (byProject.has(s.projectId)) continue;
      byProject.set(s.projectId, {
        projectId: s.projectId,
        sessionId: s.id,
        gezelId: s.gezelId,
        error: s.lastTurnError,
      });
    }
    return c.json({ poisoned: [...byProject.values()] });
  });

  app.get('/:id', async (c) => {
    const id = c.req.param('id');
    const project = await ctx.store.getProject(id);
    if (!project) return c.json({ error: 'not found' }, 404);
    return c.json(project);
  });

  // Clear the poisoned "last turn failed" state on every session in the
  // project so ambient work resumes (the chat banner's Continue button).
  app.post('/:id/clear-errors', async (c) => {
    const cleared = await ctx.chat.clearProjectErrors(c.req.param('id'));
    return c.json({ cleared });
  });

  app.put('/:id', async (c) => {
    const id = c.req.param('id');
    const body = UpdateProjectRequestSchema.parse(await c.req.json());
    // Validate `voormanGezelId` is a real gezel before persisting.
    // Without this check, callers (especially small models in solo
    // setup) pass a gilde-template name like "builder" thinking it's
    // a gezel id; the field is accepted, the project's nudge
    // scheduler then spams `gezel "builder" not found` for the rest
    // of the trial. Surfacing a clear error here lets the model
    // self-correct on the next turn.
    if (typeof body.voormanGezelId === 'string' && body.voormanGezelId.length > 0) {
      const candidate = await ctx.store.getGezel(body.voormanGezelId);
      if (!candidate) {
        return c.json(
          {
            error: `voormanGezelId "${body.voormanGezelId}" does not match any existing gezel. If "${body.voormanGezelId}" is a gilde role/template name, instantiate it first via \`ensure_gezel\` (or force a new one with \`create_gezel\`), then pass the returned gezel id here.`,
          },
          400,
        );
      }
    }
    const project = await ctx.store.updateProject(id, body);
    if (
      body.managedWorkspaceWritePolicy !== undefined ||
      body.allowGezelWrites !== undefined ||
      body.codexPermissionMode !== undefined ||
      body.claudePermissionMode !== undefined ||
      body.linkedProjectIds !== undefined
    ) {
      // Permission posture and linked-project guidance are baked into managed
      // MCP surfaces and the system prompt. Tear down this project's cached
      // surfaces so the next turn/list/invoke observes the new setting
      // immediately.
      await ctx.chat.resetProjectToolsets(id);
    }
    return c.json(project);
  });

  // Delete a project. `?removeWorkspace=1` additionally deletes the internal
  // workspace + artifacts — honored by the Store only when the workspace is
  // gezel-internal (an external `workingDir` is never removed). The default is
  // a safe delete that preserves the user's files on disk.
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const removeWorkspace = c.req.query('removeWorkspace') === '1';
    try {
      const result = await ctx.store.deleteProject(id, { removeWorkspace });
      ctx.chatEvents.publishProjectEvent(id, {
        type: 'project_deleted',
        projectId: id,
        name: result.name,
      });
      return c.json({ ok: true, ...result });
    } catch (err) {
      if (err instanceof ProjectDeleteError) {
        return c.json(
          { error: err.message, reason: err.reason },
          err.reason === 'not_found' ? 404 : 400,
        );
      }
      throw err;
    }
  });

  /**
   * Project gezel roster endpoints. The roster is advisory — adding a
   * gezel surfaces them in "team" UX and history, removing them just
   * drops the roster entry without revoking access. Auto-add already
   * fires from chat/session/task/voorman paths; these routes are for
   * explicit user/UI-driven changes.
   */
  app.get('/:id/gezels', async (c) => {
    const id = c.req.param('id');
    const project = await ctx.store.getProject(id);
    if (!project) return c.json({ error: 'not found' }, 404);
    return c.json({ projectId: id, gezelIds: project.gezelIds ?? [] });
  });

  // Catalog craftbooks applicable to THIS project — those whose
  // `requirements` (GitHub-connected, non-main branch, …) are met. Greenfield
  // project starters are also omitted once the workspace looks like an
  // established codebase. The command launcher rail renders this exact set.
  //
  // `missingToolsets` is a sibling map (craftbook id → unmet required
  // toolsets) the launcher uses to render a "needs setup" affordance.
  // Unlike `requirements`, a missing toolset does NOT hide the craftbook
  // — it stays listed so the user can install it inline.
  app.get('/:id/craftbooks', async (c) => {
    const id = c.req.param('id');
    const establishedCodebase = await projectHasEstablishedCodebase(ctx.store, id);
    const requirementContext = await craftbookContextForProject(ctx.store, id, ctx.git);
    const catalogItems = await listApplicableCraftbooks(ctx.catalog, ctx.store, id, {
      establishedCodebase,
      requirementContext,
    });
    // Project-local books (including project-type installs) shadow same-id
    // catalog entries — mirroring the task resolver's precedence.
    const projectItems = await projectCraftbookSummaries(ctx.store, id, { requirementContext });
    const projectIds = new Set(projectItems.map((it) => it.manifest.id));
    const items = [
      ...projectItems,
      ...catalogItems.filter((it) => !projectIds.has(it.manifest.id)),
    ];
    const missingToolsets = await missingToolsetsForCraftbooks(ctx.store, items, id);
    // Resolve the project's type (user override → auto-detected → none) and
    // compute the curated suggested subset. Additive fields: older clients
    // ignore them and keep showing the full list.
    const project = await ctx.store.getProject(id).catch(() => null);
    const type = project ? getProjectType(resolveProjectTypeId(project)) : undefined;
    const suggested = new Set(suggestedCraftbookIdsForType(items, type));
    // Books the project's type installed are suggested by definition —
    // the type curated them; no tag intersection required.
    for (const it of projectItems) {
      const prov = await ctx.store.readProjectCraftbookProvenance(id, it.manifest.id);
      if (prov?.installedBy === 'project-type') suggested.add(it.manifest.id);
    }
    return c.json({
      items,
      missingToolsets,
      projectType: type ? { id: type.id, label: type.label } : null,
      suggestedIds: [...suggested],
      establishedCodebase,
    });
  });

  /**
   * Apply a custom project type to this project: render its about/mission,
   * create its gezels (setting the voorman), install its scripts, seed its
   * workspace, and stamp `projectType` provenance. See docs/project-types.md.
   * Returns the instantiation report (including deferred composition).
   */
  app.post('/:id/apply-project-type', async (c) => {
    const id = c.req.param('id');
    const body = ApplyProjectTypeRequestSchema.parse(await c.req.json());
    const project = await ctx.store.getProject(id).catch(() => null);
    if (!project) return c.json({ error: 'project not found' }, 404);
    try {
      const applied = await applyProjectType(
        { store: ctx.store, catalog: ctx.catalog, home: ctx.home },
        { projectId: id, typeId: body.typeId, version: body.version, params: body.params },
      );
      await ctx.history.log({
        kind: 'project.updated',
        projectId: id,
        summary: `Applied project type ${applied.typeId}@${applied.version}`,
        details: { projectType: applied.typeId, version: applied.version },
      });
      return c.json(applied);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** Package the project's AI App into a `.gezapp` artifact. */
  app.post('/:id/ai-apps/export', async (c) => {
    const id = c.req.param('id');
    const project = await ctx.store.getProject(id).catch(() => null);
    if (!project) return c.json({ error: 'project not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      typeId?: string;
      version?: string;
      publisherName?: string;
      publisherUrl?: string;
    };
    const typeId = body.typeId ?? project.projectType?.id;
    if (!typeId) {
      return c.json({ error: 'no typeId given and this project has no applied project type' }, 400);
    }
    try {
      const { buffer, manifest } = await packGezapp(
        { catalog: ctx.catalog },
        {
          typeId,
          ...(body.version ? { version: body.version } : {}),
          ...(body.publisherName
            ? {
                publisher: {
                  name: body.publisherName,
                  ...(body.publisherUrl ? { url: body.publisherUrl } : {}),
                },
              }
            : {}),
          createdAt: new Date().toISOString(),
          exportedFromProject: id,
        },
      );
      const slug = typeId.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '') || 'ai-app';
      const artifactPath = `shared/${slug}.gezapp`;
      const written = await ctx.store.writeProjectArtifactBinary(id, artifactPath, buffer);
      return c.json({ path: written, artifactPath, manifest, bytes: buffer.length });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  /** Preview or install a `.gezapp` from this project's artifacts. */
  app.post('/:id/ai-apps/import', async (c) => {
    const id = c.req.param('id');
    const project = await ctx.store.getProject(id).catch(() => null);
    if (!project) return c.json({ error: 'project not found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { path?: string; confirm?: boolean };
    if (!body.path) return c.json({ error: 'missing artifact path to the .gezapp file' }, 400);
    const full = safeJoin(ctx.store.projectArtifactsDir(id), body.path);
    if (!full || !(await realpathContained(ctx.store.projectArtifactsDir(id), full))) {
      return c.json({ error: 'invalid path' }, 400);
    }
    let buffer: Buffer;
    try {
      const info = await stat(full);
      if (!info.isFile()) return c.json({ error: 'the .gezapp path is not a file' }, 400);
      if (info.size > GEZAPP_MAX_ARCHIVE_BYTES) {
        return c.json(
          { error: `.gezapp exceeds ${GEZAPP_MAX_ARCHIVE_BYTES} byte archive limit` },
          400,
        );
      }
      buffer = await readFile(full);
    } catch {
      return c.json({ error: `no file at artifacts/${body.path}` }, 404);
    }
    try {
      const result = await importGezapp({ home: ctx.home, catalog: ctx.catalog }, buffer, {
        confirm: Boolean(body.confirm),
      });
      if (result.installed) await ctx.chat.resetClient();
      return c.json(result);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // Project-wide MCP tools the terminal can run (the full, NOT role-filtered
  // surface). Powers the terminal's tool autocomplete; execution flows through
  // the terminal run path (resolved server-side), not a separate invoke route.
  app.get('/:id/tools', async (c) => {
    const id = c.req.param('id');
    try {
      const tools = await ctx.chat.listProjectTools(id);
      return c.json({
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  app.post('/:id/gezels', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as { gezelId?: unknown };
    const gezelId = typeof body.gezelId === 'string' ? body.gezelId : '';
    if (!gezelId) return c.json({ error: 'gezelId required' }, 400);
    // Existence check at the boundary. The store accepts unknown ids
    // (auto-add path needs to be permissive), so the explicit
    // user/UI/MCP-driven add path is the right place to surface
    // "you typo'd the id".
    const gezel = await ctx.store.getGezel(gezelId).catch(() => null);
    if (!gezel) return c.json({ error: `gezel "${gezelId}" not found` }, 404);
    const result = await ctx.store.addGezelToProject(id, gezelId, { source: 'manual' });
    const project = await ctx.store.getProject(id);
    if (!project) return c.json({ error: 'not found' }, 404);
    return c.json({ ...result, projectId: id, gezelIds: project.gezelIds ?? [] });
  });

  app.delete('/:id/gezels/:gezelId', async (c) => {
    const id = c.req.param('id');
    const gezelId = c.req.param('gezelId');
    const result = await ctx.store.removeGezelFromProject(id, gezelId, { source: 'manual' });
    const project = await ctx.store.getProject(id);
    if (!project) return c.json({ error: 'not found' }, 404);
    return c.json({ ...result, projectId: id, gezelIds: project.gezelIds ?? [] });
  });

  app.post('/:id/install', async (c) => {
    const id = c.req.param('id');
    const existingProject = await ctx.store.getProject(id);
    if (!existingProject) return c.json({ error: 'project not found' }, 404);
    const body = InstallPackageRequestSchema.parse(await c.req.json());
    const result = await installPackage({
      home: ctx.home,
      projectId: id,
      packageName: body.name,
      version: body.version,
    });
    if (!result.ok) return c.json({ error: result.error, log: result.log }, 500);
    await ctx.store.touchProject(id);
    const project = await ctx.store.getProject(id);
    if (!project) return c.json({ error: 'not found' }, 404);
    return c.json({ project, log: result.log });
  });

  // ── per-project approval state ──
  // Aggregates the two stores (npm-allowlist.json + command-approvals.json)
  // plus the gezel-shipped npm allowlist into one snapshot. Read-only for
  // now; the user can already approve/decline via the question-card flow
  // when the gezel actually invokes a tool.
  app.get('/:id/approvals', async (c) => {
    const id = c.req.param('id');
    const [allow, commands] = await Promise.all([
      readProjectAllowlist(ctx.home, id),
      readCommandApprovals(ctx.home, id),
    ]);
    return c.json({
      npmApproved: allow.approved.map((e) => ({
        package: e.package,
        version: e.version,
        at: e.at,
        approvedBy: e.approvedBy,
      })),
      npmDeclined: allow.declined.map((e) => ({
        package: e.package,
        version: e.version,
        at: e.at,
      })),
      scriptApprovals: commands.scripts,
      npxApprovals: commands.npx,
      npmShipped: SHIPPED_ALLOWLIST.map((e) => ({
        package: e.package,
        allowedVersions: [...e.allowedVersions],
      })),
    });
  });

  // ── workspace index (commands + files + tokens) ──
  // The full index lives on disk under ~/.gezel/projects/{id}/_index/.
  // These routes expose a thin slice for the UI:
  //   - `/index`         → commands.json + meta (used by the Commands panel)
  //   - `/index/status`  → just meta + state (polled cheaply by status bar)
  //   - `/index/refresh` → kick off a re-scan; returns immediately

  app.get('/:id/index', async (c) => {
    const id = c.req.param('id');
    const index = await ctx.workspaceIndex.readCommandIndex(id);
    if (!index) return c.json({ error: 'not yet indexed' }, 404);
    return c.json(index);
  });

  // Workspace file/dir paths matching a prefix — backs the terminal's
  // file-path autocomplete. With `detail=1`, returns the complete flat file
  // list from the last static scan (`{path, size, mtimeMs}` per file) —
  // backs the UI's flat "by last modified" workspace view. Empty for
  // never-indexed/disabled projects; callers read `/index/status` to tell
  // those states apart.
  app.get('/:id/index/files', async (c) => {
    const id = c.req.param('id');
    if (c.req.query('detail') === '1') {
      const files = await ctx.workspaceIndex.readFiles(id);
      const visibleFiles =
        c.req.query('hidden') === '1'
          ? files
          : files.filter((file) => !isOfficeLockName(file.path.split('/').at(-1) ?? ''));
      return c.json({ files: visibleFiles, total: visibleFiles.length });
    }
    const prefix = c.req.query('prefix') ?? '';
    const paths = await ctx.workspaceIndex.searchWorkspaceFiles(id, prefix);
    return c.json({ paths });
  });

  app.get('/:id/index/status', async (c) => {
    const id = c.req.param('id');
    const status = await ctx.workspaceIndex.statusForUi(id);
    // Drive state rides along so every window shows "scan running" whether
    // this client, another window, or the night-shift catch-up started it.
    const aiDrive = ctx.indexEnrichment.driveMode(id);
    return c.json(aiDrive ? { ...status, aiDrive } : status);
  });

  app.post('/:id/index/refresh', async (c) => {
    const id = c.req.param('id');
    const status = await ctx.workspaceIndex.refresh(id);
    return c.json({ ok: true, status });
  });

  // Ask a running on-demand drive to stop at its next batch boundary.
  // Completed work stays in the index; `stopping: false` means no drive
  // was running (already drained, or never started).
  app.post('/:id/index/enrich/stop', (c) => {
    const id = c.req.param('id');
    const stopping = ctx.indexEnrichment.stopDrive(id);
    return c.json({ ok: true as const, stopping });
  });

  // On-demand enrichment drive ("study now"): ONE bounded pass per request,
  // the caller loops until `drained`. Mini-batches of 2 keep the worst-case
  // overshoot to ~2 summarizer calls past the budget, so the response stays
  // inside ordinary HTTP client timeouts even with a slow local model.
  app.post('/:id/index/enrich', async (c) => {
    const id = c.req.param('id');
    const body = DriveIndexEnrichmentRequestSchema.parse(await c.req.json().catch(() => ({})));
    const project = await ctx.store.getProject(id);
    if (!project) return c.json({ error: 'not found' }, 404);
    if (project.indexingEnabled === false) {
      return c.json(
        {
          error: 'indexing-disabled',
          message: 'Workspace indexing is disabled for this project.',
        },
        409,
      );
    }
    const boekwachter = await resolveProjectBoekwachter(ctx.store, id);
    if (!boekwachter) {
      // The LLM tiers (summaries, reviews, media) genuinely need the roster
      // opt-in — but the always-on local embed tiers do not, and "update the
      // index" from an unstaffed project should still deliver what it can.
      // Run the embed drain and answer honestly instead of a bare 409.
      if (!(await ctx.indexingJob.isPaused())) {
        ctx.indexEnrichment.drainEmbedOnly(id);
      }
      const pending = await ctx.contentIndex.countNeedingEnrichment(id);
      return c.json({
        paused: false,
        mode: 'embed-only' as const,
        files: 0,
        summarized: 0,
        embedded: 0,
        pending,
        areasUpdated: 0,
        architectureUpdated: false,
        drained: false,
        hint: 'No Boekwachter on this crew — semantic-search embeddings are being refreshed; add a Boekwachter to unlock AI summaries and reviews.',
      });
    }
    if (await ctx.indexingJob.isPaused()) {
      const pending = await ctx.contentIndex.countNeedingEnrichment(id);
      return c.json({
        paused: true,
        files: 0,
        summarized: 0,
        embedded: 0,
        pending,
        areasUpdated: 0,
        architectureUpdated: false,
        drained: false,
      });
    }
    if (body.intensity) {
      // Job mode: start the drive (static refresh + every AI tier to drain)
      // and return immediately — a full-bore drain can outlive any HTTP
      // timeout. Progress flows over `index_progress` + `/index/status`.
      const { alreadyRunning } = ctx.indexEnrichment.drive(id, {
        intensity: body.intensity,
        reviews: body.reviews !== false,
      });
      const pending = await ctx.contentIndex.countNeedingEnrichment(id);
      const reviewCounts = await ctx.contentIndex.reviewCounts(id).catch(() => null);
      return c.json({
        paused: false,
        files: 0,
        summarized: 0,
        embedded: 0,
        pending,
        areasUpdated: 0,
        architectureUpdated: false,
        ...(body.reviews !== false
          ? { reviewed: 0, reviewPending: reviewCounts?.pending ?? 0 }
          : {}),
        drained: false,
        started: true,
        alreadyRunning,
        mode: body.intensity,
      });
    }
    // Legacy bounded pass — but current-files first: enriching against a
    // stale walk misses new files, so the AI budget clock starts AFTER the
    // awaited static refresh.
    await ctx.workspaceIndex.refreshAndWait(id).catch(() => {});
    const maxFiles = body.maxFiles ?? 10;
    const deadline = Date.now() + (body.budgetMs ?? 45_000);
    const deps = await buildEnrichDeps(ctx.store, ctx.chat, { boekwachter });
    let files = 0;
    let summarized = 0;
    let embedded = 0;
    let drained = false;
    while (files < maxFiles && Date.now() < deadline) {
      const pass = await ctx.contentIndex.enrich(id, deps, 2);
      if (!pass || pass.files === 0) {
        drained = pass !== null;
        break;
      }
      files += pass.files;
      summarized += pass.summarized;
      embedded += pass.embedded;
    }
    if (!drained && files >= 0) {
      drained = (await ctx.contentIndex.countNeedingEnrichment(id)) === 0;
    }
    let areasUpdated = 0;
    let architectureUpdated = false;
    if (drained && body.areas) {
      const areas = await ctx.contentIndex.enrichAreas(id, deps);
      areasUpdated = areas?.areasUpdated ?? 0;
      architectureUpdated = areas?.architectureUpdated ?? false;
    }
    // Review pass — strictly after the summary tier drains, same mini-batch
    // discipline (worst-case overshoot ~2 review calls past the budget).
    let reviewed = 0;
    if (drained && body.reviews) {
      while (files + reviewed < maxFiles && Date.now() < deadline) {
        const pass = await ctx.contentIndex.review(id, deps, 2);
        if (!pass || pass.files === 0) break;
        reviewed += pass.files;
      }
    }
    const pending = await ctx.contentIndex.countNeedingEnrichment(id);
    const reviewCounts = body.reviews
      ? await ctx.contentIndex.reviewCounts(id).catch(() => null)
      : null;
    return c.json({
      paused: false,
      files,
      summarized,
      embedded,
      pending,
      areasUpdated,
      architectureUpdated,
      ...(body.reviews ? { reviewed, reviewPending: reviewCounts?.pending ?? 0 } : {}),
      drained,
    });
  });

  app.get('/:id/index/skills', async (c) => {
    const id = c.req.param('id');
    const result = await ctx.workspaceIndex.readSkills(id);
    return c.json(result);
  });

  // ── chat timeline (interleaved across all sessions in this project) ──

  app.get('/:id/timeline', async (c) => {
    const id = c.req.param('id');
    const response = await buildTimeline(ctx, {
      projectId: id,
      rawLimit: c.req.query('limit'),
      before: c.req.query('before'),
      gezelId: c.req.query('gezel'),
      taskRef: c.req.query('task'),
    });
    return c.json(response);
  });

  // ── working directory config ──

  app.put('/:id/working-dir', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as { workingDir?: string };
    const project = await ctx.store.updateProjectWorkingDir(id, body.workingDir);
    return c.json(project);
  });

  // ── reveal in OS file manager ──

  app.post('/:id/reveal', async (c) => {
    const id = c.req.param('id');
    const which = c.req.query('which') ?? 'artifacts';
    const dir =
      which === 'workspace'
        ? await ctx.store.projectWorkspaceDir(id)
        : ctx.store.projectArtifactsDir(id);
    // Use execFile with an argv array — never `exec` with an
    // interpolated shell string. A project workingDir can contain shell
    // metacharacters (it is settable by the model via `update_project`),
    // and `open "${dir}"` would let `"; rm -rf … #` inject host commands
    // that run as the user the next time someone clicks "reveal".
    const { execFile } = await import('node:child_process');
    const launcher: { cmd: string; args: string[] } =
      process.platform === 'darwin'
        ? { cmd: 'open', args: [dir] }
        : process.platform === 'win32'
          ? { cmd: 'explorer', args: [dir] }
          : { cmd: 'xdg-open', args: [dir] };
    // Fire-and-forget: the file manager owns the window; ignore launcher
    // exit codes (explorer.exe returns non-zero even on success).
    execFile(launcher.cmd, launcher.args, () => {});
    return c.json({ ok: true, path: dir });
  });

  app.get('/:id/reference-file-location', async (c) => {
    const id = c.req.param('id');
    const request = ReferenceFileLocationRequestSchema.parse({
      kind: c.req.query('kind'),
      path: c.req.query('path'),
    });
    const base =
      request.kind === 'artifact'
        ? ctx.store.projectArtifactsDir(id)
        : request.kind === 'workspace'
          ? await ctx.store.projectWorkspaceDir(id)
          : ctx.store.documentsDir();
    const joined = safeJoin(base, referenceRelativePath(request));
    if (!joined || !(await realpathContained(base, joined))) {
      return c.json({ error: 'path traversal' }, 400);
    }
    try {
      const file = await stat(joined);
      if (!file.isFile()) return c.json({ error: 'not found' }, 404);
      const path = await realpath(joined);
      return c.json(ReferenceFileLocationResponseSchema.parse({ path }));
    } catch {
      return c.json({ error: 'not found' }, 404);
    }
  });

  app.post('/:id/reveal-reference', async (c) => {
    const id = c.req.param('id');
    const request = ReferenceFileLocationRequestSchema.parse({
      kind: c.req.query('kind'),
      path: c.req.query('path'),
    });
    const base =
      request.kind === 'artifact'
        ? ctx.store.projectArtifactsDir(id)
        : request.kind === 'workspace'
          ? await ctx.store.projectWorkspaceDir(id)
          : ctx.store.documentsDir();
    const joined = safeJoin(base, referenceRelativePath(request));
    if (!joined || !(await realpathContained(base, joined))) {
      return c.json({ error: 'path traversal' }, 400);
    }
    let path: string;
    try {
      const file = await stat(joined);
      if (!file.isFile()) return c.json({ error: 'not found' }, 404);
      path = await realpath(joined);
    } catch {
      return c.json({ error: 'not found' }, 404);
    }

    // Reveal the file without launching its OS association. Recent paths can
    // point at scripts or binaries, and `/open` must not turn an agent-written
    // reference into an execution surface.
    const { execFile } = await import('node:child_process');
    const launcher: { cmd: string; args: string[] } =
      process.platform === 'darwin'
        ? { cmd: 'open', args: ['-R', path] }
        : process.platform === 'win32'
          ? { cmd: 'explorer', args: ['/select,', path] }
          : { cmd: 'xdg-open', args: [dirname(path)] };
    execFile(launcher.cmd, launcher.args, { windowsHide: true }, () => {});
    return c.json(ReferenceFileLocationResponseSchema.parse({ path }));
  });

  // ── artifacts (read-write, always internal) ──

  app.get('/:id/artifacts', async (c) => {
    const id = c.req.param('id');
    const subpath = c.req.query('path') ?? '';
    const recursive = c.req.query('recursive') === '1';
    // `stats=1` opts into per-file mtimes; only meaningful with `recursive=1`
    // (the shallow listing has no stats path).
    const withStats = c.req.query('stats') === '1';
    // `hidden=1` is the file panel's "show hidden files" toggle: Office lock
    // files, dotfiles, plus the reserved shadow/ cache.
    const includeHidden = c.req.query('hidden') === '1';
    if (recursive) {
      const detailed = await ctx.store.listProjectArtifactsRecursiveDetailed(id, {
        ...(withStats ? { withStats: true } : {}),
        ...(includeHidden ? { includeHidden: true } : {}),
        ...(subpath ? { subpath } : {}),
      });
      return c.json({ files: detailed.entries, truncated: detailed.truncated });
    }
    return c.json({
      files: await ctx.store.listProjectArtifacts(id, subpath, { includeHidden }),
    });
  });

  app.get('/:id/artifacts/read', async (c) => {
    const id = c.req.param('id');
    const filePath = c.req.query('path');
    if (!filePath) return c.json({ error: 'missing ?path=' }, 400);
    if (c.req.query('raw') === '1') {
      return serveRawFile(c, ctx.store.projectArtifactsDir(id), normalizeArtifactPath(filePath));
    }
    const content = await ctx.store.readProjectArtifact(id, filePath);
    if (content === null) return c.json({ error: 'not found' }, 404);
    // Byte size rides along so a viewer that cannot preview the content
    // (binaries) can still say how big the file is. The decoded string's
    // length does not answer that — UTF-8 replacement chars destroy it.
    const size = await ctx.store.projectArtifactSize(id, filePath);
    return c.json({ path: filePath, content, ...(size === null ? {} : { size }) });
  });

  app.get('/:id/artifacts/resolve', async (c) => {
    const id = c.req.param('id');
    const filePath = c.req.query('path');
    if (!filePath) return c.json({ error: 'missing ?path=' }, 400);
    const res = await ctx.store.resolveProjectArtifact(id, filePath);
    return c.json(res);
  });

  // Read with optional line-based slicing — used by the `read_artifact`
  // MCP tool when the model passes lines/head/tail to navigate large
  // outboard-storage artifacts. Mutually exclusive: at most one of
  // `lines`, `head`, `tail`. Empty opts → full content.
  //
  // Query string layout:
  //   ?path=<rel>
  //   ?lines=<start>,<count>            (e.g. lines=10,50 → lines [10,60))
  //   ?head=<n>
  //   ?tail=<n>
  //
  // We parse once into the slice opts shape and forward to the store.
  // Invalid number formats fall through to "no slice" rather than
  // erroring — defense in depth, since a tool-call shape miss
  // shouldn't lock the model out of the artifact.
  app.get('/:id/artifacts/slice', async (c) => {
    const id = c.req.param('id');
    const filePath = c.req.query('path');
    if (!filePath) return c.json({ error: 'missing ?path=' }, 400);
    const opts: { lines?: { start: number; count: number }; head?: number; tail?: number } = {};
    const linesQ = c.req.query('lines');
    if (linesQ) {
      const parts = linesQ.split(',').map((p) => Number.parseInt(p ?? '', 10));
      const s = parts[0];
      const n = parts[1];
      if (
        s !== undefined &&
        n !== undefined &&
        Number.isFinite(s) &&
        Number.isFinite(n) &&
        s >= 1 &&
        n >= 0
      ) {
        opts.lines = { start: s, count: n };
      }
    }
    const headQ = c.req.query('head');
    if (headQ && opts.lines === undefined) {
      const n = Number.parseInt(headQ, 10);
      if (Number.isFinite(n) && n >= 0) opts.head = n;
    }
    const tailQ = c.req.query('tail');
    if (tailQ && opts.lines === undefined && opts.head === undefined) {
      const n = Number.parseInt(tailQ, 10);
      if (Number.isFinite(n) && n >= 0) opts.tail = n;
    }
    const res = await ctx.store.readProjectArtifactSlice(id, filePath, opts);
    return c.json(res);
  });

  // Regex-grep over a single artifact. Body shape mirrors
  // GrepArtifactRequestSchema in core/schemas/api.ts. POST (not GET)
  // because the pattern can include characters awkward to URL-encode.
  app.post('/:id/artifacts/grep', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as {
      path?: string;
      pattern?: string;
      caseInsensitive?: boolean;
      contextLines?: number;
      maxMatches?: number;
    };
    if (!body.path) return c.json({ error: 'missing path' }, 400);
    if (!body.pattern) return c.json({ error: 'missing pattern' }, 400);
    const res = await ctx.store.grepProjectArtifact(id, body.path, {
      pattern: body.pattern,
      ...(body.caseInsensitive !== undefined ? { caseInsensitive: body.caseInsensitive } : {}),
      ...(body.contextLines !== undefined ? { contextLines: body.contextLines } : {}),
      ...(body.maxMatches !== undefined ? { maxMatches: body.maxMatches } : {}),
    });
    return c.json(res);
  });

  app.put('/:id/artifacts/write', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as {
      path: string;
      content: string;
      gezelId?: string;
      sessionId?: string;
    };
    if (!body.path) return c.json({ error: 'missing path' }, 400);
    try {
      await ctx.store.writeProjectArtifact(id, body.path, body.content, {
        initiatedByGezel: Boolean(body.gezelId || body.sessionId),
      });
      return c.json({ ok: true, path: body.path });
    } catch (err) {
      if (
        err instanceof ConnectorCorpusWriteDeniedError ||
        err instanceof ShadowPathWriteDeniedError
      ) {
        return c.json({ error: err.message, code: err.code }, 403);
      }
      throw err;
    }
  });

  // Binary sibling of `/artifacts/write`. Body is the raw bytes, the
  // `?path=` query is the artifact-relative target. Powers the squisq
  // editor's Files panel for project-scoped documents — image uploads,
  // attached PDFs, etc. — without invoking the model.
  app.put('/:id/artifacts/raw', async (c) => {
    const id = c.req.param('id');
    const filePath = c.req.query('path');
    if (!filePath) return c.json({ error: 'missing ?path=' }, 400);
    const buf = Buffer.from(await c.req.arrayBuffer());
    try {
      const written = await ctx.store.writeProjectArtifactBinary(id, filePath, buf, {
        createOnly: c.req.query('create') === '1',
      });
      return c.json({ ok: true, path: written });
    } catch (err) {
      if (err instanceof ShadowPathWriteDeniedError) {
        return c.json({ error: err.message, code: err.code }, 403);
      }
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return c.json({ error: 'backup already exists' }, 409);
      }
      throw err;
    }
  });

  app.delete('/:id/artifacts/delete', async (c) => {
    const id = c.req.param('id');
    const filePath = c.req.query('path');
    if (!filePath) return c.json({ error: 'missing ?path=' }, 400);
    await ctx.store.deleteProjectArtifact(id, filePath);
    return c.json({ ok: true });
  });

  app.post('/:id/artifacts/mkdir', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as { path?: string };
    if (!body.path) return c.json({ error: 'missing path' }, 400);
    try {
      const path = await ctx.store.createProjectArtifactFolder(id, body.path);
      return c.json({ ok: true, path });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.post('/:id/artifacts/rename', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as { fromPath?: string; toPath?: string };
    if (!body.fromPath || !body.toPath) return c.json({ error: 'missing fromPath / toPath' }, 400);
    try {
      const moved = await ctx.store.renameProjectArtifactPath(id, body.fromPath, body.toPath);
      return c.json({ ok: true, ...moved });
    } catch (err) {
      const status =
        err instanceof ArtifactPathNotFoundError
          ? 404
          : err instanceof ArtifactPathExistsError
            ? 409
            : 400;
      return c.json({ error: err instanceof Error ? err.message : String(err) }, status);
    }
  });

  // ── run a user-authored Playwright script against Chromium ──
  //
  // Path is relative to the project artifacts root. `.spec.ts`/`.test.ts`
  // paths (or `mode: 'test'`) run through Playwright's test runner;
  // anything else runs as a bare script via `node --experimental-strip-types`.
  // Both paths execute with cwd = the installed @playwright/mcp package
  // directory and register a loader hook so Node resolves Playwright imports
  // from that managed toolset rather than from the artifact file's directory.
  // Test mode propagates the hook to workers through NODE_OPTIONS. The
  // system-toolset bootstrap is a hard prereq.
  app.post('/:id/run-playwright', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as { path: string; mode?: 'test' | 'script' };
    if (!body.path) return c.json({ error: 'missing path' }, 400);

    // Defense in depth: hiding the MCP tool is not a sufficient execution
    // boundary. A stale session or direct API caller can still reach this
    // route, and a Playwright script is arbitrary user-authored Node code.
    const securityPolicy = resolveSecurityPolicy(await ctx.store.readConfig());
    if (!securityPolicy.allowScriptExecution) {
      return c.json(
        {
          ok: false,
          log: '',
          error:
            'Security policy: script execution is disabled. Raise the security level in Settings → Security & Compliance to run Playwright scripts.',
        },
        403,
      );
    }

    // Anticipated business-logic failures below return HTTP 200 with
    // `{ok: false, error, log}` so the MCP tool layer can surface the
    // message to the calling gezel. The generic `GezelClient.request`
    // helper throws on any non-2xx — structured error text inside
    // non-2xx bodies gets lost to the caller as a plain "API error N".
    // Only genuinely malformed input (path traversal, missing `path`)
    // stays on 4xx.
    // Primary happy path: Store already has a record, we use it.
    // Self-heal path: Store is missing the record but the tracking
    // file says it's installed and the expected path exists on disk.
    // Common after app updates or crashes that truncate
    // installed-toolsets.json — the bootstrap re-registration pass
    // fixes this at startup, but only at startup. Running the same
    // check on-demand here lets the tool succeed immediately instead
    // of telling the user to restart. Fast + idempotent (just a few
    // fs checks + a JSON rewrite).
    let installed = await ctx.store.listInstalledToolsets({ kind: 'system' });
    let playwright = installed.find((t) => t.toolsetId === '@playwright/mcp');
    if (!playwright?.installPath) {
      const { reconcileSystemToolsetFromDisk } = await import('../../system-toolsets/bootstrap.js');
      const result = await reconcileSystemToolsetFromDisk({
        home: ctx.home,
        store: ctx.store,
        toolsetId: '@playwright/mcp',
      });
      if (result.reconciled) {
        installed = await ctx.store.listInstalledToolsets({ kind: 'system' });
        playwright = installed.find((t) => t.toolsetId === '@playwright/mcp');
      }
    }
    if (!playwright?.installPath) {
      // Genuine "not installed yet". Kick off bootstrap in the
      // background if nothing's currently running — this covers the
      // case where the startup bootstrap crashed or was skipped
      // entirely, leaving the user stuck forever on every retry. We
      // don't await: a fresh install includes a 2–5 minute Chromium
      // download, too long to block an HTTP tool call on. The second
      // tool attempt a couple minutes later will find things in
      // place.
      const phase = ctx.systemStatus.current.phase;
      if (phase === 'idle' || phase === 'setup-incomplete' || phase === 'error') {
        void (async () => {
          try {
            const { runSystemBootstrap } = await import('../../system-toolsets/bootstrap.js');
            await runSystemBootstrap({
              home: ctx.home,
              store: ctx.store,
              statusBus: ctx.systemStatus,
              logger: {
                info: (m) => log.info(m),
                warn: (m) => log.warn(m),
                error: (m) => log.error(m),
              },
            });
          } catch (err) {
            log.warn(
              `[run-playwright] background bootstrap failed: ${err instanceof Error ? err.message : err}`,
            );
          }
        })();
      }
      return c.json({
        ok: false,
        log: '',
        error: formatPlaywrightNotReadyError(ctx.systemStatus.current),
      });
    }

    const base = ctx.store.projectArtifactsDir(id);
    const absScript = safeJoin(base, body.path);
    if (!absScript) {
      return c.json({ ok: false, log: '', error: 'path traversal blocked' }, 400);
    }

    // Agents hallucinate paths — a Playwright spec that doesn't exist
    // would otherwise blow up deep inside Playwright's CLI with a
    // cryptic ENOENT. Tell them clearly that the file is missing, with
    // a nudge to write it first. Fuzzy-resolve by basename so a minor
    // prefix mistake ("scripts/x" vs "tests/x") heals itself.
    const { existsSync } = await import('node:fs');
    let scriptAbs = absScript;
    let scriptRel = body.path;
    if (!existsSync(absScript)) {
      const resolved = await ctx.store.resolveProjectArtifact(id, body.path);
      if (resolved.kind === 'found') {
        const healed = safeJoin(base, resolved.path);
        if (!healed) return c.json({ ok: false, log: '', error: 'path traversal blocked' }, 400);
        scriptAbs = healed;
        scriptRel = resolved.path;
      } else if (resolved.kind === 'ambiguous') {
        return c.json({
          ok: false,
          log: '',
          error: `"${body.path}" matches multiple artifacts: ${resolved.candidates.join(', ')}. Pass the full path and retry.`,
        });
      } else {
        // Suggest the canonical path the team uses so scripts don't
        // scatter across the artifacts tree. Derive a reasonable
        // default from whatever basename the model gave us.
        const basename = body.path.split('/').pop() ?? 'script.ts';
        const suggested = /\.(spec|test)\.(mts|mjs|ts|js|cjs|cts)$/.test(basename)
          ? `tests/${basename}`
          : `scripts/${basename.endsWith('.ts') ? basename : `${basename}.ts`}`;
        return c.json({
          ok: false,
          log: '',
          error: `Script "${body.path}" doesn't exist in this project's artifacts yet — you need to write it first. **The canonical home for automation scripts is \`scripts/\`** (bare TS) and \`tests/\` for Playwright \`*.spec.ts\` files; please put yours at \`${suggested}\`. Call \`write_artifact({ path: "${suggested}", content: "..." })\` with the full script body, then retry \`run_playwright_script({ path: "${suggested}" })\`. (If instead you only need to read one page once, \`browser_navigate\` + \`browser_snapshot\` handle that without a file — but writing a small script is the durable move and leaves something the team can re-run.)`,
        });
      }
    }

    const isTest =
      body.mode === 'test' || /\.(spec|test)\.(mts|mjs|ts|js|cjs|cts)$/.test(scriptRel);
    let testConfigDir: string | undefined;
    try {
      let args: string[];
      if (isTest) {
        // Playwright only discovers tests under its configured testDir. The
        // artifact lives outside the managed toolset cwd, so passing its
        // absolute path as a positional filter produces "No tests found".
        // Point a one-shot config at the artifact directory and match only
        // the requested file; leave the user's artifacts untouched.
        testConfigDir = await mkdtemp(join(tmpdir(), 'gezel-playwright-test-'));
        const configPath = join(testConfigDir, 'playwright.config.mjs');
        await writeFileAtomic(configPath, playwrightTestConfigSource(scriptAbs));
        args = [
          PNPM_HOISTED_NODE_LINKER,
          '--dir',
          playwright.installPath,
          'exec',
          'playwright',
          'test',
          '--config',
          configPath,
        ];
      } else {
        args = [
          PNPM_HOISTED_NODE_LINKER,
          '--dir',
          playwright.installPath,
          'exec',
          'node',
          '--experimental-strip-types',
          '--import',
          MANAGED_TOOLSET_IMPORT_HOOK_URL,
          scriptAbs,
        ];
      }
      const pnpm = resolvePnpmCommand(args);

      const result = await new Promise<{ ok: boolean; code: number | null; log: string }>(
        (resolve) => {
          const child = spawnPnpm(pnpm, {
            cwd: playwright.installPath,
            env: {
              ...process.env,
              GEZEL_MANAGED_TOOLSET_ROOT: playwright.installPath,
              PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersDir(ctx.home),
              ...(isTest
                ? { NODE_OPTIONS: nodeOptionsWithManagedToolsetImport(process.env.NODE_OPTIONS) }
                : {}),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let log = '';
          const cap = (chunk: Buffer) => {
            log += chunk.toString('utf8');
            if (log.length > 200_000) log = log.slice(-200_000); // cap to 200KB
          };
          child.stdout?.on('data', cap);
          child.stderr?.on('data', cap);
          child.on('error', (err) =>
            resolve({ ok: false, code: null, log: `${log}\n${err.message}` }),
          );
          child.on('close', (code) => resolve({ ok: code === 0, code, log }));
        },
      );

      return c.json({
        ok: result.ok,
        log: result.log,
        ...(result.ok ? {} : { error: `exit code ${result.code}` }),
      });
    } finally {
      if (testConfigDir) await rm(testConfigDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // ── workspace (read-only, external or internal) ──

  app.get('/:id/workspace/html-pages', async (c) => {
    const id = c.req.param('id');
    const entries = await ctx.store.listProjectWorkspaceHtmlPages(id);
    return c.json({ files: entries });
  });

  app.get('/:id/workspace', async (c) => {
    const id = c.req.param('id');
    const subpath = c.req.query('path') ?? '';
    const recursive = c.req.query('recursive') === '1';
    // `stats=1` opts into per-file mtimes; only meaningful with `recursive=1`
    // (the shallow listing has no stats path).
    const withStats = c.req.query('stats') === '1';
    // `hidden=1` is the file panel's "show hidden files" toggle: Office lock
    // files, dotfiles, plus vendor directories (node_modules and friends),
    // which are listed but still never walked into.
    const includeHidden = c.req.query('hidden') === '1';
    try {
      if (recursive) {
        const detailed = await ctx.store.listProjectWorkspaceRecursiveDetailed(id, {
          ...(withStats ? { withStats: true } : {}),
          ...(includeHidden ? { includeHidden: true } : {}),
          ...(subpath ? { subpath } : {}),
        });
        return c.json({ files: detailed.entries, truncated: detailed.truncated });
      }
      return c.json({
        files: await ctx.store.listProjectWorkspace(id, subpath, { includeHidden }),
      });
    } catch (err) {
      const mapped = mapWorkspaceError(err);
      return c.json(mapped.body, mapped.status as 400 | 403 | 500);
    }
  });

  app.get('/:id/workspace/read', async (c) => {
    const id = c.req.param('id');
    const filePath = c.req.query('path');
    if (!filePath) return c.json({ error: 'missing ?path=' }, 400);
    try {
      if (c.req.query('raw') === '1') {
        const base = await ctx.store.projectWorkspaceDir(id);
        return serveRawFile(c, base, intoWorkspaceRelative(base, filePath));
      }
      const content = await ctx.store.readProjectWorkspaceFile(id, filePath);
      if (content === null) return c.json({ error: 'not found' }, 404);
      // Byte size rides along so a viewer that cannot preview the content
      // (binaries) can still say how big the file is. The decoded string's
      // length does not answer that — UTF-8 replacement chars destroy it.
      const info = await ctx.store.statProjectWorkspacePath(id, filePath);
      return c.json({
        path: filePath,
        content,
        ...(info.kind === 'file' && info.size !== undefined ? { size: info.size } : {}),
      });
    } catch (err) {
      const mapped = mapWorkspaceError(err);
      return c.json(mapped.body, mapped.status as 400 | 403 | 500);
    }
  });

  // ── Workspace mutations (gated by the managed-write policy) ──

  app.get('/:id/workspace/stat', async (c) => {
    const id = c.req.param('id');
    const filePath = c.req.query('path');
    if (!filePath) return c.json({ error: 'missing ?path=' }, 400);
    try {
      const result = await ctx.store.statProjectWorkspacePath(id, filePath);
      return c.json(result);
    } catch (err) {
      const mapped = mapWorkspaceError(err);
      return c.json(mapped.body, mapped.status as 400 | 403 | 500);
    }
  });

  // Server-side artifact → workspace copy. The model uses this for
  // binaries (images, PDFs, audio) — read_artifact + writeFile would
  // round-trip the content through a JSON string and corrupt
  // non-UTF-8 payloads (the petshop 4-byte logo.png case).
  app.post('/:id/workspace/copy-from-artifact', async (c) => {
    const id = c.req.param('id');
    let body: ReturnType<typeof CopyArtifactToWorkspaceRequestSchema.parse>;
    try {
      body = CopyArtifactToWorkspaceRequestSchema.parse(await c.req.json());
    } catch (err) {
      return c.json(
        { error: `invalid request: ${err instanceof Error ? err.message : String(err)}` },
        400,
      );
    }
    try {
      const result = await ctx.store.copyProjectArtifactToWorkspace(id, body.source, body.dest, {
        ...(body.gezelId ? { gezelId: body.gezelId } : {}),
        ...(body.sessionId ? { sessionId: body.sessionId } : {}),
      });
      return c.json({ ok: true, ...result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith('artifact not found')) {
        return c.json({ error: message }, 404);
      }
      const mapped = mapWorkspaceError(err);
      return c.json(mapped.body, mapped.status as 400 | 403 | 500);
    }
  });

  // POST /:id/workspace/fetch-repo — shallow-clone a public HTTP(S) git
  // URL into the project workspace at `dest` (default `repo`). The
  // `git clone --depth 1` keeps the network cost small and skips the
  // commit-history weight the model doesn't need. After clone we walk
  // the resulting tree (excluding `.git/`) to report file count + total
  // bytes — the calling MCP tool returns those numbers to the model so
  // it can size the review work realistically. Cap at a 5-min git
  // timeout and the workspace-fs writes path so a malicious `dest` like
  // `../../etc/passwd` resolves to `null` and gets a 400.
  app.post('/:id/workspace/fetch-repo', async (c) => {
    const id = c.req.param('id');
    let body: ReturnType<typeof FetchRepoRequestSchema.parse>;
    try {
      body = FetchRepoRequestSchema.parse(await c.req.json());
    } catch (err) {
      return c.json(
        { error: `invalid request: ${err instanceof Error ? err.message : String(err)}` },
        400,
      );
    }

    // URL guard: HTTPS only, drop SSH / non-http schemes outright so the
    // service never depends on the host's SSH agent setup. Also reject
    // file:// because that would let a chat-driven tool exfiltrate
    // arbitrary local paths into the workspace.
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(body.url);
    } catch {
      return c.json({ error: 'invalid URL' }, 400);
    }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      return c.json({ error: 'only http(s) URLs are allowed' }, 400);
    }

    let workspaceDir: string;
    try {
      workspaceDir = await ctx.store.projectWorkspaceDir(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      return c.json({ error: msg }, 500);
    }

    // Default `dest` is `''` (workspace root) — the clone IS the
    // workspace from the model's perspective. Phase 2 of the
    // workspace-fs unification: no more `repo/` subfolder pollution,
    // the model sees `readFile('package.json')` returning the repo's
    // package.json directly. A non-empty `dest` is still supported for
    // the rare case where the caller wants the repo nested.
    const destRel = (body.dest ?? '').replace(/^\/+|\/+$/g, '');
    const destAbs = destRel === '' ? workspaceDir : safeJoin(workspaceDir, destRel);
    if (!destAbs) {
      return c.json({ error: `dest "${destRel}" escapes workspace` }, 400);
    }

    const cloneToWorkspaceRoot = destAbs === workspaceDir;
    if (cloneToWorkspaceRoot) {
      // Cloning at the workspace root — we mustn't `rm -rf` the
      // workspace itself, and git clone requires the target dir to be
      // either nonexistent or empty. Tolerate an existing empty dir,
      // tolerate the framework-seeded bootstrap files (Store seeds
      // package.json/tsconfig.json/.gitignore on project create for
      // non-github projects; if the model decides post-hoc to make a
      // project github-backed via fetch_repo, the bootstrap files
      // shouldn't block us). Bail with a clear error only if the
      // workspace has *real* user content.
      const BOOTSTRAP_FILES = new Set(['package.json', 'tsconfig.json', '.gitignore']);
      try {
        await mkdir(workspaceDir, { recursive: true });
        const entries = await readdir(workspaceDir);
        const nonBootstrap = entries.filter((name) => !BOOTSTRAP_FILES.has(name));
        if (nonBootstrap.length > 0) {
          return c.json(
            {
              error: `workspace is not empty (${nonBootstrap.length} non-bootstrap entries: ${nonBootstrap.slice(0, 5).join(', ')}) — refusing to clone over user content. Pass a non-empty \`dest\` to clone into a subfolder, or clear the workspace first.`,
            },
            409,
          );
        }
        for (const name of entries) {
          if (BOOTSTRAP_FILES.has(name)) {
            await rm(safeJoin(workspaceDir, name)!, { recursive: true, force: true });
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ error: `failed to ensure workspace dir: ${msg}` }, 500);
      }
    } else {
      // Cloning into a subdir of the workspace — safe to wipe (the
      // model can re-fetch by passing the same dest; this is the
      // self-replacing semantics from the pre-Phase-2 design).
      try {
        await rm(destAbs, { recursive: true, force: true });
      } catch {
        // best-effort — rm errors propagate at clone time if real
      }
      try {
        await mkdir(workspaceDir, { recursive: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return c.json({ error: `failed to ensure workspace dir: ${msg}` }, 500);
      }
    }

    try {
      // `git clone --depth 1 --branch <ref> <url> <dest>` works for both
      // branches and tags. Commit SHAs are NOT supported by git clone
      // directly — for those, the caller would need a separate
      // `git fetch <sha> && git checkout <sha>` step, which we don't
      // expose today. Surface a clear error if the user passed a hex SHA.
      const cloneArgs = ['clone', '--depth', '1'];
      if (body.branch) {
        if (/^[0-9a-f]{7,40}$/i.test(body.branch)) {
          return c.json(
            {
              error: `git clone --branch does not accept commit SHAs ("${body.branch}"). Pass a branch name or tag instead.`,
            },
            400,
          );
        }
        cloneArgs.push('--branch', body.branch);
      }
      cloneArgs.push(body.url, destAbs);
      await runGit(cloneArgs, {
        timeoutMs: 5 * 60 * 1000,
      });
    } catch (err) {
      if (err instanceof GitError) {
        return c.json(
          { error: `git clone failed: ${err.stderr.slice(0, 500) || err.message}` },
          500,
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `git clone failed: ${msg}` }, 500);
    }

    // Walk the cloned tree (excluding .git/) to compute the report.
    // 5_000 file cap to match GitManager's MAX_FILES_RETURNED — past
    // that we just stop counting; the response stays sane even if the
    // user pointed us at a monorepo by accident.
    let files = 0;
    let bytes = 0;
    const FILE_CAP = 5_000;
    const stack: string[] = [destAbs];
    const SKIP = new Set(['.git', 'node_modules', '.DS_Store']);
    while (stack.length > 0 && files < FILE_CAP) {
      const dir = stack.pop();
      if (!dir) break;
      let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile()) {
          try {
            const st = await stat(full);
            files += 1;
            bytes += st.size;
            if (files >= FILE_CAP) break;
          } catch {
            // file vanished between readdir + stat — skip
          }
        }
      }
    }

    // Persist github metadata so projectWorkspaceDir + the github tab
    // surface this clone as a normal github-linked project. The
    // explicit clone above bypasses the createProject → ensureClone
    // background path, so we mirror the metadata writes ensureClone
    // would have done. Best-effort — a failure here leaves the clone
    // on disk; the user can re-link via Settings.
    if (cloneToWorkspaceRoot) {
      try {
        await ctx.store.updateProjectGitHub(id, {
          url: body.url,
          ...(body.branch ? { branch: body.branch } : {}),
          checkoutDir: workspaceDir,
        });
      } catch (err) {
        log.warn(
          `[fetch-repo] failed to persist github metadata for ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return c.json({ ok: true, path: destRel, files, bytes });
  });

  // POST /:id/workspace/fetch-diff — clone with `--filter=blob:none`
  // (commits + trees, no blobs until checkout), fetch both refs, write
  // the unified diff at `workspace/<diffPath>`, and check out headRef
  // so the working tree is at the post-change state. Designed for
  // PR-style reviews where the team needs both the change AND the
  // surrounding source for context. `baseRef` / `headRef` accept
  // branches, tags, or SHAs (GitHub allows fetching reachable SHAs).
  app.post('/:id/workspace/fetch-diff', async (c) => {
    const id = c.req.param('id');
    let body: ReturnType<typeof FetchDiffRequestSchema.parse>;
    try {
      body = FetchDiffRequestSchema.parse(await c.req.json());
    } catch (err) {
      return c.json(
        { error: `invalid request: ${err instanceof Error ? err.message : String(err)}` },
        400,
      );
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(body.url);
    } catch {
      return c.json({ error: 'invalid URL' }, 400);
    }
    if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
      return c.json({ error: 'only http(s) URLs are allowed' }, 400);
    }

    let workspaceDir: string;
    try {
      workspaceDir = await ctx.store.projectWorkspaceDir(id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('not found')) return c.json({ error: msg }, 404);
      return c.json({ error: msg }, 500);
    }

    // Phase 2: default `dest` is workspace root. The clone IS the
    // workspace; diff.patch lives alongside as a top-level file.
    const destRel = (body.dest ?? '').replace(/^\/+|\/+$/g, '');
    const destAbs = destRel === '' ? workspaceDir : safeJoin(workspaceDir, destRel);
    if (!destAbs) return c.json({ error: `dest "${destRel}" escapes workspace` }, 400);

    const diffRel = (body.diffPath ?? 'diff.patch').replace(/^\/+|\/+$/g, '');
    const diffAbs = safeJoin(workspaceDir, diffRel);
    if (!diffAbs) return c.json({ error: `diffPath "${diffRel}" escapes workspace` }, 400);

    const cloneToWorkspaceRoot = destAbs === workspaceDir;
    if (cloneToWorkspaceRoot) {
      try {
        await mkdir(workspaceDir, { recursive: true });
        const entries = await readdir(workspaceDir);
        if (entries.length > 0) {
          return c.json(
            {
              error: `workspace is not empty (${entries.length} entries) — refusing to clone over user content. Pass a non-empty \`dest\` to clone into a subfolder, or clear the workspace first.`,
            },
            409,
          );
        }
      } catch (err) {
        return c.json(
          {
            error: `failed to ensure workspace dir: ${err instanceof Error ? err.message : String(err)}`,
          },
          500,
        );
      }
    } else {
      try {
        await rm(destAbs, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      try {
        await mkdir(workspaceDir, { recursive: true });
      } catch (err) {
        return c.json(
          {
            error: `failed to ensure workspace dir: ${err instanceof Error ? err.message : String(err)}`,
          },
          500,
        );
      }
    }

    // Partial clone — pull commit graph + trees but no blobs until needed.
    // Modern git (2.19+) + GitHub support this. Fast for a diff use case.
    try {
      await runGit(['clone', '--filter=blob:none', body.url, destAbs], {
        timeoutMs: 5 * 60 * 1000,
      });
    } catch (err) {
      if (err instanceof GitError) {
        return c.json(
          { error: `git clone failed: ${err.stderr.slice(0, 500) || err.message}` },
          500,
        );
      }
      return c.json(
        { error: `git clone failed: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }

    // Ensure both refs are present in the local clone. If they're already
    // reachable (typical for branch/tag names) git fetch is a quick no-op.
    // If they're loose SHAs, this is what makes them fetchable. GitHub's
    // upload-pack allows fetching any SHA reachable from a published ref;
    // unreachable SHAs surface a clear error.
    try {
      await runGit(['fetch', '--no-tags', 'origin', body.baseRef, body.headRef], {
        cwd: destAbs,
        timeoutMs: 5 * 60 * 1000,
      });
    } catch (err) {
      const stderr =
        err instanceof GitError
          ? err.stderr.slice(0, 500)
          : err instanceof Error
            ? err.message
            : String(err);
      return c.json(
        {
          error: `git fetch failed for refs "${body.baseRef}" / "${body.headRef}": ${stderr}. If these are commit SHAs, verify they are reachable from a published ref on the remote (GitHub does not allow fetching unreachable SHAs).`,
        },
        400,
      );
    }

    // Resolve each ref to its commit SHA so the response carries the
    // pinned version regardless of what `body.baseRef` / `headRef` was
    // (a branch tip can move between fetch + checkout in a long run).
    let baseSha: string;
    let headSha: string;
    try {
      const baseOut = await runGit(['rev-parse', body.baseRef], {
        cwd: destAbs,
        timeoutMs: 15_000,
      });
      const headOut = await runGit(['rev-parse', body.headRef], {
        cwd: destAbs,
        timeoutMs: 15_000,
      });
      baseSha = baseOut.stdout.trim();
      headSha = headOut.stdout.trim();
    } catch (err) {
      return c.json(
        { error: `rev-parse failed: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }

    // Produce the unified diff. `--no-color` because we'll persist as a
    // patch file and `--no-textconv` for raw byte fidelity. The output
    // can get large for big PRs; we cap at 10 MB just in case.
    const DIFF_CAP_BYTES = 10 * 1024 * 1024;
    let diffText: string;
    try {
      const result = await runGit(['diff', '--no-color', `${baseSha}..${headSha}`], {
        cwd: destAbs,
        timeoutMs: 60_000,
      });
      diffText = result.stdout;
      if (diffText.length > DIFF_CAP_BYTES) {
        diffText = `${diffText.slice(0, DIFF_CAP_BYTES)}\n... (truncated at ${DIFF_CAP_BYTES} bytes — diff is ${result.stdout.length} bytes total)\n`;
      }
    } catch (err) {
      return c.json(
        { error: `git diff failed: ${err instanceof Error ? err.message : String(err)}` },
        500,
      );
    }

    // Count files changed (cheap structured signal alongside the patch).
    let filesChanged = 0;
    try {
      const result = await runGit(['diff', '--name-only', `${baseSha}..${headSha}`], {
        cwd: destAbs,
        timeoutMs: 30_000,
      });
      filesChanged = result.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean).length;
    } catch {
      // counting is best-effort; the patch is what matters
    }

    // Write the diff into the workspace. Use the same gezelId/sessionId
    // attribution path so audit/history shows the writer.
    try {
      await ctx.store.writeProjectWorkspaceFile(id, diffRel, diffText, {
        ...(body.gezelId ? { gezelId: body.gezelId } : {}),
        ...(body.sessionId ? { sessionId: body.sessionId } : {}),
      });
    } catch (err) {
      // Fallback to raw fs if Store rejects (e.g. binary detection
      // false-positive on a patch with control chars). The diff is just
      // bytes; we control the destination via safeJoin already.
      try {
        await mkdir(dirname(diffAbs), { recursive: true });
        await writeFileAtomic(diffAbs, diffText);
      } catch (err2) {
        return c.json(
          {
            error: `failed to write diff to ${diffRel}: ${err2 instanceof Error ? err2.message : String(err2)}`,
          },
          500,
        );
      }
    }

    // Check out headRef so the source tree under destRel is at the
    // post-change state. Fetches the head blobs on demand.
    try {
      await runGit(['checkout', '--quiet', headSha], { cwd: destAbs, timeoutMs: 5 * 60 * 1000 });
    } catch (err) {
      return c.json(
        {
          error: `git checkout ${headSha.slice(0, 8)} failed: ${err instanceof Error ? err.message : String(err)}`,
        },
        500,
      );
    }

    // Walk the checked-out tree to count files + bytes (same shape as
    // fetch-repo's reporting).
    let files = 0;
    let bytes = 0;
    const FILE_CAP = 5_000;
    const stack: string[] = [destAbs];
    const SKIP = new Set(['.git', 'node_modules', '.DS_Store']);
    while (stack.length > 0 && files < FILE_CAP) {
      const dir = stack.pop();
      if (!dir) break;
      let entries: { name: string; isDirectory(): boolean; isFile(): boolean }[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          stack.push(full);
        } else if (entry.isFile()) {
          try {
            const st = await stat(full);
            files += 1;
            bytes += st.size;
            if (files >= FILE_CAP) break;
          } catch {
            // file vanished between readdir + stat
          }
        }
      }
    }

    // Persist github metadata (parallel to fetch-repo). The MCP tool
    // creates the project WITHOUT github.url so the auto-clone doesn't
    // race the explicit clone above; we write the link here once the
    // clone has succeeded.
    if (cloneToWorkspaceRoot) {
      try {
        await ctx.store.updateProjectGitHub(id, {
          url: body.url,
          ...(body.headRef ? { branch: body.headRef } : {}),
          checkoutDir: workspaceDir,
        });
      } catch (err) {
        log.warn(
          `[fetch-diff] failed to persist github metadata for ${id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return c.json({
      ok: true,
      path: destRel,
      diffPath: diffRel,
      baseSha,
      headSha,
      files,
      bytes,
      diffBytes: diffText.length,
      filesChanged,
    });
  });

  app.put('/:id/workspace/file', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as {
      path?: string;
      content?: string;
      gezelId?: string;
      sessionId?: string;
    };
    if (!body.path || typeof body.path !== 'string') return c.json({ error: 'missing path' }, 400);
    if (typeof body.content !== 'string') return c.json({ error: 'missing content string' }, 400);
    try {
      await ctx.store.writeProjectWorkspaceFile(id, body.path, body.content, {
        ...(body.gezelId ? { gezelId: body.gezelId } : {}),
        ...(body.sessionId ? { sessionId: body.sessionId } : {}),
      });
      return c.json({ ok: true, path: body.path });
    } catch (err) {
      const mapped = mapWorkspaceError(err);
      return c.json(mapped.body, mapped.status as 400 | 403 | 500);
    }
  });

  // Byte-exact user editing path for outside-in rendered documents and their
  // companion media. It uses the same workspace authority gate as text writes.
  app.put('/:id/workspace/raw', async (c) => {
    const id = c.req.param('id');
    const filePath = c.req.query('path');
    if (!filePath) return c.json({ error: 'missing ?path=' }, 400);
    try {
      await ctx.store.writeProjectWorkspaceBinary(
        id,
        filePath,
        Buffer.from(await c.req.arrayBuffer()),
        undefined,
        { createOnly: c.req.query('create') === '1' },
      );
      return c.json({ ok: true, path: filePath });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        return c.json({ error: 'backup already exists' }, 409);
      }
      const mapped = mapWorkspaceError(err);
      return c.json(mapped.body, mapped.status as 400 | 403 | 500);
    }
  });

  // ── Surgical edit endpoints (Layer 4) ──
  //
  // Each returns a WorkspaceEditResponse envelope: { ok: true, path,
  // diff, addedLines, removedLines, diffTruncated? }. The diff is the
  // same string the chat-bubble renders inline; line counts are
  // pre-computed so the UI doesn't need to re-parse to show +N -M.

  app.post('/:id/workspace/replace', async (c) => {
    const id = c.req.param('id');
    const body = ReplaceInProjectWorkspaceFileRequestSchema.parse(await c.req.json());
    try {
      const result = await ctx.store.replaceInProjectWorkspaceFile(
        id,
        {
          path: body.path,
          find: body.find,
          replace: body.replace,
          ...(body.occurrence !== undefined ? { occurrence: body.occurrence } : {}),
        },
        {
          ...(body.gezelId ? { gezelId: body.gezelId } : {}),
          ...(body.sessionId ? { sessionId: body.sessionId } : {}),
        },
      );
      return c.json({ ok: true, ...result });
    } catch (err) {
      const mapped = mapWorkspaceError(err);
      return c.json(mapped.body, mapped.status as 400 | 403 | 500);
    }
  });

  app.post('/:id/workspace/replace-lines', async (c) => {
    const id = c.req.param('id');
    const body = ReplaceLinesInProjectWorkspaceFileRequestSchema.parse(await c.req.json());
    try {
      const result = await ctx.store.replaceLinesInProjectWorkspaceFile(
        id,
        {
          path: body.path,
          startLine: body.startLine,
          endLine: body.endLine,
          content: body.content,
        },
        {
          ...(body.gezelId ? { gezelId: body.gezelId } : {}),
          ...(body.sessionId ? { sessionId: body.sessionId } : {}),
        },
      );
      return c.json({ ok: true, ...result });
    } catch (err) {
      const mapped = mapWorkspaceError(err);
      return c.json(mapped.body, mapped.status as 400 | 403 | 500);
    }
  });

  app.post('/:id/workspace/patch', async (c) => {
    const id = c.req.param('id');
    const body = ApplyPatchToProjectWorkspaceFileRequestSchema.parse(await c.req.json());
    try {
      const result = await ctx.store.applyPatchToProjectWorkspaceFile(
        id,
        { path: body.path, diff: body.diff },
        {
          ...(body.gezelId ? { gezelId: body.gezelId } : {}),
          ...(body.sessionId ? { sessionId: body.sessionId } : {}),
        },
      );
      return c.json({ ok: true, ...result });
    } catch (err) {
      const mapped = mapWorkspaceError(err);
      return c.json(mapped.body, mapped.status as 400 | 403 | 500);
    }
  });

  app.post('/:id/workspace/insert-at-marker', async (c) => {
    const id = c.req.param('id');
    const body = InsertAtMarkerInProjectWorkspaceFileRequestSchema.parse(await c.req.json());
    try {
      const result = await ctx.store.insertAtMarkerInProjectWorkspaceFile(
        id,
        {
          path: body.path,
          marker: body.marker,
          content: body.content,
          ...(body.where ? { where: body.where } : {}),
        },
        {
          ...(body.gezelId ? { gezelId: body.gezelId } : {}),
          ...(body.sessionId ? { sessionId: body.sessionId } : {}),
        },
      );
      return c.json({ ok: true, ...result });
    } catch (err) {
      const mapped = mapWorkspaceError(err);
      return c.json(mapped.body, mapped.status as 400 | 403 | 500);
    }
  });

  app.delete('/:id/workspace/path', async (c) => {
    const id = c.req.param('id');
    const filePath = c.req.query('path');
    const recursive = c.req.query('recursive') === '1';
    const gezelId = c.req.query('gezelId') || undefined;
    const sessionId = c.req.query('sessionId') || undefined;
    if (!filePath) return c.json({ error: 'missing ?path=' }, 400);
    try {
      await ctx.store.rmProjectWorkspacePath(
        id,
        filePath,
        { recursive },
        {
          ...(gezelId ? { gezelId } : {}),
          ...(sessionId ? { sessionId } : {}),
        },
      );
      return c.json({ ok: true });
    } catch (err) {
      const mapped = mapWorkspaceError(err);
      return c.json(mapped.body, mapped.status as 400 | 403 | 500);
    }
  });

  app.post('/:id/workspace/mkdir', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as {
      path?: string;
      gezelId?: string;
      sessionId?: string;
    };
    if (!body.path) return c.json({ error: 'missing path' }, 400);
    try {
      await ctx.store.mkdirProjectWorkspace(id, body.path, {
        ...(body.gezelId ? { gezelId: body.gezelId } : {}),
        ...(body.sessionId ? { sessionId: body.sessionId } : {}),
      });
      return c.json({ ok: true, path: body.path });
    } catch (err) {
      const mapped = mapWorkspaceError(err);
      return c.json(mapped.body, mapped.status as 400 | 403 | 500);
    }
  });

  app.post('/:id/workspace/rename', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as {
      fromPath?: string;
      toPath?: string;
      gezelId?: string;
      sessionId?: string;
    };
    if (!body.fromPath || !body.toPath) return c.json({ error: 'missing fromPath / toPath' }, 400);
    try {
      await ctx.store.renameProjectWorkspacePath(id, body.fromPath, body.toPath, {
        ...(body.gezelId ? { gezelId: body.gezelId } : {}),
        ...(body.sessionId ? { sessionId: body.sessionId } : {}),
      });
      return c.json({ ok: true, fromPath: body.fromPath, toPath: body.toPath });
    } catch (err) {
      const mapped = mapWorkspaceError(err);
      return c.json(mapped.body, mapped.status as 400 | 403 | 500);
    }
  });

  app.get('/:id/workspace/writes', async (c) => {
    const id = c.req.param('id');
    const limit = Math.min(
      Math.max(Number.parseInt(c.req.query('limit') ?? '50', 10) || 50, 1),
      500,
    );
    const entries = await readJournalTail(ctx.home, id, limit);
    return c.json({ entries });
  });

  app.post('/:id/npm-install', async (c) => {
    const id = c.req.param('id');
    const body = NpmInstallRequestSchema.parse(await c.req.json());
    const packages: NpmInstallPackageRequest[] = body.packages ?? [
      {
        package: body.package!,
        ...(body.version !== undefined ? { version: body.version } : {}),
      },
    ];
    try {
      const outcome = await requestNpmInstalls({
        store: ctx.store,
        home: ctx.home,
        projectId: id,
        packages,
        chatEvents: ctx.chatEvents,
        ...(body.gezelId ? { gezelId: body.gezelId } : {}),
        ...(body.sessionId ? { sessionId: body.sessionId } : {}),
      });
      return c.json(outcome);
    } catch (err) {
      const mapped = mapWorkspaceError(err);
      return c.json(mapped.body, mapped.status as 400 | 403 | 500);
    }
  });

  app.post('/:id/run-nodejs-script', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as {
      path?: string;
      args?: string[];
      timeoutMs?: number;
    };
    if (!body.path) return c.json({ error: 'missing path' }, 400);
    try {
      const project = await ctx.store.getProject(id);
      const effectiveTimeout = body.timeoutMs ?? project?.workspaceScriptTimeoutMs;
      const result = await runWorkspaceScript(ctx.store, {
        projectId: id,
        scriptPath: body.path,
        ...(body.args ? { args: body.args } : {}),
        ...(effectiveTimeout ? { timeoutMs: effectiveTimeout } : {}),
      });
      return c.json(result);
    } catch (err) {
      const mapped = mapWorkspaceError(err);
      return c.json(mapped.body, mapped.status as 400 | 403 | 500);
    }
  });

  app.post('/:id/derive-file', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as {
      script?: string;
      outputPath?: string;
      timeoutMs?: number;
    };
    if (!body.script) return c.json({ error: 'missing script' }, 400);
    if (!body.outputPath) return c.json({ error: 'missing outputPath' }, 400);
    try {
      const project = await ctx.store.getProject(id);
      const effectiveTimeout = body.timeoutMs ?? project?.workspaceScriptTimeoutMs;
      const result = await deriveWorkspaceFile(ctx.store, {
        projectId: id,
        script: body.script,
        outputPath: body.outputPath,
        ...(effectiveTimeout ? { timeoutMs: effectiveTimeout } : {}),
      });
      return c.json(result);
    } catch (err) {
      const mapped = mapWorkspaceError(err);
      return c.json(mapped.body, mapped.status as 400 | 403 | 500);
    }
  });

  app.get('/:id/package-scripts', async (c) => {
    const id = c.req.param('id');
    const result = await ctx.store.readPackageJsonScripts(id);
    return c.json(result);
  });

  app.post('/:id/run-package-script', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as {
      script?: string;
      args?: string[];
      timeoutMs?: number;
      gezelId?: string;
      sessionId?: string;
    };
    if (!body.script) return c.json({ error: 'missing script' }, 400);
    try {
      const project = await ctx.store.getProject(id);
      const effectiveTimeout = body.timeoutMs ?? project?.workspaceScriptTimeoutMs;
      const result = await runPackageScript({
        store: ctx.store,
        home: ctx.home,
        projectId: id,
        history: ctx.history,
        script: body.script,
        ...(body.args ? { args: body.args } : {}),
        ...(effectiveTimeout ? { timeoutMs: effectiveTimeout } : {}),
        ...(body.gezelId ? { gezelId: body.gezelId } : {}),
        ...(body.sessionId ? { sessionId: body.sessionId } : {}),
      });
      return c.json(result);
    } catch (err) {
      const mapped = mapWorkspaceError(err);
      return c.json(mapped.body, mapped.status as 400 | 403 | 500);
    }
  });

  app.post('/:id/run-npx', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json()) as {
      bin?: string;
      args?: string[];
      timeoutMs?: number;
      gezelId?: string;
      sessionId?: string;
    };
    if (!body.bin) return c.json({ error: 'missing bin' }, 400);
    try {
      const project = await ctx.store.getProject(id);
      const effectiveTimeout = body.timeoutMs ?? project?.workspaceScriptTimeoutMs;
      const result = await runNpx({
        store: ctx.store,
        home: ctx.home,
        projectId: id,
        history: ctx.history,
        bin: body.bin,
        ...(body.args ? { args: body.args } : {}),
        ...(effectiveTimeout ? { timeoutMs: effectiveTimeout } : {}),
        ...(body.gezelId ? { gezelId: body.gezelId } : {}),
        ...(body.sessionId ? { sessionId: body.sessionId } : {}),
      });
      return c.json(result);
    } catch (err) {
      const mapped = mapWorkspaceError(err);
      return c.json(mapped.body, mapped.status as 400 | 403 | 500);
    }
  });

  return app;
}

/**
 * Build a plain-language error string for `run_playwright_script`
 * when the `@playwright/mcp` toolset isn't ready. Includes the live
 * bootstrap phase + progress so the calling model sees concrete
 * state — it can decide whether to wait (and retry later) or pick
 * a different approach (e.g. fetch a JSON weather API instead of
 * scraping a web page). The previous message told the model to
 * "wait for the Home screen" which is incoherent advice for the
 * caller — models don't have screens, don't wait, and can't check
 * anything between one tool call and the next.
 */
function formatPlaywrightNotReadyError(
  status: import('../../system-toolsets/status-bus.js').SystemBootstrapStatus,
): string {
  const base = '@playwright/mcp is not installed yet, so browser automation is unavailable.';
  const guidance =
    'Consider a different approach for this turn — e.g. fetch a JSON API instead of scraping HTML, or acknowledge the limitation and offer alternatives.';
  switch (status.phase) {
    case 'idle':
      return `${base} The installer hasn't started yet. ${guidance}`;
    case 'installing-toolsets': {
      const what = status.currentToolset ? ` (installing ${status.currentToolset})` : '';
      return `${base} Still installing${what}. This usually finishes within a minute or two. ${guidance}`;
    }
    case 'downloading-browser': {
      const p = status.browserProgress;
      const pct =
        p?.bytesTotal && p.bytesTotal > 0
          ? ` (${Math.round((100 * p.bytesDownloaded) / p.bytesTotal)}%)`
          : '';
      return `${base} Chromium is still downloading${pct} — first-run setup takes 2–5 minutes on a typical connection. ${guidance}`;
    }
    case 'setup-incomplete':
      return `${base} Initial setup didn't complete. ${guidance}`;
    case 'error':
      return `${base} The installer reported an error${
        status.error ? `: ${status.error}` : ''
      }. ${guidance}`;
    case 'ready':
      // Shouldn't reach here — status says ready but the Store
      // says not installed. Tell the caller something informative
      // anyway.
      return `${base} State mismatch between the Store and bootstrap — restart the app to re-sync. ${guidance}`;
    default:
      return `${base} ${guidance}`;
  }
}

/** A one-file Playwright config for a spec stored outside the toolset cwd. */
function playwrightTestConfigSource(scriptAbs: string): string {
  // Playwright retries RegExp matchers with slash-normalized paths on
  // Windows. Normalize our exact path up front so the same expression works
  // on both passes/platforms without turning a basename into a broad glob.
  const normalizedPath = scriptAbs.replaceAll('\\', '/');
  const exactPath = `^${normalizedPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
  return [
    'export default {',
    `  testDir: ${JSON.stringify(dirname(scriptAbs))},`,
    `  testMatch: new RegExp(${JSON.stringify(exactPath)}),`,
    '};',
    '',
  ].join('\n');
}

/**
 * Artifact references routinely arrive with the drawer prefix already on
 * them (`artifacts/data/…`) — craftbook corpus scopes are authored that way
 * and the model writes the path straight back. Store reads strip it; these
 * reference routes join the path themselves, so without this a file plainly
 * on disk resolves to `artifacts/artifacts/…` and 404s. Workspace and
 * document paths are left alone: a workspace may own an `artifacts/` folder.
 */
function referenceRelativePath(request: { kind: string; path: string }): string {
  return request.kind === 'artifact' ? normalizeArtifactPath(request.path) : request.path;
}

async function serveRawFile(c: import('hono').Context, base: string, filePath: string) {
  const { readFile } = await import('node:fs/promises');
  const { mimeTypeForPath } = await import('../mime.js');
  const full = safeJoin(base, filePath);
  if (!full || !(await realpathContained(base, full))) {
    return c.json({ error: 'path traversal' }, 400);
  }
  try {
    const buf = await readFile(full);
    return c.body(new Uint8Array(buf), 200, { 'content-type': mimeTypeForPath(filePath) });
  } catch {
    return c.json({ error: 'not found' }, 404);
  }
}
