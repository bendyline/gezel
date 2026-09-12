import type { GezelClient } from '@bendyline/gezel-client/node';
import { GezelApp } from './client.js';
import { resolveDaemon } from './connect-or-host.js';
import { ensureModel } from './ensure-model.js';
import { ensureProject } from './ensure-project.js';
import { GezelSdkError } from './errors.js';
import type {
  ConnectOrHostInput,
  ConnectionMode,
  DaemonConnection,
  EnsureModelOptions,
  EnsureModelResult,
  EnsureProjectOptions,
} from './host-types.js';
import { GezelProject } from './project.js';

/**
 * Gezel, as your application holds it: one connection, the models it needs,
 * and the projects it works in.
 *
 * Whether the work happens in the Gezel the person already runs or in a daemon
 * this application hosts is settled once, here; everything after that is the
 * same either way.
 *
 * ```ts
 * const gezel = await connectOrHost({ appId: 'qualla', appName: 'Qualla', host: {} });
 *
 * await gezel.ensureModel({ model: 'gemma4-e2b-q4' });
 * const project = await gezel.ensureProject({ package: './qualla.gezapp', folder });
 *
 * const chat = await project.openChat({ role: 'travel-guide' });
 * for await (const event of chat.send('Where should I eat in Utrecht?')) {
 *   if (event.type === 'delta') process.stdout.write(event.content);
 * }
 * ```
 */
export class Gezel {
  private readonly app: GezelApp;
  private closing: Promise<void> | undefined;

  private constructor(readonly daemon: DaemonConnection) {
    this.app = new GezelApp({
      baseUrl: daemon.baseUrl,
      token: daemon.token,
      fetch: daemon.fetch,
    });
  }

  /** @internal — use {@link connectOrHost}. */
  static fromDaemon(daemon: DaemonConnection): Gezel {
    return new Gezel(daemon);
  }

  /** The full typed product API, for anything this surface does not cover. */
  get client(): GezelClient {
    return this.daemon.client;
  }

  /** How this connection was obtained: adopted, hosted, configured, … */
  get mode(): ConnectionMode {
    return this.daemon.mode;
  }

  /** True when this process owns the daemon (and may set its defaults). */
  get hosting(): boolean {
    return this.daemon.mode === 'hosted' || this.daemon.mode === 'hosted-adopted';
  }

  /** The OpenAI-shaped surface, for stateless completions and embeddings. */
  get openai(): GezelApp {
    return this.app;
  }

  /**
   * Make a model usable: already installed, from a `.gezmodel` this
   * application ships, or downloaded.
   */
  ensureModel(opts: EnsureModelOptions): Promise<EnsureModelResult> {
    return ensureModel({ client: this.client, app: this.app, owned: this.hosting }, opts);
  }

  /**
   * Make sure this application has its project, and return it.
   *
   * With a `.gezapp` it also applies that app — crew, scripts, seeds, and the
   * models it depends on. Idempotent, and meant to run on every launch.
   */
  async ensureProject(opts: EnsureProjectOptions): Promise<GezelProject> {
    const applied = await ensureProject(
      {
        client: this.client,
        ensureModel: (input) =>
          this.ensureModel({
            model: input.model,
            ...(input.bundle ? { bundle: input.bundle } : {}),
            ...(input.onEvent ? { onEvent: input.onEvent } : {}),
          }),
      },
      opts,
    );
    return new GezelProject(this.daemon, applied.projectId, {
      gezels: applied.gezels,
      ...(applied.leadGezelId ? { leadGezelId: applied.leadGezelId } : {}),
      ...(applied.appId
        ? {
            app: {
              id: applied.appId,
              version: applied.version ?? '',
              imported: applied.imported === true,
              modelsEnsured: applied.modelsEnsured,
            },
          }
        : {}),
    });
  }

  /**
   * Work in a project that already exists — one this application created on an
   * earlier run, or one the person made themselves.
   */
  async openProject(projectId: string): Promise<GezelProject> {
    const project = await this.client.getProject(projectId).catch(() => null);
    if (!project) {
      throw new GezelSdkError(`no project ${projectId}`, { code: 'project_not_found' });
    }
    const gezels: Record<string, string> = {};
    const roster = await this.client.listGezels().catch(() => ({ gezels: [] }));
    for (const gezel of roster.gezels) {
      if (!project.gezelIds?.includes(gezel.id)) continue;
      if (gezel.templateId) gezels[gezel.templateId] = gezel.id;
    }
    return new GezelProject(this.daemon, project.id, {
      gezels,
      ...(project.voormanGezelId ? { leadGezelId: project.voormanGezelId } : {}),
    });
  }

  /** Stop a daemon this process started; release the transport either way. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      await this.app.close().catch(() => undefined);
      await this.daemon.close();
    })();
    return this.closing;
  }
}

/**
 * Connect to Gezel, or host one.
 *
 * The ladder, in order: an explicitly configured address, the Gezel the person
 * already runs (through the ordinary consent handshake), and — when the
 * application opted in with `host` — a daemon started inside this process.
 */
export async function connectOrHost(input: ConnectOrHostInput): Promise<Gezel> {
  return Gezel.fromDaemon(await resolveDaemon(input));
}
