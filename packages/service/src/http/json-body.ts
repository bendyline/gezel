import { HttpStatusError } from '@bendyline/gezel/runtime';
import type { MiddlewareHandler } from 'hono';

/**
 * A malformed request body is the caller's mistake, but `c.req.json()`
 * reports it as a bare `SyntaxError`, which the error mapper cannot tell
 * from a server-side parse failure such as a corrupt file on disk. So
 * `PUT /api/config` with a broken body answered 500. Classified here, where
 * the body is read, every route answers 400; a route that already catches a
 * missing body still does.
 */
export function classifyMalformedJsonBody(): MiddlewareHandler {
  return async (c, next) => {
    const read = c.req.json.bind(c.req);
    c.req.json = (async () => {
      try {
        return await read();
      } catch (err) {
        if (err instanceof SyntaxError) {
          throw new HttpStatusError('The request body is not valid JSON.', 400);
        }
        throw err;
      }
    }) as typeof c.req.json;
    await next();
  };
}
