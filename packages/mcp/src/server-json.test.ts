import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HARNESS_CLIENT_IDS } from '@bendyline/gezel';
import { describe, expect, it } from 'vitest';

/**
 * server.json is Gezel's entry in the official MCP Registry. The registry
 * refuses a publish whose name differs from the npm package's `mcpName`,
 * lists the server at the version written here, and shows the `--harness`
 * choices to people setting it up. These keep it true to this package.
 */
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(resolve(packageDir, 'package.json'), 'utf8'));
const server = JSON.parse(readFileSync(resolve(packageDir, 'server.json'), 'utf8'));
const own = server.packages.find(
  (entry: { registryType: string; identifier: string }) =>
    entry.registryType === 'npm' && entry.identifier === manifest.name,
);

describe('the MCP Registry entry', () => {
  it('carries the name the published package claims', () => {
    expect(manifest.mcpName).toBeTruthy();
    expect(server.name).toBe(manifest.mcpName);
  });

  it('names this package at this package’s version', () => {
    // scripts/sync-server-json.mjs moves both together at each npm release.
    expect(own).toBeDefined();
    expect(server.version).toBe(manifest.version);
    expect(own.version).toBe(manifest.version);
  });

  it('starts the coding-agent tools, for an app the code accepts', () => {
    const harness = own.packageArguments.find(
      (argument: { name?: string }) => argument.name === '--harness',
    );
    expect(harness).toMatchObject({ type: 'named', isRequired: true });
    expect([...harness.choices].sort()).toEqual([...HARNESS_CLIENT_IDS].sort());
  });

  it('keeps the description within the registry’s 100 characters', () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
  });
});
