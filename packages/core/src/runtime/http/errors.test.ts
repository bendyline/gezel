import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ScriptNotFoundError } from '../../scripts/errors.js';
import { PromptDraftNotFoundError, PromptDraftSentError } from '../drafts.js';
import { HttpStatusError, errorToResponse } from './errors.js';

describe('errorToResponse', () => {
  it('turns a validation failure into 422 naming every issue', () => {
    const result = z.object({ name: z.string(), n: z.number() }).safeParse({});
    const reply = errorToResponse(result.error, { exposeUnknown: true });
    expect(reply.status).toBe(422);
    expect(reply.body.error).toMatch(/name: .*; n: /);
  });
  it('keeps the status a thrower chose', () => {
    expect(errorToResponse(new HttpStatusError('busy', 409), { exposeUnknown: false })).toEqual({
      status: 409,
      body: { error: 'busy' },
    });
  });
  it('recognises the script errors by name', () => {
    expect(
      errorToResponse(new ScriptNotFoundError('x', 'project'), { exposeUnknown: false }).status,
    ).toBe(404);
    const meta = new Error('bad meta');
    meta.name = 'ScriptMetaError';
    expect(errorToResponse(meta, { exposeUnknown: false }).status).toBe(422);
  });
  it('answers a missing draft with 404 and an edit to a sent one with 409', () => {
    const id = '2026-09-25-0001';
    expect(errorToResponse(new PromptDraftNotFoundError(id), { exposeUnknown: false }).status).toBe(
      404,
    );
    expect(errorToResponse(new PromptDraftSentError(id), { exposeUnknown: false })).toEqual({
      status: 409,
      body: { error: `A sent draft cannot be edited: ${id}` },
    });
  });
  it('exposes unknown errors only when told to', () => {
    expect(errorToResponse(new Error('secret'), { exposeUnknown: true })).toEqual({
      status: 400,
      body: { error: 'secret' },
    });
    expect(errorToResponse(new Error('secret'), { exposeUnknown: false, requestId: 'r' })).toEqual({
      status: 500,
      body: { error: 'internal_error', requestId: 'r' },
    });
  });
});
