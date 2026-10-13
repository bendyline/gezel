import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getCACertificates } from 'node:tls';

/** Node and native CLI transports must trust the same fixture CA. Keep the
 * normal roots and explicitly configured bundles rather than replacing trust
 * with the fixture certificate or disabling certificate verification. */
export async function writeMockTrustBundle(
  runDir: string,
  fixtureCa: string,
  env: NodeJS.ProcessEnv,
): Promise<{ NODE_EXTRA_CA_CERTS: string; SSL_CERT_FILE: string }> {
  const certificates = [...getCACertificates('default')];
  for (const path of new Set([env.NODE_EXTRA_CA_CERTS, env.SSL_CERT_FILE].filter(Boolean))) {
    certificates.push(await readFile(path!, 'utf8'));
  }
  certificates.push(fixtureCa);
  const path = join(runDir, 'mock-trust.pem');
  await writeFile(path, `${[...new Set(certificates)].join('\n')}\n`, 'utf8');
  return { NODE_EXTRA_CA_CERTS: path, SSL_CERT_FILE: path };
}
