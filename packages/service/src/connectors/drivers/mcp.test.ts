import { describe, expect, it } from 'vitest';
import { isRateLimitToolError } from './mcp.js';

describe('isRateLimitToolError', () => {
  it('matches the throttle shapes MCP transports actually produce', () => {
    expect(isRateLimitToolError('HTTP 429 Too Many Requests')).toBe(true);
    expect(isRateLimitToolError('Request failed with status 429')).toBe(true);
    expect(isRateLimitToolError('rate limit exceeded, retry after 60s')).toBe(true);
    expect(isRateLimitToolError('Rate-limited by upstream')).toBe(true);
    expect(isRateLimitToolError('RATELIMIT: slow down')).toBe(true);
    expect(isRateLimitToolError('too many requests')).toBe(true);
  });

  it('leaves genuine failures alone', () => {
    expect(isRateLimitToolError('connection refused')).toBe(false);
    expect(isRateLimitToolError('HTTP 500 internal error')).toBe(false);
    expect(isRateLimitToolError('invalid params for list_issues')).toBe(false);
    // A bare number inside an id must not read as a status code.
    expect(isRateLimitToolError('record 14290 not found')).toBe(false);
  });
});
