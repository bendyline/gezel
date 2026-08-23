import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type {
  AppServeSiteStatus,
  AppServeStartRequest,
  AppServeStartResponse,
} from '@bendyline/gezel';
import { createLogger, resolveSecurityPolicy } from '@bendyline/gezel';
import { type ServerType, serve } from '@hono/node-server';
import { resolveProjectTypeManifest } from '../project-type/script-tools.js';
import {
  APP_SERVE_MARKER_HEADER,
  type AppServeSiteDeps,
  type AppServeSiteRuntime,
  buildAppServeSiteApp,
} from './site-app.js';
import { VisitorStore } from './visitors.js';

const log = createLogger('app-serve');

const ORPHAN_ARCHIVE_INTERVAL_MS = 60_000;

/** A start request the controller refused; carries the HTTP status to use. */
export class AppServeStartError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 409 = 400,
  ) {
    super(message);
    this.name = 'AppServeStartError';
  }
}

interface AppServeSite {
  runtime: AppServeSiteRuntime;
  siteKey: string;
  server: ServerType;
  port: number;
  projectName: string;
  typeId: string;
  typeName: string;
  typeVersion: string;
  startedAt: string;
  archiveTimer: ReturnType<typeof setInterval>;
}

export interface AppServeController {
  list(): AppServeSiteStatus[];
  get(siteId: string): AppServeSiteStatus | null;
  start(request: AppServeStartRequest): Promise<AppServeStartResponse>;
  rotateKey(
    siteId: string,
    opts?: { revokeVisitors?: boolean },
  ): { siteKey: string; shareUrl: string } | null;
  stop(siteId: string): Promise<boolean>;
  stopAll(): Promise<void>;
}

