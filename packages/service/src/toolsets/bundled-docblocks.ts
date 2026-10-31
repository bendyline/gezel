/**
 * DocBlocks ships with the product daemon as an exact-pinned dependency.
 * Resolve its published CLI without loading it in-process, then expose it as
 * an immutable system toolset. No catalog download or user installation is
 * needed, including on first launch and offline. ChatManager still supplies
 * project-scoped filesystem grants and applies craftbook step restrictions.
 * Related: product-service.ts, fs/store.ts, chat/manager.ts, toolset-trust.ts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { type InstalledToolset, isExpectedBinaryDocumentDeliverablePath } from '@bendyline/gezel';

const require = createRequire(import.meta.url);
export const BUNDLED_DOCBLOCKS_TOOLSET_ID = 'docblocks';
const VERSION = '2.7.5';
// SHA-256 of this exact published package, kept with the service dependency pin.
const SHA256 = 'd51a9db085298eb6ecb39f8de8cf1032497a86f7420c0650ec00006c285744f8';

export function bundledDocblocksToolset(): InstalledToolset {
  const packageFile = require.resolve('@bendyline/docblocks-cli/package.json');
  const installPath = dirname(packageFile);
  const { version } = JSON.parse(readFileSync(packageFile, 'utf8')) as { version: string };
  if (version !== VERSION || !existsSync(join(installPath, 'dist/bin.js'))) {
    throw new Error('The bundled DocBlocks runtime is incomplete. Reinstall or rebuild Gezel.');
  }
  return {
    toolsetId: BUNDLED_DOCBLOCKS_TOOLSET_ID,
    sourceId: 'bundled',
    version,
    installedAt: '2026-10-21T00:00:00.000Z',
    installPath,
    runtime: {
      kind: 'npm-package',
      package: '@bendyline/docblocks-cli',
      version,
      sha256: SHA256,
      entry: 'dist/bin.js',
      args: ['mcp'],
      envHints: [],
    },
  };
}

/**
 * A message that names an Office file ("bring `source/brand.pptx` in line",
 * "fix the table in report.docx") asks for document work whether or not a
 * craftbook runs it. Without this a designer asked to restyle a deck from a
 * brand deck had no `infer_theme_from_file` (docblocks-theme-roundtrip, 0 of 6
 * trials, 2026-10-29). PDFs are left out: reading one is `read_doc_as_markdown`'s
 * job and making one is a craftbook's, neither worth 14,000 prompt tokens.
 */
const OFFICE_DOCUMENT_NAME_RE = /[\w-]\.(?:pptx|docx|xlsx)\b/i;

/** Whether the person's side of a thread, the message being sent included, names an Office file. */
export function threadNamesOfficeDocument(
  messages: ReadonlyArray<{ role: string; content: string }>,
  pendingUserText?: string,
): boolean {
  if (pendingUserText && OFFICE_DOCUMENT_NAME_RE.test(pendingUserText)) return true;
  return messages.some(
    (message) => message.role === 'user' && OFFICE_DOCUMENT_NAME_RE.test(message.content),
  );
}

/**
 * Whether a session gets the bundled DocBlocks that nobody installed for it.
 * Its 19 tool schemas cost about 14,000 prompt tokens and a Node process, and
 * in 1.26299.99 every session paid that, the Meester's front door included,
 * whose first turn grew from 22.7k to 37.4k tokens. Only work that makes a
 * document needs it: a craftbook that declares DocBlocks (its steps that do
 * not make the file still drop it through `disallowToolsets`), a delegation
 * whose expected deliverable is a binary document, and a thread whose person
 * named an Office file. A copy
 * installed at gezel, shared or project scope joins every session there,
 * unless this one supersedes it (`Store.bundledToolsetSupersedes`), which
 * makes it this one.
 */
export function bundledDocblocksJoinsSession(session: {
  craftbookToolsetIds?: readonly string[];
  expectedDeliverablePath?: string;
  namesOfficeDocument?: boolean;
}): boolean {
  if (session.craftbookToolsetIds?.includes(BUNDLED_DOCBLOCKS_TOOLSET_ID)) return true;
  if (session.namesOfficeDocument) return true;
  const path = session.expectedDeliverablePath?.trim();
  return !!path && isExpectedBinaryDocumentDeliverablePath(path);
}
