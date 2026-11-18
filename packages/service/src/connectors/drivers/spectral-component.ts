/**
 * `spectral` driver, for types built on a published Prismatic component
 * (`source.package`). The component runs in runner v2, in the sandbox; this
 * trusted side builds the connection from the binding's credential, keeps the
 * component's position as the cursor, and hands the engine records.
 *
 * - `trigger` mode drains a polling trigger. The trigger's polling state is
 *   the cursor; a drain larger than one run continues from the pagination
 *   state the run stopped at.
 * - `action` mode pages an action to the end every pass: a full listing, so a
 *   mirror type removes what the source no longer returns.
 *
 * One run can return more records than the engine takes per batch. They are
 * staged, one per line, in the binding's private folder and handed out a page
 * at a time; the cursor points into the staged file, and only once the last
 * page is taken does it move to the state the run reached. A staged file that
 * went missing (a crash, a cleanup) costs one repeated drain, never a record.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  type ConnectorTestExchange,
  type ConnectorTypeManifest,
  HttpStatusError,
  type SpectralComponentSource,
  createLogger,
} from '@bendyline/gezel';
import { ReconnectRequiredError } from '../natives/oauth-session.js';
import { type NormalizeSpec, applyNormalize, jget, ordinalKeyFromTs } from '../normalize.js';
import { connectorSecretKey } from '../registry.js';
import type { InstalledComponent } from '../spectral/component-store.js';
import type {
  AdapterDeps,
  ChangeBatch,
  ConnectorAdapter,
  ConnectorBindingRef,
  ListChangesOptions,
  NormalizedRecord,
  RecordRef,
} from '../types.js';
import {
  type ComponentJob,
  type ComponentResult,
  runSpectralComponent,
  scrubSecrets,
} from './spectral-host.js';
import { buildConnection, resolveInputs } from './spectral.js';

const log = createLogger('connectors');
const CURSOR_V = 2;

interface Staged {
  file: string;
  /** Byte offset of the next unread line. */
  offset: number;
  taken: number;
  total: number;
  /** Where the cursor goes once every staged record is taken. */
  then: { state?: unknown; resume?: unknown; drained: boolean; complete: boolean };
}

export interface SpectralComponentCursor {
  v: typeof CURSOR_V;
  /** `name@major`: a state belongs to the component that wrote it. */
  pkg: string;
  state?: unknown;
  resume?: unknown;
  staged?: Staged;
}

/**
 * Test seam: recorded exchanges answered across every run of a pass (and of
 * later passes), each at most once, in order. The runner answers from them
 * with the network denied and reports which it used.
 */
export class SpectralReplay {
  private readonly used = new Set<number>();
  constructor(private readonly exchanges: readonly ConnectorTestExchange[]) {}

  /** The recordings not yet used, and where each sits in the full list. */
  pending(): { at: number[]; recordings: NonNullable<ComponentJob['replay']> } {
    const at: number[] = [];
    const recordings: NonNullable<ComponentJob['replay']> = [];
    this.exchanges.forEach((ex, i) => {
      if (ex.kind !== 'http' || this.used.has(i)) return;
      at.push(i);
      recordings.push({ request: ex.request, response: ex.response as Record<string, unknown> });
    });
    return { at, recordings };
  }

  markUsed(at: readonly number[], replayed: readonly number[] | undefined): void {
    for (const local of replayed ?? []) {
      const i = at[local];
      if (i !== undefined) this.used.add(i);
    }
  }

  /** HTTP recordings no run asked for. */
  unused(): number {
    return this.exchanges.filter((ex, i) => ex.kind === 'http' && !this.used.has(i)).length;
  }
}

function secretsOf(blob: string): string[] {
  const out = [blob];
  try {
    const walk = (v: unknown) => {
      if (typeof v === 'string') out.push(v);
      else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x);
    };
    walk(JSON.parse(blob));
  } catch {
    /* a bare secret */
  }
  return out.filter((s) => s.length >= 8);
}

