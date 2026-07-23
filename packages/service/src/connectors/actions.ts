/**
 * Connector write actions — the generalized outbox. A connector-type declares
 * `actions:[{name, consentScope}]`; a gezel can only **draft** an action (the
 * draft file is the human review surface). Committing — which calls
 * `adapter.runAction` (the live write) — is a USER action, never on the model's
 * tool surface (ingest-bound). During night shift, commit defers: the action
 * stages to `_outbox/` for daytime approval (the morning-briefing model).
 *
 *   <workspace>/connectors/<binding-slug>/_actions/
 *     _drafts/<id>.md   (drafted by the agent — the review surface)
 *     _outbox/<id>.md   (staged: queued for daytime approval)
 *     _sent/<id>.md     (committed: receipt)
 */

import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ProjectDetail } from '@bendyline/gezel';
import { createLogger } from '@bendyline/gezel';
import type { ConnectorTypeManifest } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { writeFileAtomic } from '../fs/atomic.js';
import { resolveInside } from '../fs/safe-paths.js';
import type { Store } from '../fs/store.js';
import type { ContentIndex } from '../index-store/content-index.js';
import { parseFrontmatter, withFrontmatter } from '../index-store/frontmatter.js';
import type { SecretStore } from '../secrets/types.js';
import { createConnectorAdapter } from './manager.js';
import { newDraftId } from './outbox.js';
import { slug } from './writer.js';

const log = createLogger('connectors');

export class ActionDraftNotFoundError extends Error {
  constructor(draftId: string) {
    super(`no connector action draft with id ${draftId}`);
    this.name = 'ActionDraftNotFoundError';
  }
}

export interface DraftActionInput {
  bindingId: string;
  action: string;
  input?: unknown;
}

export interface PendingAction {
  draftId: string;
  bindingId: string;
  connectorType: string;
  action: string;
  status: 'draft' | 'queued';
  input: unknown;
}

export interface CommitResult {
  status: 'committed' | 'queued-night-shift';
  result?: unknown;
  relPath: string;
}

export interface ConnectorActionManagerOptions {
  store: Store;
  secrets: SecretStore;
  catalog: CatalogService;
  contentIndex?: ContentIndex;
  scriptRunner?: import('../scripts/runner.js').ScriptRunner;
  isNightShiftActive?: () => boolean;
}

export class ConnectorActionManager {
  constructor(private readonly opts: ConnectorActionManagerOptions) {}

  /** Draft an action (agent-facing). No network; always allowed; never commits. */
  async draft(
    project: ProjectDetail,
    input: DraftActionInput,
  ): Promise<{ draftId: string; relPath: string }> {
    const binding = (project.connectors ?? []).find((b) => b.id === input.bindingId);
    if (!binding) throw new Error(`no connector binding ${input.bindingId}`);
    const draftId = newDraftId();
    const { abs, rel } = await this.paths(project, binding.id, '_drafts', `${draftId}.md`);
    await mkdir(dirname(abs), { recursive: true });
    const frontmatter: Record<string, string> = {
      binding: binding.id,
      connector_type: binding.type,
      action: input.action,
      direction: 'outbound',
      status: 'draft',
      draft_id: draftId,
    };
    await writeFileAtomic(
      abs,
      withFrontmatter(frontmatter, JSON.stringify(input.input ?? {}, null, 2)),
    );
    return { draftId, relPath: rel };
  }

  /** List pending actions (drafted + queued) across the project's connectors. */
  async list(project: ProjectDetail): Promise<{ pending: PendingAction[] }> {
    const pending: PendingAction[] = [];
    const workspaceDir = await this.opts.store.projectWorkspaceDir(project.id);
    for (const binding of project.connectors ?? []) {
      for (const [sub, status] of [
        ['_outbox', 'queued'],
        ['_drafts', 'draft'],
      ] as const) {
        const dir = `connectors/${slug(binding.id)}/_actions/${sub}`;
        const abs = await resolveInside(workspaceDir, dir).catch(() => null);
        if (!abs) continue;
        for (const name of await readdir(abs).catch(() => [])) {
          if (!name.endsWith('.md')) continue;
          const content = await readFile(await resolveInside(abs, name), 'utf8').catch(() => null);
          if (content == null) continue;
          const { data, body } = parseFrontmatter(content);
          pending.push({
            draftId: data.draft_id ?? name.replace(/\.md$/, ''),
            bindingId: binding.id,
            connectorType: binding.type,
            action: data.action ?? '',
            status,
            input: safeParse(body),
          });
        }
      }
    }
    return { pending };
  }

