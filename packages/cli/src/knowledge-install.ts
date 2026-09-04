import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { KnowledgeInstallRequest } from '@bendyline/gezel';
import { KNOWLEDGE_ID_PATTERN } from '@bendyline/gezel';
import { CliError } from './connection.js';

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

export interface KnowledgeInstallSourceOptions {
  /** Catalog ids only: the version to install (default: the newest). */
  version?: string;
  /** Catalog ids only: keep the bytes private even when a machine-shared store exists. */
  privatePlacement?: boolean;
}

/**
 * Turn the CLI's one positional argument into an install source. A URL is a
 * URL; a path that exists, carries a directory separator, or ends in `.gezk`
 * is a file; anything else that reads as a catalog id is a gilde entry.
 */
export function resolveKnowledgeInstallSource(
  source: string,
  expectedSha256?: string,
  opts: KnowledgeInstallSourceOptions = {},
): KnowledgeInstallRequest['source'] {
  if (/^https?:\/\//i.test(source)) {
    if (expectedSha256 && !SHA256_PATTERN.test(expectedSha256)) {
      throw new CliError('--sha256 must be exactly 64 hexadecimal characters.');
    }
    assertCatalogOnlyOptions(opts, 'URL');
    return {
      kind: 'url',
      url: source,
      ...(expectedSha256 ? { expectedSha256: expectedSha256.toLowerCase() } : {}),
    };
  }

  if (expectedSha256) {
    throw new CliError('--sha256 is only valid for URL installs.');
  }
  if (looksLikeCatalogId(source)) {
    return {
      kind: 'catalog',
      id: source,
      ...(opts.version ? { version: opts.version } : {}),
      ...(opts.privatePlacement ? { placement: 'user' as const } : {}),
    };
  }
  assertCatalogOnlyOptions(opts, 'file');
  return { kind: 'file', path: resolve(source) };
}

function looksLikeCatalogId(source: string): boolean {
  if (source.includes('/') || source.includes('\\') || source.endsWith('.gezk')) return false;
  if (!KNOWLEDGE_ID_PATTERN.test(source)) return false;
  return !existsSync(source);
}

function assertCatalogOnlyOptions(opts: KnowledgeInstallSourceOptions, kind: string): void {
  if (opts.version)
    throw new CliError(`--version is only valid for catalog ids, not ${kind} installs.`);
  if (opts.privatePlacement) {
    throw new CliError(`--private is only valid for catalog ids, not ${kind} installs.`);
  }
}
