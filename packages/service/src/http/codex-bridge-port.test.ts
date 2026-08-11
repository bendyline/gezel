import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CODEX_BRIDGE_PORT_RANGE_END,
  CODEX_BRIDGE_PORT_RANGE_START,
  codexBridgePortForHome,
} from './codex-bridge-port.js';

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
      expect(port).toBeGreaterThanOrEqual(CODEX_BRIDGE_PORT_RANGE_START);
      expect(port).toBeLessThanOrEqual(CODEX_BRIDGE_PORT_RANGE_END);
      expect(port).toBeGreaterThan(1_023);
    }
  });
});
