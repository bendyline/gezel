/**
 * `GET /v1/identity` — unauthenticated. Publishes this device's stable
 * identity (Ed25519 public key + fingerprint) plus a signature over the
 * current TLS cert fingerprint, so a pairing client can:
 *   - pin the identity fingerprint (TOFU) at first contact, and
 *   - verify on every later connect that the box still controls that identity
 *     even though the TLS cert rotates each boot.
 *
 * Unauth like `/v1/openapi.json`: it's a pairing handshake (no token exists
 * yet) and exposes only public material.
 */

import { GEZEL_VERSION } from '@bendyline/gezel';
import { Hono } from 'hono';
import { PROTOCOL_VERSION } from '../../providers/remote/wire.js';
import { signCertFingerprint } from '../../remotes/identity.js';
import type { ServiceContext } from '../context.js';

export function v1IdentityRoutes(ctx: ServiceContext): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const sig = ctx.tlsCertSha256
      ? await signCertFingerprint(ctx.secrets, ctx.tlsCertSha256)
      : null;
    return c.json({
      deviceId: ctx.deviceIdentity.deviceId,
      publicKeyPem: ctx.deviceIdentity.publicKeyPem,
      fingerprint: ctx.deviceIdentity.fingerprint,
      ...(ctx.tlsCertSha256 ? { tlsCertFingerprint: ctx.tlsCertSha256 } : {}),
      ...(ctx.tlsCertPem ? { tlsCertPem: ctx.tlsCertPem } : {}),
      ...(sig ? { sig } : {}),
      gezelVersion: GEZEL_VERSION,
      protocolVersion: PROTOCOL_VERSION,
    });
  });

  return app;
}
