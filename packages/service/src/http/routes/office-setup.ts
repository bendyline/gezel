import {
  ConfigureOfficeRequestSchema,
  LibreOfficeHostReportSchema,
  OfficeHostReportSchema,
} from '@bendyline/gezel';
import { type Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { z } from 'zod';
import { requireFirstParty } from '../auth.js';
import type { ServiceContext } from '../context.js';

const limit = bodyLimit({
  maxSize: 16 * 1024,
  onError: (c) => c.json({ error: 'request_too_large' }, 413),
});

async function parseBody<S extends z.ZodTypeAny>(
  c: Context,
  schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return {
      ok: false,
      response: c.json({ error: 'invalid_json', message: 'Request body is not valid JSON.' }, 400),
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      response: c.json(
        {
          error: 'invalid_request',
          message: parsed.error.issues.map((issue) => issue.message).join('; '),
        },
        400,
      ),
    };
  }
  return { ok: true, data: parsed.data };
}

function setupError(c: Context, error: unknown, fallbackCode: string, fallbackMessage: string) {
  const candidate = error as { status?: unknown; code?: unknown; message?: unknown };
  const status =
    candidate.status === 400 || candidate.status === 404 || candidate.status === 409
      ? candidate.status
      : 500;
  const code = typeof candidate.code === 'string' ? candidate.code : fallbackCode;
  const message =
    status < 500 && typeof candidate.message === 'string' ? candidate.message : fallbackMessage;
  return c.json({ error: code, message }, status);
}

/**
 * First-party administration of the Word / Excel / PowerPoint integration.
 * The desktop app calls PUT, performs the OS-side steps (trust the CA,
 * register each manifest), and reports back through POST /host-report.
 */
export function officeSetupRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  const fail = (c: Context, e: unknown) =>
    setupError(c, e, 'office_setup_failed', 'Office setup could not be changed.');
  app.use('*', requireFirstParty());
  app.get('/', async (c) => c.json(await ctx.officeSetup.status()));
  app.put('/', limit, async (c) => {
    const body = await parseBody(c, ConfigureOfficeRequestSchema);
    if (!body.ok) return body.response;
    try {
      return c.json(await ctx.officeSetup.configure(body.data));
    } catch (error) {
      return fail(c, error);
    }
  });
  app.post('/host-report', limit, async (c) => {
    const body = await parseBody(c, OfficeHostReportSchema);
    if (!body.ok) return body.response;
    try {
      return c.json(await ctx.officeSetup.recordHostReport(body.data));
    } catch (error) {
      return fail(c, error);
    }
  });
  app.delete('/', async (c) => {
    try {
      return c.json(await ctx.officeSetup.remove());
    } catch (error) {
      return fail(c, error);
    }
  });
  return app;
}

/** First-party administration of the LibreOffice extension. */
export function libreofficeSetupRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();
  const fail = (c: Context, e: unknown) =>
    setupError(c, e, 'libreoffice_setup_failed', 'LibreOffice setup could not be changed.');
  app.use('*', requireFirstParty());
  app.get('/', async (c) => c.json(await ctx.libreofficeSetup.status()));
  app.put('/', async (c) => {
    try {
      return c.json(await ctx.libreofficeSetup.configure());
    } catch (error) {
      return fail(c, error);
    }
  });
  app.post('/host-report', limit, async (c) => {
    const body = await parseBody(c, LibreOfficeHostReportSchema);
    if (!body.ok) return body.response;
    try {
      return c.json(await ctx.libreofficeSetup.recordHostReport(body.data));
    } catch (error) {
      return fail(c, error);
    }
  });
  app.delete('/', async (c) => {
    try {
      return c.json(await ctx.libreofficeSetup.remove());
    } catch (error) {
      return fail(c, error);
    }
  });
  return app;
}
