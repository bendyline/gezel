import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { GezelClient } from '@bendyline/gezel-client/node';
import { CliError } from './connection.js';

/**
 * Resolve the text used to drive a generation command. Either the
 * variadic positional argument OR `--file <path>` (a UTF-8 text file)
 * must yield non-empty text — never both, never neither.
 */
export async function resolvePromptText(
  parts: string[] | undefined,
  file: string | undefined,
  label: string,
): Promise<string> {
  const inline = (parts ?? []).join(' ').trim();
  if (file) {
    if (inline) throw new CliError(`provide either ${label} text or --file, not both.`);
    let raw: string;
    try {
      raw = await readFile(resolve(file), 'utf8');
    } catch (err) {
      throw new CliError(`could not read --file "${file}": ${(err as Error).message}`);
    }
    const text = raw.trim();
    if (!text) throw new CliError(`--file "${file}" is empty.`);
    return text;
  }
  if (!inline) throw new CliError(`provide ${label} text as the argument, or --file <path>.`);
  return inline;
}

/** Parse an integer CLI option. Undefined passes through; NaN throws. */
export function intOpt(name: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n)) throw new CliError(`--${name} must be an integer (got "${v}").`);
  return n;
}

/** Parse a floating-point CLI option. Undefined passes through; NaN throws. */
export function floatOpt(name: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) throw new CliError(`--${name} must be a number (got "${v}").`);
  return n;
}

/**
 * Fetch a freshly-generated artifact's bytes from the daemon and write
 * them to a local file. Defaults the destination to the artifact's own
 * filename in the current directory. Returns the absolute path written.
 *
 * Pulling the bytes over HTTP (rather than reading the daemon's
 * on-disk artifact directly) keeps these commands working unchanged
 * against a remote daemon and covers every modality uniformly — image
 * and audio could come back inline, but video's inline payload is only
 * a poster frame, so a single artifact fetch is the one path that fits
 * all three.
 */
export async function saveArtifact(
  client: GezelClient,
  projectId: string,
  artifactPath: string,
  output: string | undefined,
): Promise<string> {
  const rel = artifactPath.replace(/^artifacts\//, '');
  const blob = await client.fetchProjectArtifactBlob(projectId, rel);
  const bytes = Buffer.from(await blob.arrayBuffer());
  const dest = output ? resolve(output) : resolve(process.cwd(), basename(artifactPath));
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, bytes);
  return dest;
}
