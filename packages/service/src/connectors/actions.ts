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
 *   <artifacts>/<binding corpusDir>/_actions/
 *     _drafts/<id>.md   (drafted by the agent — the review surface)
 *     _outbox/<id>.md   (staged: queued for daytime approval)
 *     _sent/<id>.md     (committed: receipt)
 */

import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ProjectDetail } from '@bendyline/gezel';
import { KeyedLock, createLogger, resolveSecurityPolicy } from '@bendyline/gezel';
import type { ConnectorTypeManifest } from '@bendyline/gezel';
import type { CatalogService } from '@bendyline/gezel-catalog';
import { writeFileAtomic } from '@bendyline/gezel-inference/internal/fs/atomic';
import { resolveInside } from '@bendyline/gezel-inference/internal/fs/safe-paths';
import type { SecretStore } from '@bendyline/gezel-inference/internal/secrets/types';
import type { Store } from '../fs/store.js';
import type { ContentIndex } from '../index-store/content-index.js';
import { parseFrontmatter, withFrontmatter } from '../index-store/frontmatter.js';
import { parseRecipient } from '../mail/recipient.js';
import { validateConnectorConfig } from './config-validate.js';
import { draftRecipients, enforceConsent } from './consent.js';
import { corpusDirFor, createConnectorAdapter } from './manager.js';
import { newDraftId } from './outbox.js';
import { connectorCorpusStorage } from './storage.js';

const log = createLogger('connectors');

/**
 * Consent scopes whose commit reaches nobody but the account owner — a draft
 * saved into their own mailbox. Night-shift deferral exists so nothing is sent
 * to other people unattended; holding these until morning would only mean an
 * overnight "draft my replies" run leaves the Drafts folder empty when the
 * person sits down to review it.
 */
const NON_TRANSMITTING_SCOPES: ReadonlySet<string> = new Set(['mailbox-draft']);

/** Every recipient the draft names is one of `standing` (case-insensitive). */
function coveredByStandingRecipients(
  data: Record<string, string>,
  input: unknown,
  standing: readonly string[] | undefined,
): boolean {
  if (!standing?.length) return false;
  const allowed = new Set(standing.map((a) => a.trim().toLowerCase()));
  const entries = draftRecipients(data, input);
  if (entries.length === 0) return false;
  return entries.every((entry) => {
    const parsed = parseRecipient(entry);
    return parsed.ok && allowed.has(parsed.address.toLowerCase());
  });
}

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
  /**
   * `uncertain`: a commit started transmitting and did not finish cleanly,
   * so the action may or may not have reached the service. It is never
   * retried on its own; a person checks the account first.
   */
  status: 'draft' | 'queued' | 'uncertain';
  input: unknown;
  /** Why a commit is uncertain, when it is. */
  error?: string;
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
  locks?: KeyedLock;
  /** HTTP transport for the committing adapter; tests inject the simulator. */
  fetch?: typeof fetch;
}

/** Refuse an input the action's `inputSchema` does not admit, naming every problem. */
function assertActionInput(
  typeId: string,
  action: { name: string; inputSchema?: Record<string, unknown> },
  input: unknown,
): void {
  if (!action.inputSchema) return;
  const errors =
    input !== null && typeof input === 'object' && !Array.isArray(input)
      ? validateConnectorConfig(action.inputSchema, input as Record<string, unknown>)
      : ['the input must be an object'];
  if (errors.length) {
    throw new Error(`invalid input for ${typeId} action '${action.name}': ${errors.join('; ')}`);
  }
}

export class ConnectorActionManager {
  private readonly locks: KeyedLock;

  constructor(private readonly opts: ConnectorActionManagerOptions) {
    this.locks = opts.locks ?? new KeyedLock();
  }

