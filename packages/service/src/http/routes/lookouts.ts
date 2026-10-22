/**
 * Lookout routes. Project routes mount under `/api/projects`
 * (`/:id/lookouts…`); install-wide ones under `/api/lookouts`. Editing,
 * testing, and approving are the person's: session tokens reach only the
 * list and the proposal route (see scope-guard.ts), and a proposal is stored
 * disabled until the person approves it.
 */

import { LookoutInputSchema, LookoutUpdateSchema } from '@bendyline/gezel';
import { Hono } from 'hono';
import { z } from 'zod';
import { cameraAllowsCloud } from '../../connectors/live/camera/frame-access.js';
import { LookoutNotFoundError } from '../../lookouts/manager.js';
import { isOwnerCaller } from '../auth.js';
import { callerMaySeeLocation } from '../caller-location.js';
import type { ServiceContext } from '../context.js';

const LookSchema = z.object({ camera: z.string().max(200).optional() });
/**
 * What a gezel may propose: a camera, an optional yes/no question, simple
 * alert actions, and an optional follow-up. Email and craftbook runs are the
 * person's to add.
 */
const ProposalSchema = z.object({
  name: z.string().trim().min(1).max(80),
  camera: z.string().max(200).optional(),
  question: z.string().trim().min(3).max(300).optional(),
  actions: z
    .array(z.enum(['notify', 'chime', 'alarm', 'whistle', 'phone']))
    .min(1)
    .max(4)
    .default(['notify']),
  follow_up: z.string().trim().min(1).max(1000).optional(),
});
const SnoozeSchema = z.object({
  minutes: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 60)
    .nullable(),
});
const FeedbackSchema = z.object({ feedback: z.literal('false-alarm').nullable() });

function errorStatus(err: unknown): 400 | 404 {
  return err instanceof LookoutNotFoundError ? 404 : 400;
}

function message(err: unknown): string {
  if (err && typeof err === 'object' && 'issues' in err) {
    const issues = (err as { issues: Array<{ path: PropertyKey[]; message: string }> }).issues;
    return issues.map((i) => `${i.path.join('.') || 'lookout'}: ${i.message}`).join('; ');
  }
  return err instanceof Error ? err.message : String(err);
}

