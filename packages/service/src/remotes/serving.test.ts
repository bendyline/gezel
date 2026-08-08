import { describe, expect, it } from 'vitest';
import { generateLoopbackCert } from '../http/cert.js';
import { createRemoteServingController } from './serving.js';

describe('RemoteServingController', () => {
  it('starts, reports the actual bound port, reuses the listener, and stops live', async () => {
    const cert = await generateLoopbackCert();
    const controller = createRemoteServingController({
      cert,
      deviceFingerprint: 'ab'.repeat(32),
      fetch: () => () => Promise.resolve(new Response('ok')),
    });
    try {
      const started = await controller.reconfigure({
        enabled: true,
        bindAddress: '127.0.0.1',
        port: 0,
      });
      expect(started).toMatchObject({ listening: true, host: '127.0.0.1' });
      expect(started.port).toBeGreaterThan(0);
      expect(controller.status()).toEqual(started);

      const unchanged = await controller.reconfigure({
        enabled: true,
        bindAddress: '127.0.0.1',
        port: started.port,
      });
      expect(unchanged).toEqual(started);

      await controller.reconfigure({ enabled: false });
      expect(controller.status()).toEqual({ listening: false });
    } finally {
      await controller.stop();
    }
  });

  it('fails closed when TLS is unavailable', async () => {
    const controller = createRemoteServingController({
      cert: null,
      deviceFingerprint: 'ab'.repeat(32),
      fetch: () => () => Promise.resolve(new Response('ok')),
    });
    await expect(controller.reconfigure({ enabled: true })).rejects.toThrow(/requires HTTPS/);
    expect(controller.status()).toEqual({ listening: false });
  });

  it('rejects a non-IP bindAddress without disturbing a live listener', async () => {
    const cert = await generateLoopbackCert();
    const controller = createRemoteServingController({
      cert,
      deviceFingerprint: 'ab'.repeat(32),
      fetch: () => () => Promise.resolve(new Response('ok')),
    });
    try {
      const started = await controller.reconfigure({
        enabled: true,
        bindAddress: '127.0.0.1',
        port: 0,
      });
      expect(started.listening).toBe(true);
      await expect(
        controller.reconfigure({ enabled: true, bindAddress: 'mybox.local', port: 0 }),
      ).rejects.toThrow(/IP literal/);
      // The healthy listener must survive the rejected reconfigure.
      expect(controller.status()).toEqual(started);
    } finally {
      await controller.stop();
    }
  });

  it('treats an empty bindAddress as the routable default', async () => {
    const cert = await generateLoopbackCert();
    const controller = createRemoteServingController({
      cert,
      deviceFingerprint: 'ab'.repeat(32),
      fetch: () => () => Promise.resolve(new Response('ok')),
    });
    try {
      const started = await controller.reconfigure({ enabled: true, bindAddress: '', port: 0 });
      expect(started).toMatchObject({ listening: true, host: '0.0.0.0' });
    } finally {
      await controller.stop();
    }
  });
});
