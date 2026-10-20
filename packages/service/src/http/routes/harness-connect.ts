import {
  HARNESS_CLIENT_LABELS,
  HarnessConnectRequestSchema,
  type HarnessConnectResponse,
  isHarnessBlocked,
  resolveHarnessToolsConfig,
  resolveSecurityPolicy,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HarnessBindingError, resolveHarnessBinding } from '../../harness-tools/binding.js';
import { buildInferDeps } from '../../projects/infer-deps.js';
import { bearerAuth, requireFirstParty } from '../auth.js';
import type { ServiceContext } from '../context.js';
import {
  HARNESS_OFF_HINT,
  HARNESS_STOPPED_HINT,
  HARNESS_UNBOUND_SEARCH_PROJECT,
} from '../harness-route-guard.js';

/**
 * `POST /v1/apps/harness-connect`: `gezel-mcp --harness <client>`, started by
 * an outside AI app, trades the owner credential it read from this account's
 * `runtime/` for an ephemeral token bound to the project for the folder the
 * app is working in (ADR 0018's rule: reading that directory already makes
 * the caller the owner). The token's scope is `harness`, which
 * `harnessRouteGuard` confines to a few read routes plus the memory and
 * image writes the person allowed.
 *
 * The token narrows what the app's *model* can do through Gezel's tools; it
 * is not a sandbox around the app, whose own shell can read `runtime/` too.
 */
export function harnessConnectRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.post(
    '/',
    bearerAuth(ctx.tokenStore),
    requireFirstParty(),
    bodyLimit({ maxSize: 16 * 1024 }),
    async (c) => {
      const parsed = HarnessConnectRequestSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) {
        return c.json(
          { error: 'invalid_harness_connect_request', issues: parsed.error.issues },
          400,
        );
      }
      const req = parsed.data;
      const fullConfig = await ctx.store.readConfig();
      const config = resolveHarnessToolsConfig(fullConfig);
      if (!config.enabled) {
        return c.json({ error: 'harness_tools_off', hint: HARNESS_OFF_HINT }, 403);
      }
      // Under super-lockdown the person's work stays on this machine, and Gezel
      // cannot see whether the outside app's model is local.
      if (!resolveSecurityPolicy(fullConfig).allowExternalChat) {
        return c.json(
          {
            error: 'harness_lockdown',
            hint: "Gezel's security level keeps your work on this computer, so other apps cannot use Gezel's tools. Change it in Gezel: Settings → Security.",
          },
          403,
        );
      }

      let binding: Awaited<ReturnType<typeof resolveHarnessBinding>>;
      try {
        binding = await resolveHarnessBinding(
          { store: ctx.store, infer: buildInferDeps(ctx) },
          req,
          config,
        );
      } catch (err) {
        if (err instanceof HarnessBindingError) {
          return c.json({ error: err.code, hint: err.message }, err.status);
        }
        throw err;
      }
      const projectId = binding.project?.id ?? null;
      if (isHarnessBlocked(config, req.client, projectId)) {
        return c.json({ error: 'harness_disconnected', hint: HARNESS_STOPPED_HINT }, 403);
      }

      const record = ctx.tokenStore.issueHarness({
        client: req.client,
        projectId,
        appName: HARNESS_CLIENT_LABELS[req.client],
        ...(binding.folder ? { folder: binding.folder } : {}),
      });
      const response: HarnessConnectResponse = {
        token: record.token,
        appId: record.appId,
        project: binding.project,
        ...(binding.project ? {} : { unboundReason: binding.unboundReason }),
        libraryDir: ctx.store.documentsDir(),
        artifactsDir: ctx.store.projectArtifactsDir(projectId ?? HARNESS_UNBOUND_SEARCH_PROJECT),
        memory: config.memory,
        images: config.images,
      };
      return c.json(response);
    },
  );

  return app;
}
