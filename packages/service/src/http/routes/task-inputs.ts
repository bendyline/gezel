import {
  CreateInputStagingRequestSchema,
  TaskInputPreviewRequestSchema,
  craftbookInputParams,
} from '@bendyline/gezel';
import { Hono } from 'hono';
import { type TaskInputError, previewTaskInput } from '../../tasks/inputs/resolve.js';
import {
  InputStagingLimitError,
  InputStagingNotFoundError,
  InputStagingPathError,
} from '../../tasks/inputs/staging.js';
import type { ServiceContext } from '../context.js';

/**
 * Craftbook inputs, before launch: a dry-run of a source (the launcher's
 * "37 files" line), and the upload staging area for files the user picks
 * from their own computer. First-party clients only — the scope guard keeps
 * session tokens out, so "from your computer" always means the person.
 */
export function taskInputRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  const inputSpec = async (
    projectId: string,
    craftbookId: string,
    param: string,
    version?: string,
  ) => {
    const book = await ctx.tasks.describeCraftbook(projectId, craftbookId, {
      ...(version ? { version } : {}),
    });
    if (book === null) return { error: `craftbook "${craftbookId}" not found` } as const;
    const schema = book.paramSchema;
    const input = craftbookInputParams(schema).find((i) => i.key === param);
    if (!input)
      return { error: `"${param}" is not an input of craftbook "${craftbookId}"` } as const;
    return { schema, input } as const;
  };

  app.post('/:projectId/tasks/input-preview', async (c) => {
    const projectId = c.req.param('projectId');
    const body = TaskInputPreviewRequestSchema.parse(await c.req.json());
    const found = await inputSpec(projectId, body.craftbookId, body.param, body.craftbookVersion);
    if ('error' in found) return c.json({ error: found.error }, 404);
    const preview = await previewTaskInput(
      { store: ctx.store, staging: ctx.inputStaging },
      {
        projectId,
        craftbookId: body.craftbookId,
        paramSchema: found.schema,
        param: body.param,
        source: body.source,
      },
    );
    return c.json(preview);
  });

  app.post('/:projectId/input-staging', async (c) => {
    const projectId = c.req.param('projectId');
    const body = CreateInputStagingRequestSchema.parse(await c.req.json());
    const found = await inputSpec(projectId, body.craftbookId, body.param, body.craftbookVersion);
    if ('error' in found) return c.json({ error: found.error }, 404);
    const created = await ctx.inputStaging.create(projectId, {
      craftbookId: body.craftbookId,
      param: body.param,
      ...(body.label ? { label: body.label } : {}),
      spec: found.input.spec,
    });
    return c.json(created, 201);
  });

  app.put('/:projectId/input-staging/:stagingId/file', async (c) => {
    const projectId = c.req.param('projectId');
    const stagingId = c.req.param('stagingId');
    const path = c.req.query('path') ?? '';
    try {
      const result = await ctx.inputStaging.putFile(projectId, stagingId, path, c.req.raw.body);
      return c.json(result);
    } catch (err) {
      if (err instanceof InputStagingNotFoundError) {
        return c.json({ error: err.message, code: err.code }, 404);
      }
      if (err instanceof InputStagingPathError) {
        return c.json({ error: err.message, code: err.code }, 400);
      }
      if (err instanceof InputStagingLimitError) {
        return c.json({ error: err.message, code: err.code, reason: err.reason }, 413);
      }
      throw err;
    }
  });

  app.delete('/:projectId/input-staging/:stagingId', async (c) => {
    const projectId = c.req.param('projectId');
    const stagingId = c.req.param('stagingId');
    try {
      await ctx.inputStaging.discard(projectId, stagingId);
    } catch (err) {
      if (err instanceof InputStagingNotFoundError) return c.json({ ok: true });
      throw err;
    }
    return c.json({ ok: true });
  });

  return app;
}

/** The JSON a launch failing on its inputs answers with — the message is the fix. */
export function taskInputErrorBody(err: TaskInputError): {
  error: string;
  code: string;
  param: string;
} {
  return { error: err.message, code: err.code, param: err.param };
}
