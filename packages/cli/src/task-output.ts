import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { GezelClient } from '@bendyline/gezel-client';
import { CliError } from './connection.js';

type ArtifactClient = Pick<GezelClient, 'listProjectArtifacts' | 'fetchProjectArtifactBlob'>;

/**
 * Copy what a finished task made into a folder the person chose:
 * `gezel do <book> --out ./gezel-out`. The task's own folder in the
 * artifacts drawer (`artifacts/tasks/<num>/`) is the work; its `inputs/`
 * are the person's files coming back, so they stay out. Reads go through
 * the API, so it works against a daemon on another filesystem — a
 * container — exactly as against a local one.
 */
export async function copyTaskOutput(
  client: ArtifactClient,
  projectId: string,
  artifactDir: string,
  outDir: string,
): Promise<string[]> {
  const root = resolve(outDir);
  const listing = await client.listProjectArtifacts(projectId, artifactDir, true);
  const copied: string[] = [];
  for (const file of listing.files) {
    if (file.isDirectory) continue;
    const rel = relative(artifactDir, file.path).split(sep).join('/');
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) continue;
    if (rel === 'inputs' || rel.startsWith('inputs/')) continue;
    const target = join(root, rel);
    // A listing is the daemon's word; never write outside the folder asked for.
    if (relative(root, target).startsWith('..')) continue;
    const blob = await client.fetchProjectArtifactBlob(projectId, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(await blob.arrayBuffer()));
    copied.push(rel);
  }
  if (listing.truncated) {
    throw new CliError(
      `The task made more files than one listing returns; ${copied.length} were copied to ${root}. Open the rest from the task's folder in Gezel.`,
    );
  }
  return copied;
}