export function createAppServeController(deps: AppServeSiteDeps): AppServeController {
  const sites = new Map<string, AppServeSite>();

  function shareUrl(site: AppServeSite): string {
    const host = site.runtime.boundHost === '0.0.0.0' ? '127.0.0.1' : site.runtime.boundHost;
    const base = `http://${host}:${site.port}/`;
    return site.runtime.public ? base : `${base}?k=${site.siteKey}`;
  }

  function toStatus(site: AppServeSite): AppServeSiteStatus {
    return {
      siteId: site.runtime.siteId,
      projectId: site.runtime.projectId,
      projectName: site.projectName,
      typeId: site.typeId,
      typeName: site.typeName,
      typeVersion: site.typeVersion,
      host: site.runtime.boundHost,
      port: site.port,
      url: `http://${site.runtime.boundHost === '0.0.0.0' ? '127.0.0.1' : site.runtime.boundHost}:${site.port}/`,
      chat: site.runtime.chat,
      public: site.runtime.public,
      startedAt: site.startedAt,
      visitors: site.runtime.visitors.count(),
      counters: { ...site.runtime.counters },
    };
  }

  async function archiveSessions(sessionIds: string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      await deps.chat
        .archiveSession(sessionId)
        .catch((err) => log.warn(`[archive] visitor session ${sessionId}: ${String(err)}`));
    }
  }

  async function teardown(site: AppServeSite): Promise<void> {
    clearInterval(site.archiveTimer);
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      site.server.close(finish);
      const raw = site.server as unknown as {
        closeAllConnections?: () => void;
        closeIdleConnections?: () => void;
      };
      raw.closeIdleConnections?.();
      raw.closeAllConnections?.();
      const timer = setTimeout(finish, 2_000);
      timer.unref?.();
    });
    const chatSessions = [
      ...site.runtime.visitors.liveChatSessions(),
      ...site.runtime.visitors.drainOrphanedChatSessions(),
    ];
    site.runtime.visitors.dispose();
    await archiveSessions(chatSessions);
    log.info(`[site ${site.runtime.siteId}] stopped (port ${site.port})`);
  }

  return {
    list: () => [...sites.values()].map(toStatus),
    get: (siteId) => {
      const site = sites.get(siteId);
      return site ? toStatus(site) : null;
    },

    async start(request) {
      const project = await deps.store.getProject(request.projectId).catch(() => null);
      if (!project) throw new AppServeStartError('project not found', 400);
      const pt = project.projectType;
      if (!pt) {
        throw new AppServeStartError(
          'this project has no applied AI App — run `gezel app apply` first',
          409,
        );
      }
      for (const site of sites.values()) {
        if (site.runtime.projectId === request.projectId) {
          throw new AppServeStartError(
            `project is already being served (site ${site.runtime.siteId})`,
            409,
          );
        }
      }
      const config = await deps.store.readConfig().catch(() => null);
      const policy = config ? resolveSecurityPolicy(config) : null;
      if (!policy?.allowScriptExecution) {
        throw new AppServeStartError(
          'the security policy disables script execution, which visitor page tools require — raise it in Settings before serving',
          403,
        );
      }
      const manifest = await resolveProjectTypeManifest(deps.catalog, project);
      if (!manifest?.pages?.entry) {
        throw new AppServeStartError('the applied app declares no Output page to serve', 409);
      }
      const host = request.host ?? '127.0.0.1';
      if (isIP(host) === 0) {
        throw new AppServeStartError(
          'host must be an IP literal (use --allow-host for names)',
          400,
        );
      }

      const siteId = randomBytes(6).toString('hex');
      const runtime: AppServeSiteRuntime = {
        siteId,
        projectId: request.projectId,
        chat: request.chat ?? false,
        public: request.public ?? false,
        allowedHosts: (request.allowedHosts ?? []).map((name) => name.toLowerCase()),
        boundHost: host,
        siteKey: () => sites.get(siteId)?.siteKey ?? '',
        visitors: new VisitorStore(),
        counters: { pageViews: 0, invokes: 0, reads: 0, chatMessages: 0 },
      };
      const app = buildAppServeSiteApp(deps, runtime);

      let bound: { server: ServerType; port: number };
      try {
        bound = await new Promise((resolve, reject) => {
          let listening = false;
          const server = serve(
            { fetch: app.fetch, port: request.port ?? 0, hostname: host },
            (info) => {
              listening = true;
              resolve({ server, port: info.port });
            },
          );
          // Visitors get exactly the routes on the allowlist — no tunneled
          // sockets, no protocol upgrades.
          server.on('upgrade', (_req, socket) => socket.destroy());
          server.on('connect', (_req, socket) => socket.destroy());
          server.on('error', (error) => {
            if (!listening) reject(error);
            else log.error(`[site ${siteId}] listener error: ${String(error)}`);
          });
        });
      } catch (error) {
        runtime.visitors.dispose();
        if ((error as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE') {
          throw new AppServeStartError(await describeServeConflict(request.port ?? 0, host), 409);
        }
        throw error;
      }

      const site: AppServeSite = {
        runtime,
        siteKey: request.siteKey ?? randomBytes(24).toString('base64url'),
        server: bound.server,
        port: bound.port,
        projectName: project.name,
        typeId: pt.id,
        typeName: manifest.name ?? pt.id,
        typeVersion: pt.version,
        startedAt: new Date().toISOString(),
        archiveTimer: setInterval(() => {
          runtime.visitors.sweep();
          const orphaned = runtime.visitors.drainOrphanedChatSessions();
          if (orphaned.length > 0) void archiveSessions(orphaned);
        }, ORPHAN_ARCHIVE_INTERVAL_MS),
      };
      site.archiveTimer.unref?.();
      sites.set(siteId, site);
      await deps.history
        .log({
          kind: 'app-serve.started',
          projectId: request.projectId,
          summary: `Serving "${site.typeName}" on ${host}:${bound.port}`,
          details: { siteId, typeId: pt.id, port: bound.port, chat: runtime.chat },
        })
        .catch(() => {});
      log.info(
        `[site ${siteId}] serving ${pt.id}@${pt.version} for project ${request.projectId} on ${host}:${bound.port}${runtime.chat ? ' (chat on)' : ''}`,
      );
      return { ...toStatus(site), siteKey: site.siteKey, shareUrl: shareUrl(site) };
    },

    rotateKey(siteId, opts) {
      const site = sites.get(siteId);
      if (!site) return null;
      site.siteKey = randomBytes(24).toString('base64url');
      if (opts?.revokeVisitors) {
        site.runtime.visitors.clear();
        const orphaned = site.runtime.visitors.drainOrphanedChatSessions();
        if (orphaned.length > 0) void archiveSessions(orphaned);
      }
      return { siteKey: site.siteKey, shareUrl: shareUrl(site) };
    },

    async stop(siteId) {
      const site = sites.get(siteId);
      if (!site) return false;
      sites.delete(siteId);
      await teardown(site);
      await deps.history
        .log({
          kind: 'app-serve.stopped',
          projectId: site.runtime.projectId,
          summary: `Stopped serving "${site.typeName}"`,
          details: { siteId },
        })
        .catch(() => {});
      return true;
    },

    async stopAll() {
      const all = [...sites.values()];
      sites.clear();
      await Promise.all(all.map((site) => teardown(site)));
    },
  };
}

async function describeServeConflict(port: number, host: string): Promise<string> {
  try {
    const response = await fetch(`http://${host}:${port}/`, {
      signal: AbortSignal.timeout(750),
    });
    if (response.headers.get(APP_SERVE_MARKER_HEADER) === '1') {
      return `Port ${port} is already serving another Gezel app site. Stop it first (gezel app serve stop) or pick another --port.`;
    }
  } catch {
    // A raw/non-HTTP listener is still a conflict; use the generic message.
  }
  return `Port ${port} is already in use by another process. Pick another --port.`;
}
