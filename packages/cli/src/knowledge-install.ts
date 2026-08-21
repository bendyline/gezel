import { resolve } from 'node:path';
import type { KnowledgeInstallRequest } from '@bendyline/gezel';
import { CliError } from './connection.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

export function resolveKnowledgeInstallSource(
  source: string,
  expectedSha256?: string,
): KnowledgeInstallRequest['source'] {
  if (/^https?:\/\//i.test(source)) {
    if (!expectedSha256) {
      throw new CliError('URL installs require --sha256 <64-hex-digest>.');
    }
    if (!SHA256_PATTERN.test(expectedSha256)) {
      throw new CliError('--sha256 must be exactly 64 hexadecimal characters.');
    }
    return { kind: 'url', url: source, expectedSha256: expectedSha256.toLowerCase() };
  }

  if (expectedSha256) {
    throw new CliError('--sha256 is only valid for URL installs.');
  }
  return { kind: 'file', path: resolve(source) };
}