  /**
   * Commit an action (USER-facing). Deny-by-default: only a user reaches this —
   * the model never can. During night shift, defer: stage to `_outbox/`. Else
   * run `adapter.runAction` and record a receipt.
   */
  async commit(project: ProjectDetail, draftId: string): Promise<CommitResult> {
    const found = await this.find(project, draftId);
    if (!found) throw new ActionDraftNotFoundError(draftId);

    if (this.opts.isNightShiftActive?.()) {
      const { abs, rel } = await this.paths(
        project,
        found.bindingId,
        '_outbox',
        `${found.safeId}.md`,
      );
      await mkdir(dirname(abs), { recursive: true });
      await writeFileAtomic(abs, withFrontmatter({ ...found.data, status: 'queued' }, found.body));
      if (found.abs !== abs) await rm(found.abs, { force: true });
      return { status: 'queued-night-shift', relPath: rel };
    }

    const binding = (project.connectors ?? []).find((b) => b.id === found.bindingId);
    if (!binding) throw new Error(`no connector binding ${found.bindingId}`);
    const type = await this.loadType(binding.type, binding.version);
    const adapter = await createConnectorAdapter(type, binding, {
      secrets: this.opts.secrets,
      store: this.opts.store,
      ...(this.opts.scriptRunner ? { scriptRunner: this.opts.scriptRunner } : {}),
      projectId: project.id,
    });
    try {
      await adapter.ensureAuth();
      if (!adapter.runAction) throw new Error(`connector '${binding.type}' has no write actions`);
      const result = await adapter.runAction(found.data.action ?? '', safeParse(found.body));
      const { abs, rel } = await this.paths(
        project,
        found.bindingId,
        '_sent',
        `${found.safeId}.md`,
      );
      await mkdir(dirname(abs), { recursive: true });
      await writeFileAtomic(
        abs,
        withFrontmatter(
          { ...found.data, status: 'sent', committed_at: new Date().toISOString() },
          found.body,
        ),
      );
      if (found.abs !== abs) await rm(found.abs, { force: true });
      log.info(`[connectors] committed action ${found.data.action} on ${binding.id}`);
      return { status: 'committed', result, relPath: rel };
    } finally {
      await adapter.close().catch(() => {});
    }
  }

  async discard(project: ProjectDetail, draftId: string): Promise<void> {
    const found = await this.find(project, draftId);
    if (found) await rm(found.abs, { force: true });
  }

  private async loadType(typeId: string, version?: string): Promise<ConnectorTypeManifest> {
    const detail = await this.opts.catalog.get('connector-type', typeId, undefined, version);
    if (!detail || detail.manifest.kind !== 'connector-type') {
      throw new Error(`connector type not found: ${typeId}`);
    }
    return detail.manifest;
  }

  private safeDraftId(draftId: string): string {
    const safe = draftId.replace(/[^a-zA-Z0-9-]/g, '');
    if (!safe) throw new ActionDraftNotFoundError(draftId);
    return safe;
  }

  private async paths(
    project: ProjectDetail,
    bindingId: string,
    sub: '_drafts' | '_outbox' | '_sent',
    name: string,
  ): Promise<{ abs: string; rel: string }> {
    const workspaceDir = await this.opts.store.projectWorkspaceDir(project.id);
    const rel = `connectors/${slug(bindingId)}/_actions/${sub}/${name}`;
    return { abs: await resolveInside(workspaceDir, rel), rel };
  }

  /** Find a draft by id across all bindings, `_outbox` (preferred) then `_drafts`. */
  private async find(
    project: ProjectDetail,
    draftId: string,
  ): Promise<{
    abs: string;
    data: Record<string, string>;
    body: string;
    bindingId: string;
    safeId: string;
  } | null> {
    const safe = this.safeDraftId(draftId);
    for (const binding of project.connectors ?? []) {
      for (const sub of ['_outbox', '_drafts'] as const) {
        const { abs } = await this.paths(project, binding.id, sub, `${safe}.md`);
        const content = await readFile(abs, 'utf8').catch(() => null);
        if (content != null) {
          const { data, body } = parseFrontmatter(content);
          return { abs, data, body, bindingId: binding.id, safeId: safe };
        }
      }
    }
    return null;
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