export function projectLookoutRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/:id/lookouts', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    return c.json(await ctx.lookouts.list(project.id));
  });

  // A gezel's proposal: stored disabled until the person approves it in the
  // project's Lookouts. A gezel can never arm, edit, or widen a lookout.
  app.post('/:id/lookouts/proposals', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    const auth = c.get('auth') as { gezelId?: string } | undefined;
    try {
      const raw = ProposalSchema.parse(await c.req.json());
      const cameras = (project.connectors ?? []).filter((b) => b.driver === 'device');
      const want = raw.camera?.trim().toLowerCase();
      const camera = want
        ? cameras.find(
            (b) => b.id.toLowerCase() === want || b.displayName?.trim().toLowerCase() === want,
          )
        : cameras.length === 1
          ? cameras[0]
          : undefined;
      if (!camera) {
        throw new Error(
          cameras.length === 0
            ? 'This project has no camera.'
            : `Name a camera: ${cameras.map((b) => b.displayName ?? b.id).join(', ')}.`,
        );
      }
      const input = LookoutInputSchema.parse({
        name: raw.name,
        source: { kind: 'camera', bindingId: camera.id },
        condition: raw.question
          ? { kind: 'ask', question: raw.question, strictness: 'normal' }
          : { kind: 'motion' },
        actions: [
          ...raw.actions.map((a) =>
            a === 'notify'
              ? { kind: 'notify' }
              : a === 'phone'
                ? { kind: 'push' }
                : { kind: 'sound', clip: a },
          ),
          ...(raw.follow_up ? [{ kind: 'ask-gezel', instruction: raw.follow_up }] : []),
        ],
      });
      const lookout = await ctx.lookouts.create(project.id, input, {
        kind: 'gezel',
        gezelId: auth?.gezelId ?? 'unknown',
      });
      return c.json({ lookout }, 201);
    } catch (err) {
      return c.json({ error: message(err) }, 400);
    }
  });

  // "What does the mud room look like right now?" The newest frame from a
  // watching camera: pixels for the person's app and on-device gezels (or
  // any gezel the camera allows), otherwise a description made on this
  // computer — the picture never leaves it.
  app.post('/:id/cameras/look', async (c) => {
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    const body = LookSchema.safeParse(await c.req.json().catch(() => ({})));
    const want = (body.success ? body.data.camera : undefined)?.trim().toLowerCase();
    const cameras = (project.connectors ?? []).filter((b) => b.driver === 'device');
    if (cameras.length === 0) return c.json({ error: 'This project has no camera.' }, 404);
    const pick = want
      ? cameras.find(
          (b) => b.id.toLowerCase() === want || b.displayName?.trim().toLowerCase() === want,
        )
      : cameras.length === 1
        ? cameras[0]
        : undefined;
    if (!pick) {
      return c.json(
        {
          error: `Name a camera: ${cameras.map((b) => b.displayName ?? b.id).join(', ')}.`,
          cameras: cameras.map((b) => ({ id: b.id, name: b.displayName ?? b.id })),
        },
        400,
      );
    }
    const name = pick.displayName ?? pick.id;
    if (pick.disabled) return c.json({ error: `${name} is paused.` }, 409);
    const frame = ctx.cameras.preview(pick);
    if (!frame) return c.json({ error: `${name} is not watching right now.` }, 409);
    const at = new Date(frame.at).toISOString();
    if (cameraAllowsCloud(pick) || (await callerMaySeeLocation(ctx, c))) {
      return c.json({
        camera: name,
        at,
        image: { mimeType: 'image/jpeg', base64: frame.jpeg.toString('base64') },
      });
    }
    const described = await ctx.recognition.recognize({
      bytes: frame.jpeg,
      mimeType: 'image/jpeg',
      mode: 'describe',
      cache: false,
    });
    return c.json({
      camera: name,
      at,
      ...(described.description ? { description: described.description } : {}),
      note: "This camera's pictures stay on this computer, so this is a description made here, not the picture.",
    });
  });

  app.post('/:id/lookouts', async (c) => {
    if (!isOwnerCaller(c)) return c.json({ error: 'owner_only' }, 403);
    const project = await ctx.store.getProject(c.req.param('id'));
    if (!project) return c.json({ error: 'not found' }, 404);
    try {
      const input = LookoutInputSchema.parse(await c.req.json());
      return c.json({ lookout: await ctx.lookouts.create(project.id, input) }, 201);
    } catch (err) {
      return c.json({ error: message(err) }, 400);
    }
  });

  app.put('/:id/lookouts/:lookoutId', async (c) => {
    if (!isOwnerCaller(c)) return c.json({ error: 'owner_only' }, 403);
    try {
      const patch = LookoutUpdateSchema.parse(await c.req.json());
      const lookout = await ctx.lookouts.update(c.req.param('id'), c.req.param('lookoutId'), patch);
      return c.json({ lookout });
    } catch (err) {
      return c.json({ error: message(err) }, errorStatus(err));
    }
  });

  app.delete('/:id/lookouts/:lookoutId', async (c) => {
    if (!isOwnerCaller(c)) return c.json({ error: 'owner_only' }, 403);
    try {
      await ctx.lookouts.remove(c.req.param('id'), c.req.param('lookoutId'));
      return c.body(null, 204);
    } catch (err) {
      return c.json({ error: message(err) }, errorStatus(err));
    }
  });

  app.post('/:id/lookouts/:lookoutId/approve', async (c) => {
    if (!isOwnerCaller(c)) return c.json({ error: 'owner_only' }, 403);
    try {
      const lookout = await ctx.lookouts.approve(c.req.param('id'), c.req.param('lookoutId'));
      return c.json({ lookout });
    } catch (err) {
      return c.json({ error: message(err) }, errorStatus(err));
    }
  });

  app.post('/:id/lookouts/:lookoutId/test', async (c) => {
    if (!isOwnerCaller(c)) return c.json({ error: 'owner_only' }, 403);
    try {
      const firing = await ctx.lookouts.test(c.req.param('id'), c.req.param('lookoutId'));
      return c.json({ firing });
    } catch (err) {
      return c.json({ error: message(err) }, errorStatus(err));
    }
  });

  app.post('/:id/lookouts/:lookoutId/snooze', async (c) => {
    if (!isOwnerCaller(c)) return c.json({ error: 'owner_only' }, 403);
    try {
      const { minutes } = SnoozeSchema.parse(await c.req.json());
      const lookout = await ctx.lookouts.snooze(
        c.req.param('id'),
        c.req.param('lookoutId'),
        minutes,
      );
      return c.json({ lookout });
    } catch (err) {
      return c.json({ error: message(err) }, errorStatus(err));
    }
  });

  app.post('/:id/lookouts/firings/:firingId/feedback', async (c) => {
    if (!isOwnerCaller(c)) return c.json({ error: 'owner_only' }, 403);
    try {
      const { feedback } = FeedbackSchema.parse(await c.req.json());
      await ctx.lookouts.feedback(c.req.param('id'), c.req.param('firingId'), feedback);
      return c.body(null, 204);
    } catch (err) {
      return c.json({ error: message(err) }, errorStatus(err));
    }
  });

  return app;
}

export function lookoutRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  // The alert's Stop key, and the tray's.
  app.post('/stop-sound', (c) => {
    if (!isOwnerCaller(c)) return c.json({ error: 'owner_only' }, 403);
    return c.json({ stopped: ctx.lookouts.stopSounds() });
  });

  // Alerts fired while the desktop app was not listening, so it can still
  // show them when it reconnects (chat events are never replayed).
  app.get('/recent-alerts', async (c) => {
    if (!isOwnerCaller(c)) return c.json({ error: 'owner_only' }, 403);
    const since = Date.parse(c.req.query('since') ?? '');
    return c.json({
      alerts: await ctx.lookouts.recentAlerts(
        Number.isFinite(since) ? since : Date.now() - 5 * 60_000,
      ),
    });
  });

  return app;
}
