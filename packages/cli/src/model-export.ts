import { randomUUID } from 'node:crypto';
import { rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import type { GezmodelEngine } from '@bendyline/gezel';
import {
  type GezelClient,
  modelBytesFromResponse,
  portableGezmodelFilename,
  verifyModelBundleArchive,
  writeModelBundleResponse,
} from '@bendyline/gezel-client/node';
import { CliError } from './connection.js';
import { formatGb, pullChatModel } from './model-pull.js';

/**
 * `gezel model export` — turn a gilde catalog id into a portable `.gezmodel`.
 *
 * The catalog entry names a Hugging Face repo, so the download half of this
 * is `gezel model pull` and the export half is the same service endpoint the
 * desktop save dialog uses. Doing both in one command is the point: the id a
 * person has (`gemma4-31b-q4`) is a catalog token, not a file, and the two
 * steps in sequence are what turn it into something they can hand to another
 * machine.
 *
 * The daemon can only export a model it already has on disk, so a missing
 * model is pulled first rather than reported as an error.
 */

export type ModelExportClient = Pick<
  GezelClient,
  | 'exportModelBundle'
  | 'installDs4Model'
  | 'installLlamaCppModel'
  | 'installMlxModel'
  | 'listDs4Models'
  | 'listLlamaCppModels'
  | 'listMlxModels'
>;

export interface ModelExportOutput {
  /** Progress lines; callers may preserve carriage returns for in-place updates. */
  writeProgress(text: string): void;
}

export interface ModelExportOptions {
  engine: GezmodelEngine;
  /** Destination file or directory. Defaults to the portable name in `cwd`. */
  destination?: string;
  cwd: string;
  /** Overwrite an existing destination file. */
  force?: boolean;
  /** Fail instead of downloading a model that is not installed yet. */
  skipPull?: boolean;
  output: ModelExportOutput;
  signal?: AbortSignal;
}

export interface ModelExportResult {
  path: string;
  bytesWritten: number;
  pulled: boolean;
}

/**
 * Resolve the file to write. A bare directory (existing, or written with a
 * trailing separator) takes the portable name so `--out ./dist/` behaves the
 * way every other CLI's `-o` does, and a name without the extension gets one
 * — a `.gezmodel` file the OS does not recognize is not a portable bundle.
 */
export async function resolveExportPath(
  id: string,
  destination: string | undefined,
  cwd: string,
): Promise<string> {
  const fallback = portableGezmodelFilename(id);
  if (!destination) return resolve(cwd, fallback);

  const full = isAbsolute(destination) ? resolve(destination) : resolve(cwd, destination);
  const endsWithSeparator = /[/\\]$/.test(destination);
  const isDirectory = endsWithSeparator || (await isExistingDirectory(full));
  if (isDirectory) return resolve(full, fallback);
  return full.toLowerCase().endsWith('.gezmodel') ? full : `${full}.gezmodel`;
}

async function isExistingDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isExistingFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isInstalled(
  client: ModelExportClient,
  engine: GezmodelEngine,
  id: string,
): Promise<boolean> {
  const { models } =
    engine === 'mlx'
      ? await client.listMlxModels()
      : engine === 'ds4'
        ? await client.listDs4Models()
        : await client.listLlamaCppModels();
  return models.some((model) => model.id === id);
}

/** Download the catalog model into the connected daemon's home. */
function pull(
  client: ModelExportClient,
  engine: GezmodelEngine,
  id: string,
  output: ModelExportOutput,
): Promise<void> {
  return pullChatModel(client, engine, id, (text) => output.writeProgress(text));
}

export async function exportModelToFile(
  client: ModelExportClient,
  id: string,
  options: ModelExportOptions,
): Promise<ModelExportResult> {
  const { engine, cwd, output, signal } = options;
  const target = await resolveExportPath(id, options.destination, cwd);

  if (!options.force && (await isExistingFile(target))) {
    throw new CliError(`${target} already exists. Pass --force to overwrite it.`);
  }
  if (!(await isExistingDirectory(dirname(target)))) {
    throw new CliError(`${dirname(target)} does not exist.`);
  }

  let pulled = false;
  if (!(await isInstalled(client, engine, id))) {
    if (options.skipPull) {
      throw new CliError(
        `model "${id}" is not installed for ${engine}. Run \`gezel model pull ${id}\` first, or drop --no-pull.`,
      );
    }
    await pull(client, engine, id, output);
    pulled = true;
  }

  const name = basename(target);
  // Write beside the destination so the rename that publishes it stays on one
  // filesystem, and so an interrupted 80 GB export never looks like a finished
  // one. Everything below cleans this up on any failure.
  const partial = `${target}.partial-${randomUUID()}`;
  try {
    output.writeProgress(`preparing ${name}\n`);
    const response = await client.exportModelBundle(engine, id, signal);
    const modelBytes = modelBytesFromResponse(response);

    const bytesWritten = await writeModelBundleResponse(
      response,
      partial,
      ({ bytesCompleted, bytesTotal }) => {
        output.writeProgress(`\rwriting ${name}: ${progressText(bytesCompleted, bytesTotal)}`);
      },
      signal,
    );
    output.writeProgress(`\rwriting ${name}: ${progressText(bytesWritten, modelBytes)}\n`);

    await verifyModelBundleArchive(
      partial,
      ({ bytesCompleted, bytesTotal }) => {
        output.writeProgress(`\rverifying ${name}: ${progressText(bytesCompleted, bytesTotal)}`);
      },
      signal,
    );
    output.writeProgress(`\rverifying ${name}: done${' '.repeat(32)}\n`);

    signal?.throwIfAborted();
    await publish(partial, target);
    return { path: target, bytesWritten, pulled };
  } catch (error) {
    await rm(partial, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Swap the verified file into place, keeping any existing export recoverable
 * until the replacement lands. Renaming a backup is cheap even at 80 GB.
 */
async function publish(partial: string, target: string): Promise<void> {
  const backup = `${target}.backup-${randomUUID()}`;
  const backedUp = await isExistingFile(target);
  if (backedUp) await rename(target, backup);
  try {
    await rename(partial, target);
  } catch (error) {
    if (backedUp) await rename(backup, target).catch(() => {});
    throw error;
  }
  if (backedUp) await rm(backup, { force: true }).catch(() => {});
}

function progressText(bytesCompleted: number, bytesTotal: number | undefined): string {
  if (!bytesTotal) return `${formatGb(bytesCompleted)} GB`;
  const pct = Math.floor((bytesCompleted / bytesTotal) * 100);
  return `${String(pct).padStart(3)}%  ${formatGb(bytesCompleted)}/${formatGb(bytesTotal)} GB`;
}
