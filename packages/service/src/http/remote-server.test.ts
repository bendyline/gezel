import { describe, expect, it } from 'vitest';
import { isRemoteServingRoute } from './remote-server.js';

describe('isRemoteServingRoute', () => {
  it.each([
    ['GET', '/v1/identity'],
    ['POST', '/v1/apps/register'],
    ['GET', '/v1/apps/grant/grant-1'],
    ['GET', '/v1/apps/grant/grant-1/events'],
    ['DELETE', '/v1/apps/device-1/token'],
    ['GET', '/v1/remote/models'],
    ['POST', '/v1/remote/admit'],
    ['POST', '/v1/remote/infer'],
  ])('allows the pairing and inference surface: %s %s', (method, path) => {
    expect(isRemoteServingRoute(method, path)).toBe(true);
  });

  it.each([
    ['GET', '/'],
    ['GET', '/api/health'],
    ['GET', '/api/config'],
    ['GET', '/v1/openapi.json'],
    ['GET', '/v1/apps'],
    ['POST', '/v1/apps/grant/grant-1/approve'],
    ['POST', '/v1/apps/grant/grant-1/deny'],
    ['POST', '/v1/chat/completions'],
    ['GET', '/v1/models'],
  ])('keeps local and administrative routes off the LAN listener: %s %s', (method, path) => {
    expect(isRemoteServingRoute(method, path)).toBe(false);
  });
});
