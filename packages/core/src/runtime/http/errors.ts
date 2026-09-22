/**
 * How a thrown error becomes an HTTP reply, on both hosts.
 *
 * Validation failures are the client's to fix, so they come back as 422
 * with every issue named. A `HttpStatusError` carries the status its
 * thrower chose. The two script-authoring errors are recognised by name,
 * because the classes live in packages that cannot both be imported here.
 * Everything else depends on the host: a browser talking to itself may show
 * the message, a daemon on the network must not.
 */
import { ZodError } from 'zod';

export class HttpStatusError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HttpStatusError';
  }
}

/** One line naming every issue, e.g. `name: Required; source: Expected string`. */
export function flattenZodIssues(error: ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(body)';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

export interface ErrorReply {
  status: number;
  body: { error: string; requestId?: string } & Record<string, unknown>;
}

export function errorToResponse(
  error: unknown,
  options: { exposeUnknown: boolean; requestId?: string },
): ErrorReply {
  if (error instanceof ZodError) return { status: 422, body: { error: flattenZodIssues(error) } };
  if (error instanceof HttpStatusError)
    return { status: error.status, body: { ...error.body, error: error.message } };
  if (error instanceof Error) {
    if (error.name === 'ScriptNotFoundError')
      return { status: 404, body: { error: error.message } };
    if (error.name === 'ScriptMetaError') return { status: 422, body: { error: error.message } };
    if (error.name === 'PromptDraftNotFoundError')
      return { status: 404, body: { error: error.message } };
  }
  if (options.exposeUnknown)
    return { status: 400, body: { error: error instanceof Error ? error.message : String(error) } };
  return {
    status: 500,
    body: {
      error: 'internal_error',
      ...(options.requestId ? { requestId: options.requestId } : {}),
    },
  };
}
