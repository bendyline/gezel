import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCACertificates } from 'node:tls';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { writeMockTrustBundle } from './trust.ts';
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mock-trust-'));
});
afterEach(async () => {
  await rm(dir, { force: true, recursive: true });
});

it('shares the fixture CA with Node and native transports while preserving existing trust', async () => {
  const nodeCa = join(dir, 'node.pem');
  const nativeCa = join(dir, 'native.pem');
  await writeFile(nodeCa, 'existing Node CA');
  await writeFile(nativeCa, 'existing native CA');
  const env = await writeMockTrustBundle(dir, 'fixture CA', {
    NODE_EXTRA_CA_CERTS: nodeCa,
    SSL_CERT_FILE: nativeCa,
  });
  expect(env.NODE_EXTRA_CA_CERTS).toBe(env.SSL_CERT_FILE);
  const pem = await readFile(env.SSL_CERT_FILE, 'utf8');
  for (const ca of [
    ...getCACertificates('default'),
    'existing Node CA',
    'existing native CA',
    'fixture CA',
  ]) {
    expect(pem).toContain(ca);
  }
});

it('does not silently drop an unreadable configured trust bundle', async () => {
  await expect(
    writeMockTrustBundle(dir, 'fixture CA', {
      SSL_CERT_FILE: join(dir, 'missing.pem'),
    }),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});
