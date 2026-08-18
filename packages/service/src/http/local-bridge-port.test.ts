import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LOCAL_BRIDGE_PORT_RANGE_END,
  LOCAL_BRIDGE_PORT_RANGE_START,
  codexBridgePortForHome,
  opencodeBridgePortForHome,
  piBridgePortForHome,
  vscodeBridgePortForHome,
} from './local-bridge-port.js';

describe('codexBridgePortForHome', () => {
  it('is deterministic for the canonical Gezel home', () => {
    const home = resolve('test-homes', 'alice', '.gezel');

    expect(codexBridgePortForHome(home)).toBe(codexBridgePortForHome(home));
    expect(codexBridgePortForHome(join(home, 'nested', '..'))).toBe(codexBridgePortForHome(home));
  });

  it('selects different ports for different user homes', () => {
    const alice = codexBridgePortForHome(resolve('test-homes', 'alice', '.gezel'));
    const bob = codexBridgePortForHome(resolve('test-homes', 'bob', '.gezel'));

    expect(alice).not.toBe(bob);
  });

  it('always selects an unprivileged port inside the advertised range', () => {
    for (let index = 0; index < 1_000; index += 1) {
      const port = codexBridgePortForHome(resolve('test-homes', `user-${index}`, '.gezel'));
      expect(port).toBeGreaterThanOrEqual(LOCAL_BRIDGE_PORT_RANGE_START);
      expect(port).toBeLessThanOrEqual(LOCAL_BRIDGE_PORT_RANGE_END);
      expect(port).toBeGreaterThan(1_023);
    }
  });

  // Codex profiles already on user disks name the pre-salt port. Salting the
  // digest for later integrations must not relocate the one Codex published.
  it('still derives the pre-salt digest so published profiles keep working', () => {
    const home = resolve('test-homes', 'alice', '.gezel');
    const size = LOCAL_BRIDGE_PORT_RANGE_END - LOCAL_BRIDGE_PORT_RANGE_START + 1;
    const legacy =
      LOCAL_BRIDGE_PORT_RANGE_START +
      (createHash('sha256').update(home).digest().readUInt32BE(0) % size);

    expect(codexBridgePortForHome(home)).toBe(legacy);
  });
});

describe('opencodeBridgePortForHome', () => {
  it('is deterministic and stays inside the advertised range', () => {
    for (let index = 0; index < 1_000; index += 1) {
      const home = resolve('test-homes', `user-${index}`, '.gezel');
      const port = opencodeBridgePortForHome(home);

      expect(port).toBe(opencodeBridgePortForHome(home));
      expect(port).toBeGreaterThanOrEqual(LOCAL_BRIDGE_PORT_RANGE_START);
      expect(port).toBeLessThanOrEqual(LOCAL_BRIDGE_PORT_RANGE_END);
    }
  });

  it('never collides with the Codex bridge for the same home', () => {
    for (let index = 0; index < 5_000; index += 1) {
      const home = resolve('test-homes', `user-${index}`, '.gezel');

      expect(opencodeBridgePortForHome(home)).not.toBe(codexBridgePortForHome(home));
    }
  });

  it('selects different ports for different user homes', () => {
    const alice = opencodeBridgePortForHome(resolve('test-homes', 'alice', '.gezel'));
    const bob = opencodeBridgePortForHome(resolve('test-homes', 'bob', '.gezel'));

    expect(alice).not.toBe(bob);
  });
});

describe('piBridgePortForHome', () => {
  it('is deterministic and stays inside the advertised range', () => {
    for (let index = 0; index < 1_000; index += 1) {
      const home = resolve('test-homes', `user-${index}`, '.gezel');
      const port = piBridgePortForHome(home);

      expect(port).toBe(piBridgePortForHome(home));
      expect(port).toBeGreaterThanOrEqual(LOCAL_BRIDGE_PORT_RANGE_START);
      expect(port).toBeLessThanOrEqual(LOCAL_BRIDGE_PORT_RANGE_END);
    }
  });

  it('never collides with either older bridge for the same home', () => {
    // Three-way: stepping off a Codex collision must not land on OpenCode's
    // port, which a single `+1` nudge would eventually do.
    for (let index = 0; index < 5_000; index += 1) {
      const home = resolve('test-homes', `user-${index}`, '.gezel');
      const ports = new Set([
        codexBridgePortForHome(home),
        opencodeBridgePortForHome(home),
        piBridgePortForHome(home),
      ]);

      expect(ports.size).toBe(3);
    }
  });

  it('selects different ports for different user homes', () => {
    const alice = piBridgePortForHome(resolve('test-homes', 'alice', '.gezel'));
    const bob = piBridgePortForHome(resolve('test-homes', 'bob', '.gezel'));

    expect(alice).not.toBe(bob);
  });
});

describe('vscodeBridgePortForHome', () => {
  it('is deterministic and stays inside the advertised range', () => {
    for (let index = 0; index < 1_000; index += 1) {
      const home = resolve('test-homes', `user-${index}`, '.gezel');
      const port = vscodeBridgePortForHome(home);

      expect(port).toBe(vscodeBridgePortForHome(home));
      expect(port).toBeGreaterThanOrEqual(LOCAL_BRIDGE_PORT_RANGE_START);
      expect(port).toBeLessThanOrEqual(LOCAL_BRIDGE_PORT_RANGE_END);
    }
  });

  it('never collides with any older bridge for the same home', () => {
    const collisions: string[] = [];

    for (let index = 0; index < 5_000; index += 1) {
      const home = resolve('test-homes', `user-${index}`, '.gezel');
      const ports = [
        codexBridgePortForHome(home),
        opencodeBridgePortForHome(home),
        piBridgePortForHome(home),
        vscodeBridgePortForHome(home),
      ];

      if (new Set(ports).size !== ports.length) {
        collisions.push(`${home}: ${ports.join(', ')}`);
      }
    }

    expect(collisions).toEqual([]);
  }, 15_000);
});
