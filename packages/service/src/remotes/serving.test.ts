import { describe, expect, it, vi } from 'vitest';
import { generateLoopbackCert } from '../http/cert.js';
import type { LanAdvertiser } from './lan-discovery.js';
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

  it('refuses to serve the LAN without a device identity', async () => {
    const controller = createRemoteServingController({
      cert: await generateLoopbackCert(),
      deviceFingerprint: null,
      fetch: () => () => Promise.resolve(new Response('ok')),
    });
    try {
      await expect(
        controller.reconfigure({ enabled: true, bindAddress: '127.0.0.1', port: 0 }),
      ).rejects.toThrow('requires a device identity');
      expect(controller.status()).toEqual({ listening: false });
      // Staying off needs no identity.
      await expect(controller.reconfigure({ enabled: false })).resolves.toEqual({
        listening: false,
      });
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

  it('announces the listener only while it runs, and not when told to stay unlisted', async () => {
    const advertiser = {
      advertise: vi.fn<LanAdvertiser['advertise']>(async () => {}),
      stop: vi.fn<LanAdvertiser['stop']>(async () => {}),
    };
    const controller = createRemoteServingController({
      cert: await generateLoopbackCert(),
      deviceFingerprint: 'ab'.repeat(32),
      fetch: () => () => Promise.resolve(new Response('ok')),
      advertiser,
    });
    try {
      const started = await controller.reconfigure({ enabled: true, port: 0 });
      expect(advertiser.advertise).toHaveBeenLastCalledWith(
        expect.objectContaining({ port: started.port, fingerprint: 'ab'.repeat(32) }),
      );

      advertiser.advertise.mockClear();
      advertiser.stop.mockClear();
      await controller.reconfigure({ enabled: true, port: started.port, advertise: false });
      expect(advertiser.advertise).not.toHaveBeenCalled();
      expect(advertiser.stop).toHaveBeenCalled();
      expect(controller.status()).toEqual(started);

      advertiser.stop.mockClear();
      await controller.reconfigure({ enabled: false });
      expect(advertiser.stop).toHaveBeenCalled();
    } finally {
      await controller.stop();
    }
  });

  it('has nothing to announce when bound to loopback', async () => {
    const advertiser = {
      advertise: vi.fn<LanAdvertiser['advertise']>(async () => {}),
      stop: vi.fn<LanAdvertiser['stop']>(async () => {}),
    };
    const controller = createRemoteServingController({
      cert: await generateLoopbackCert(),
      deviceFingerprint: 'ab'.repeat(32),
      fetch: () => () => Promise.resolve(new Response('ok')),
      advertiser,
    });
    try {
      await controller.reconfigure({ enabled: true, bindAddress: '127.0.0.1', port: 0 });
      expect(advertiser.advertise).toHaveBeenLastCalledWith(
        expect.objectContaining({ addresses: [] }),
      );
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