  /** Draft an action (agent-facing). No network; never commits. Only actions
   *  the connector type declares may be drafted. */
  async draft(
    project: ProjectDetail,
    input: DraftActionInput,
  ): Promise<{ draftId: string; relPath: string }> {
    const binding = (project.connectors ?? []).find((b) => b.id === input.bindingId);
    if (!binding) throw new Error(`no connector binding ${input.bindingId}`);
    const type = await this.loadType(binding.type, binding.version, binding.sourceId ?? 'bundled');
    const declared = type.actions.find((a) => a.name === input.action);
    if (!declared) {
      const names = type.actions.map((a) => a.name);
      throw new Error(
        `connector '${binding.type}' declares no action '${input.action}'${names.length ? ` (available: ${names.join(', ')})` : ' (it declares no actions)'}`,
      );
    }
    assertActionInput(binding.type, declared, input.input ?? {});
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
    for (const binding of project.connectors ?? []) {
      const corpusDir = corpusDirFor(project.connectors ?? [], binding);
      const { storageDir } = await connectorCorpusStorage(this.opts.store, project.id, corpusDir);
      for (const [sub, status] of [
        ['_sending', 'uncertain'],
        ['_outbox', 'queued'],
        ['_drafts', 'draft'],
      ] as const) {
        const dir = `${corpusDir}/_actions/${sub}`;
        const abs = await resolveInside(storageDir, dir).catch(() => null);
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
            ...(data.error ? { error: data.error } : {}),
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
  /**
   * `standingRecipients` is a lookout's own recipient list: a send whose every
   * recipient the person typed on that lookout transmits even during the
   * night shift (a 3 a.m. alert is no use at breakfast). The consent scope
   * still runs; this only waives the deferral, and only for those addresses.
   */
  async commit(
    requested: ProjectDetail,
    draftId: string,
    opts: {
      standingRecipients?: readonly string[];
      /**
       * A gezel's session asked for this commit (`send_email`), not the
       * person. Anything that transmits then needs the posture that lets
       * gezels reach external services, checked here and not only where the
       * tool is offered.
       */
      agentInitiated?: boolean;
    } = {},
  ): Promise<CommitResult> {
    return this.locks.run(requested.id, async () => {
      // The project as it is now, not as the caller last saw it: a binding
      // or its allowlist may have changed since.
      let project = requested;
      const getProject = (this.opts.store as Partial<Store>).getProject;
      if (typeof getProject === 'function') {
        const fresh = await getProject.call(this.opts.store, project.id).catch(() => null);
        if (fresh?.connectors?.length) project = fresh;
      }
      const found = await this.find(project, draftId);
      if (!found) throw new ActionDraftNotFoundError(draftId);
      if (found.sub === '_sending') {
        throw new Error(
          'this action may already have been sent: an earlier commit started and did not finish. Check the account, then discard it or draft it again.',
        );
      }

      const binding = (project.connectors ?? []).find((b) => b.id === found.bindingId);
      if (!binding) throw new Error(`no connector binding ${found.bindingId}`);
      const type = await this.loadType(
        binding.type,
        binding.version,
        binding.sourceId ?? 'bundled',
      );
      const action = found.data.action ?? '';
      const input = safeParse(found.body);
      const declared = type.actions.find((a) => a.name === action);
      if (!declared) {
        throw new Error(`connector '${binding.type}' declares no action '${action}'`);
      }
      // The outbox copy may have been edited since it was drafted.
      assertActionInput(binding.type, declared, input);
      if (opts.agentInitiated && !NON_TRANSMITTING_SCOPES.has(declared.consentScope ?? '')) {
        const readConfig = (this.opts.store as Partial<Store>).readConfig;
        const config =
          typeof readConfig === 'function'
            ? await readConfig.call(this.opts.store).catch(() => null)
            : null;
        if (config && !resolveSecurityPolicy(config).allowExternalServices) {
          throw new Error(
            'commit denied: at this security level a gezel cannot send or post. Approve it yourself in the Connections tab.',
          );
        }
      }
      const verdict = await enforceConsent(declared.consentScope, {
        project,
        binding,
        action,
        data: found.data,
        input,
      });
      if (!verdict.ok) throw new Error(`commit denied: ${verdict.reason}`);
      const committedInput = verdict.input !== undefined ? verdict.input : input;

      if (
        this.opts.isNightShiftActive?.() &&
        !NON_TRANSMITTING_SCOPES.has(declared.consentScope ?? '') &&
        !coveredByStandingRecipients(found.data, committedInput, opts.standingRecipients)
      ) {
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
        ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
      });
      try {
        await adapter.ensureAuth();
        if (!adapter.runAction) throw new Error(`connector '${binding.type}' has no write actions`);
        // Journal before transmitting: if the call fails, times out, or the
        // daemon dies before the receipt is written, the action stays in
        // `_sending/` and is never transmitted again without a person.
        const sending = await this.paths(
          project,
          found.bindingId,
          '_sending',
          `${found.safeId}.md`,
        );
        await mkdir(dirname(sending.abs), { recursive: true });
        await writeFileAtomic(
          sending.abs,
          withFrontmatter(
            { ...found.data, status: 'sending', started_at: new Date().toISOString() },
            found.body,
          ),
        );
        if (found.abs !== sending.abs) await rm(found.abs, { force: true });
        let result: unknown;
        try {
          result = await adapter.runAction(action, committedInput);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await writeFileAtomic(
            sending.abs,
            withFrontmatter(
              { ...found.data, status: 'uncertain', error: message.slice(0, 300) },
              found.body,
            ),
          ).catch(() => {});
          throw err;
        }
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
            verdict.input !== undefined ? JSON.stringify(committedInput, null, 2) : found.body,
          ),
        );
        await rm(sending.abs, { force: true });
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

  /**
   * The manifest the binding was bound against: its own catalog source and
   * version, so a local manifest with the same id cannot change what an
   * action does or which consent scope gates it.
   */
  private async loadType(
    typeId: string,
    version?: string,
    sourceId?: string,
  ): Promise<ConnectorTypeManifest> {
    const detail = await this.opts.catalog.get('connector-type', typeId, sourceId, version);
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
    sub: '_drafts' | '_outbox' | '_sending' | '_sent',
    name: string,
  ): Promise<{ abs: string; rel: string }> {
    const bindings = project.connectors ?? [];
    const binding = bindings.find((b) => b.id === bindingId);
    if (!binding) throw new Error(`no connector binding ${bindingId}`);
    const corpusDir = corpusDirFor(bindings, binding);
    const { storageDir } = await connectorCorpusStorage(this.opts.store, project.id, corpusDir);
    const rel = `${corpusDir}/_actions/${sub}/${name}`;
    return { abs: await resolveInside(storageDir, rel), rel };
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
    sub: '_sending' | '_outbox' | '_drafts';
  } | null> {
    const safe = this.safeDraftId(draftId);
    for (const binding of project.connectors ?? []) {
      for (const sub of ['_sending', '_outbox', '_drafts'] as const) {
        const { abs } = await this.paths(project, binding.id, sub, `${safe}.md`);
        const content = await readFile(abs, 'utf8').catch(() => null);
        if (content != null) {
          const { data, body } = parseFrontmatter(content);
          return { abs, data, body, bindingId: binding.id, safeId: safe, sub };
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
