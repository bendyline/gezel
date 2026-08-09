/**
 * Connector write actions — the generalized outbox. A connector-type declares
 * `actions:[{name, consentScope}]`; drafting is the model-facing surface (the
 * draft file is the human review surface) and only declared actions may be
 * drafted. Committing — which calls `adapter.runAction` (the live write) —
 * must clear the action's consent scope through the daemon-enforced registry
 * (`connectors/consent.ts`); no scope, no registered enforcer, or a failing
 * enforcer all deny. During night shift, commit defers: the action stages to
 * `_outbox/` for daytime approval (the morning-briefing model).
 *
 *   <workspace>/<binding corpusDir>/_actions/
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
import { enforceConsent } from './consent.js';
import { ProjectLocks } from './lock.js';
import { corpusDirFor, createConnectorAdapter } from './manager.js';
import { newDraftId } from './outbox.js';

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
  /** Shared with ConnectorManager so commits can't race syncs. */
  locks?: ProjectLocks;
}

export class ConnectorActionManager {
  private readonly locks: ProjectLocks;

  constructor(private readonly opts: ConnectorActionManagerOptions) {
    this.locks = opts.locks ?? new ProjectLocks();
  }

  /** Draft an action (agent-facing). No network; never commits. Only actions
   *  the connector type declares may be drafted. */
  async draft(
    project: ProjectDetail,
    input: DraftActionInput,
  ): Promise<{ draftId: string; relPath: string }> {
    const binding = (project.connectors ?? []).find((b) => b.id === input.bindingId);
    if (!binding) throw new Error(`no connector binding ${input.bindingId}`);
    const type = await this.loadType(binding.type, binding.version);
    const declared = type.actions.find((a) => a.name === input.action);
    if (!declared) {
      const names = type.actions.map((a) => a.name);
      throw new Error(
        `connector '${binding.type}' declares no action '${input.action}'${names.length ? ` (available: ${names.join(', ')})` : ' (it declares no actions)'}`,
      );
    }
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
        const dir = `${corpusDirFor(project.connectors ?? [], binding)}/_actions/${sub}`;
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

  /** Stage a draft to `_outbox/` (no network; consent still gates the commit). */
  async queue(project: ProjectDetail, draftId: string): Promise<{ relPath: string }> {
    return this.locks.run(project.id, async () => {
      const found = await this.find(project, draftId);
      if (!found) throw new ActionDraftNotFoundError(draftId);
      const { abs, rel } = await this.paths(
        project,
        found.bindingId,
        '_outbox',
        `${found.safeId}.md`,
      );
      await mkdir(dirname(abs), { recursive: true });
      await writeFileAtomic(abs, withFrontmatter({ ...found.data, status: 'queued' }, found.body));
      if (found.abs !== abs) await rm(found.abs, { force: true });
      return { relPath: rel };
    });
  }

  /**
   * Commit an action — the live write. Deny-by-default twice over: the
   * action's consent scope must clear its registered enforcer (unknown scope
   * = deny), and during night shift the commit defers to `_outbox/` for
   * daytime approval instead of transmitting.
   */
  async commit(project: ProjectDetail, draftId: string): Promise<CommitResult> {
    return this.locks.run(project.id, async () => {
      const found = await this.find(project, draftId);
      if (!found) throw new ActionDraftNotFoundError(draftId);

      const binding = (project.connectors ?? []).find((b) => b.id === found.bindingId);
      if (!binding) throw new Error(`no connector binding ${found.bindingId}`);
      const type = await this.loadType(binding.type, binding.version);
      const action = found.data.action ?? '';
      const input = safeParse(found.body);
      const declared = type.actions.find((a) => a.name === action);
      if (!declared) {
        throw new Error(`connector '${binding.type}' declares no action '${action}'`);
      }
      const verdict = await enforceConsent(declared.consentScope, {
        project,
        binding,
        action,
        data: found.data,
        input,
      });
      if (!verdict.ok) throw new Error(`commit denied: ${verdict.reason}`);

      if (this.opts.isNightShiftActive?.()) {
        const { abs, rel } = await this.paths(
          project,
          found.bindingId,
          '_outbox',
          `${found.safeId}.md`,
        );
        await mkdir(dirname(abs), { recursive: true });
        await writeFileAtomic(
          abs,
          withFrontmatter({ ...found.data, status: 'queued' }, found.body),
        );
        if (found.abs !== abs) await rm(found.abs, { force: true });
        return { status: 'queued-night-shift', relPath: rel };
      }

      const adapter = await createConnectorAdapter(type, binding, {
        secrets: this.opts.secrets,
        store: this.opts.store,
        ...(this.opts.scriptRunner ? { scriptRunner: this.opts.scriptRunner } : {}),
        projectId: project.id,
      });
      try {
        await adapter.ensureAuth();
        if (!adapter.runAction) throw new Error(`connector '${binding.type}' has no write actions`);
        const result = await adapter.runAction(action, input);
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
    });
  }

  async discard(project: ProjectDetail, draftId: string): Promise<void> {
    return this.locks.run(project.id, async () => {
      const found = await this.find(project, draftId);
      if (found) await rm(found.abs, { force: true });
    });
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
    const bindings = project.connectors ?? [];
    const binding = bindings.find((b) => b.id === bindingId);
    if (!binding) throw new Error(`no connector binding ${bindingId}`);
    const workspaceDir = await this.opts.store.projectWorkspaceDir(project.id);
    const rel = `${corpusDirFor(bindings, binding)}/_actions/${sub}/${name}`;
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
