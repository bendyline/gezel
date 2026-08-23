import { basename } from 'node:path';
import { formatDiffpackRef } from '@bendyline/gezel';
import yazl from 'yazl';
import { DiffpackNotFoundError } from '../../diffpack/manager.js';
import type { ServiceContext } from '../context.js';

/**
 * Bundle one sealed pack as a zip the user can carry out of gezel: every
 * per-file diff, the gezel's notes, the manifest, and an APPLY.md naming the
 * `git apply` line. The escape hatch that keeps the feature honest on a folder
 * gezel will never write to — and the answer for anyone who would rather read
 * the change in their own tools.
 *
 * Entry names are flattened basenames of paths the runtime minted, never
 * model input, so there is no traversal surface here; deletions ride in the
 * manifest and in APPLY.md rather than as empty files.
 */
export async function buildDiffpackZip(
  ctx: ServiceContext,
  projectId: string,
  packId: string,
): Promise<Buffer> {
  const pack = await ctx.diffpacks.get(projectId, packId);
  if (!pack) throw new DiffpackNotFoundError(packId);

  const zip = new yazl.ZipFile();
  const ref = formatDiffpackRef(packId);

  const notes = await ctx.store.readProjectArtifact(projectId, pack.notesPath).catch(() => null);
  if (notes) zip.addBuffer(Buffer.from(notes, 'utf8'), 'notes.md');

  const manifest = await ctx.store
    .readProjectArtifact(projectId, pack.manifestPath)
    .catch(() => null);
  if (manifest) zip.addBuffer(Buffer.from(manifest, 'utf8'), 'manifest.json');

  const patches: string[] = [];
  const deletions: string[] = [];
  for (const file of pack.files) {
    if (file.change === 'delete') {
      deletions.push(file.path);
      continue;
    }
    const diff = await ctx.store
      .readProjectArtifact(projectId, file.diffArtifact)
      .catch(() => null);
    if (diff === null) continue;
    const name = `patches/${basename(file.diffArtifact)}`;
    zip.addBuffer(Buffer.from(diff, 'utf8'), name);
    patches.push(name);
  }

  zip.addBuffer(
    Buffer.from(applyInstructions(ref, pack.title, patches, deletions), 'utf8'),
    'APPLY.md',
  );
  zip.end();

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function applyInstructions(
  ref: string,
  title: string,
  patches: string[],
  deletions: string[],
): string {
  const lines = [
    `# ${ref} — ${title}`,
    '',
    'A change set a gezel proposed. Nothing here has been applied.',
    '',
    '`notes.md` explains the reasoning. `manifest.json` lists every target with the',
    'sha256 each patch was written against — if a file has changed since, expect the',
    'matching patch to need a rebase.',
    '',
  ];
  if (patches.length > 0) {
    lines.push('## Apply the patches', '', 'From the root of your working copy:', '', '```sh');
    lines.push(`git apply ${patches.map((p) => `"${p}"`).join(' ')}`);
    lines.push('```', '', 'Without git, `patch -p1 < <file>` reads the same unified diffs.', '');
  }
  if (deletions.length > 0) {
    lines.push(
      '## Files proposed for deletion',
      '',
      'These carry no patch — a diff that strips every line leaves an empty file',
      'rather than removing it. Delete them yourself if you agree:',
      '',
      ...deletions.map((p) => `- \`${p}\``),
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}