export class SpectralComponentAdapter
  implements ConnectorAdapter<NormalizedRecord, SpectralComponentCursor>
{
  readonly typeId: string;
  private readonly src: SpectralComponentSource;
  private readonly pkgKey: string;
  private connection: unknown = null;
  private secrets: string[] = [];
  private installed: InstalledComponent | undefined;
  private tempStaging: string | undefined;

  constructor(
    private readonly type: ConnectorTypeManifest,
    private readonly binding: ConnectorBindingRef,
    private readonly deps: AdapterDeps,
  ) {
    this.typeId = type.id;
    this.src = type.source as unknown as SpectralComponentSource;
    this.pkgKey = `${this.src.package.name}@${this.src.package.version.split('.')[0]}`;
  }

  async ensureAuth(): Promise<void> {
    const blob = await this.deps.secrets.get(
      connectorSecretKey(this.binding.type, this.binding.id),
    );
    if (!blob) throw new Error(`no stored credential for connector ${this.binding.id}`);
    const shape = (this.type.secretShape ?? {}) as { field?: string; fields?: string[] };
    this.connection = {
      configVarKey: '',
      ...(buildConnection(
        blob,
        this.src.connection.key,
        shape.field ?? shape.fields?.[0] ?? 'apiKey',
      ) as object),
    };
    this.secrets = secretsOf(blob);
    if (!this.deps.components) throw new Error('this build cannot run Prismatic components');
    // A connection made before this version, or a component removed by hand,
    // is fetched again here; a refusal names why.
    this.installed = await this.deps.components.ensure(this.src.package);
  }

  async listScopes(): Promise<string[]> {
    return [''];
  }

  async listChangesSince(
    _scope: string,
    cursor: SpectralComponentCursor | undefined,
    opts?: ListChangesOptions,
  ): Promise<ChangeBatch<SpectralComponentCursor>> {
    let cur: SpectralComponentCursor =
      cursor?.v === CURSOR_V && cursor.pkg === this.pkgKey
        ? cursor
        : { v: CURSOR_V, pkg: this.pkgKey };
    const limit = Math.max(1, opts?.limit ?? 500);
    let first = false;
    if (!cur.staged || !(await this.stagedExists(cur.staged.file))) {
      const run = await this.drain(cur);
      if ('batch' in run) return run.batch;
      cur = { ...cur, staged: run.staged };
      first = true;
    }
    return this.takePage(cur, cur.staged!, limit, first);
  }

  async fetchRecord(_scope: string, ref: RecordRef): Promise<NormalizedRecord> {
    return applyNormalize(this.type.normalize as NormalizeSpec, ref.raw, {
      namespace: this.type.id,
    });
  }

  async close(): Promise<void> {
    if (this.tempStaging)
      await rm(this.tempStaging, { recursive: true, force: true }).catch(() => {});
  }

  private async stagingDir(): Promise<string> {
    if (this.deps.stateDir) {
      const dir = join(this.deps.stateDir, 'staging');
      await mkdir(dir, { recursive: true });
      return dir;
    }
    this.tempStaging ??= await mkdtemp(join(tmpdir(), 'gezel-spectral-staging-'));
    return this.tempStaging;
  }

  private async stagedExists(file: string): Promise<boolean> {
    return (
      (await stat(join(await this.stagingDir(), file)).catch(() => undefined))?.isFile() ?? false
    );
  }

  /** One run of the component; the records go to a staged file. */
  private async drain(
    from: SpectralComponentCursor,
  ): Promise<{ staged: Staged } | { batch: ChangeBatch<SpectralComponentCursor> }> {
    let cur = from;
    const trigger = this.src.mode === 'trigger';
    const job: ComponentJob = {
      v: 2,
      op: trigger ? 'poll' : 'list',
      component: this.installed!,
      key: (trigger ? this.src.trigger : this.src.action)!,
      connection: { input: this.src.connection.input, value: this.connection },
      inputs: resolveInputs(
        this.src.inputs as Record<string, string> | undefined,
        this.binding.config ?? {},
      ),
      items: this.src.items,
      origins: this.src.origins,
      ...(this.src.page ? { page: this.src.page } : {}),
      ...(trigger && cur.state !== undefined ? { state: cur.state } : {}),
      ...(trigger && cur.resume !== undefined ? { resume: cur.resume } : {}),
      ...(this.src.limits ? { limits: this.src.limits } : {}),
    };
    const exec = async (j: ComponentJob) => {
      const replay = this.deps.spectralReplay?.pending();
      const run = await runSpectralComponent(replay ? { ...j, replay: replay.recordings } : j, {
        secrets: this.secrets,
        ...(this.deps.signal ? { signal: this.deps.signal } : {}),
      });
      if (replay) this.deps.spectralReplay?.markUsed(replay.at, run.result.replayed);
      return run;
    };
    let run = await exec(job);
    try {
      // A drain that cannot continue where the last run stopped (an expired
      // page token) starts again from the position it had reached.
      if (!run.result.ok && job.resume !== undefined && run.result.error.kind !== 'throttled') {
        log.info(`${this.typeId}: could not continue the last drain; starting it again`);
        await run.dispose();
        const { resume: _resume, ...fresh } = job;
        run = await exec(fresh);
        cur = { ...cur, resume: undefined };
      }
      const result = run.result;
      if (!result.ok) return { batch: this.failure(result, cur) };
      for (const line of 'logs' in result ? result.logs : []) {
        log.debug(`${this.typeId}: ${scrubSecrets(line, this.secrets)}`);
      }
      const dir = await this.stagingDir();
      // One binding drains one scope: whatever else is here is left over.
      for (const old of await readdir(dir).catch(() => [] as string[])) {
        await rm(join(dir, old), { force: true }).catch(() => {});
      }
      const file = `${randomUUID()}.ndjson`;
      const total = result.op === 'poll' || result.op === 'list' ? result.items : 0;
      if (total > 0) await copyFile(run.itemsFile, join(dir, file));
      const then =
        result.op === 'poll'
          ? {
              state: result.state,
              ...(result.drained ? {} : { resume: result.resume }),
              drained: result.drained,
              complete: result.drained,
            }
          : result.op === 'list'
            ? { drained: true, complete: result.complete }
            : { drained: true, complete: true };
      if (result.op === 'list' && !result.complete) {
        log.warn(
          `${this.typeId}: listing stopped at its ${result.stoppedBy ?? 'limit'}; nothing is removed this pass`,
        );
      }
      return { staged: { file, offset: 0, taken: 0, total, then } };
    } finally {
      await run.dispose();
    }
  }

  private failure(
    result: Extract<ComponentResult, { ok: false }>,
    cur: SpectralComponentCursor,
  ): ChangeBatch<SpectralComponentCursor> {
    const { kind, message, status, retryAfterMs } = result.error;
    const said = scrubSecrets(message, this.secrets);
    if (kind === 'throttled') {
      return {
        records: [],
        cursor: cur,
        rateLimited: true,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };
    }
    if (kind === 'auth') {
      throw new ReconnectRequiredError(
        `${this.type.name} no longer accepts the saved credential. Reconnect it to continue. (${said})`,
      );
    }
    if (kind === 'upstream' && status !== undefined) {
      throw new HttpStatusError(status, `${this.type.name} had a server error: ${said}`, {
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      });
    }
    const lead: Record<string, string> = {
      forbidden: 'refused access',
      'not-found': 'could not find what this connection points at',
      network: 'could not be reached',
      origin: 'tried to reach a site this connector does not declare',
      'replay-miss': 'asked for something with no recording',
      input: 'did not accept this connection’s settings',
      component: 'failed',
      upstream: 'had a server error',
    };
    throw new Error(`${this.type.name} ${lead[kind] ?? 'failed'}: ${said}`);
  }

  /** Up to `limit` staged records, and the cursor just past them. */
  private async takePage(
    cur: SpectralComponentCursor,
    staged: Staged,
    limit: number,
    first: boolean,
  ): Promise<ChangeBatch<SpectralComponentCursor>> {
    const path = join(await this.stagingDir(), staged.file);
    const items: unknown[] = [];
    let offset = staged.offset;
    if (staged.total > 0) {
      const stream = createReadStream(path, { start: staged.offset });
      const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
      for await (const line of lines) {
        if (items.length >= limit) break;
        offset += Buffer.byteLength(line) + 1;
        if (line) items.push(JSON.parse(line));
      }
      lines.close();
      stream.destroy();
    }
    const taken = staged.taken + items.length;
    const records = items.map((raw) => this.ref(raw));
    const last = taken >= staged.total;
    const listing = this.src.mode === 'action';
    const fullListing = listing
      ? { fullListing: { first, last, ...(staged.then.complete ? {} : { incomplete: true }) } }
      : {};
    if (!last) {
      return {
        records,
        cursor: { ...cur, staged: { ...staged, offset, taken } },
        partial: true,
        ...fullListing,
      };
    }
    await rm(path, { force: true }).catch(() => {});
    const { staged: _done, ...rest } = cur;
    const next: SpectralComponentCursor = {
      ...rest,
      ...(staged.then.state !== undefined ? { state: staged.then.state } : {}),
      resume: staged.then.resume,
    };
    if (next.resume === undefined) delete next.resume;
    return {
      records,
      cursor: next,
      // An unfinished drain continues in this pass while the engine allows.
      ...(staged.then.drained ? {} : { partial: true }),
      ...fullListing,
    };
  }

  private ref(raw: unknown): RecordRef {
    const id = jget(raw, this.src.idPath ?? '$.id');
    const ts = this.src.tsPath ? jget(raw, this.src.tsPath) : undefined;
    return {
      id:
        typeof id === 'string' || typeof id === 'number'
          ? String(id)
          : // No id: content identity keeps the record stable across passes.
            `h-${createHash('sha256').update(JSON.stringify(raw)).digest('hex').slice(0, 24)}`,
      raw,
      ...(typeof ts === 'string' ? { ts } : {}),
      ...ordinalKeyFromTs(ts),
    };
  }
}
