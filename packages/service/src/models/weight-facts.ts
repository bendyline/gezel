/**
 * Weight facts for media-model memory pricing: each weight file's size and
 * how many elements it stores at every precision. Core `media-memory.ts`
 * turns them into a requirement.
 *
 * Two sources that must agree. A catalog entry carries the facts as
 * `tensors` beside each file's sha256, written by gilde's `pin-weight-tensors`
 * tool when the model was authored; the launch path reads the same facts
 * from the header of the file on disk. Files are pinned by sha256, so both
 * describe the same bytes. Nothing here touches the network: an entry
 * without the facts is priced by its plausible range instead.
 */

import { open, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ImageModelManifest,
  type MediaWeightFile,
  type VideoModelManifest,
  type WeightTensors,
  tallySafetensorsHeader,
  weightFileFormat,
} from '@bendyline/gezel';

/** A header larger than this is not a safetensors header. */
const MAX_HEADER_BYTES = 100 * 1024 * 1024;

/** Length of the JSON header from a safetensors file's first 8 bytes, or null when implausible. */
export function safetensorsHeaderLength(prefix: Uint8Array, fileBytes: number): number | null {
  if (prefix.byteLength < 8) return null;
  const view = new DataView(prefix.buffer, prefix.byteOffset, 8);
  const length = Number(view.getBigUint64(0, true));
  if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_HEADER_BYTES) return null;
  if (length + 8 > fileBytes) return null;
  return length;
}

/** The `tensors` facts of a safetensors file on disk; undefined when it cannot be read as one. */
export async function readLocalWeightTensors(path: string): Promise<WeightTensors | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, 'r');
    const size = (await handle.stat()).size;
    const prefix = Buffer.alloc(8);
    const { bytesRead } = await handle.read(prefix, 0, 8, 0);
    const length = safetensorsHeaderLength(prefix.subarray(0, bytesRead), size);
    if (length === null) return undefined;
    const header = Buffer.alloc(length);
    await handle.read(header, 0, length, 8);
    return tallySafetensorsHeader(JSON.parse(header.toString('utf8')));
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

function catalogFile(
  component: string,
  fileName: string,
  sizeBytes: number,
  tensors: WeightTensors | undefined,
): MediaWeightFile | null {
  const format = weightFileFormat(fileName);
  if (!format) return null;
  return { component, sizeBytes, format, ...(tensors ? { tensors } : {}) };
}

// ─ Video: diffusers trees ───────────────────────────────────────────

/** The diffusers component a repo-relative file belongs to: its top-level folder. */
function diffusersComponent(name: string): string {
  const slash = name.indexOf('/');
  return slash < 0 ? '' : name.slice(0, slash);
}

export function videoCatalogWeightFiles(manifest: VideoModelManifest): MediaWeightFile[] {
  return manifest.source.files.flatMap((file) => {
    const priced = catalogFile(
      diffusersComponent(file.name),
      file.name,
      file.sizeBytes,
      file.tensors,
    );
    return priced ? [priced] : [];
  });
}

/**
 * The weight files of an installed diffusers tree, headers read from disk.
 * diffusers loads only the shards a directory's index names, so an unsharded
 * duplicate beside them is never resident and is left out.
 */
export async function localDiffusersWeightFiles(modelDir: string): Promise<MediaWeightFile[]> {
  const out: MediaWeightFile[] = [];
  const walk = async (dir: string, component: string, depth: number): Promise<void> => {
    if (depth > 6) return;
    const entries = await readdir(dir, { withFileTypes: true });
    const indexed = await indexedShards(
      dir,
      entries.map((e) => e.name),
    );
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path, component || entry.name, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const format = weightFileFormat(entry.name);
      if (!format) continue;
      if (format === 'safetensors' && indexed && !indexed.has(entry.name)) continue;
      const sizeBytes = (await stat(path)).size;
      const tensors = format === 'safetensors' ? await readLocalWeightTensors(path) : undefined;
      out.push({ component, sizeBytes, format, ...(tensors ? { tensors } : {}) });
    }
  };
  await walk(modelDir, '', 0);
  return out;
}

async function indexedShards(dir: string, names: string[]): Promise<Set<string> | null> {
  const index = names.find((n) => n.endsWith('.safetensors.index.json'));
  if (!index) return null;
  try {
    const parsed = JSON.parse(await readFile(join(dir, index), 'utf8')) as {
      weight_map?: Record<string, string>;
    };
    const shards = new Set(Object.values(parsed.weight_map ?? {}));
    return shards.size > 0 ? shards : null;
  } catch {
    return null;
  }
}

// ─ Image: stable-diffusion.cpp files ────────────────────────────────

/** The sd-cpp component the main weights load as: the flag they ride on. */
export function sdCppMainComponent(weightsKind: 'checkpoint' | 'diffusion-model'): string {
  return weightsKind === 'diffusion-model' ? 'diffusion_model' : 'model';
}

function urlFileName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
  } catch {
    return '';
  }
}

export function imageCatalogWeightFiles(manifest: ImageModelManifest): MediaWeightFile[] {
  const entries = [
    {
      component: sdCppMainComponent(manifest.weightsKind),
      url: manifest.downloadUrl,
      sizeBytes: manifest.approxSizeBytes,
      tensors: manifest.tensors,
    },
    ...manifest.auxiliaryFiles.map((aux) => ({
      component: aux.role,
      url: aux.downloadUrl,
      sizeBytes: aux.approxSizeBytes,
      tensors: aux.tensors,
    })),
  ];
  return entries.flatMap((e) => {
    const priced = catalogFile(e.component, urlFileName(e.url), e.sizeBytes, e.tensors);
    return priced ? [priced] : [];
  });
}

/** The weight files of an installed sd-cpp model, headers read from disk. */
export async function localSdCppWeightFiles(model: {
  weightsPath: string;
  weightsKind: 'checkpoint' | 'diffusion-model';
  auxiliaryFiles: ReadonlyArray<{ role: string; path: string }>;
}): Promise<MediaWeightFile[]> {
  const entries = [
    { component: sdCppMainComponent(model.weightsKind), path: model.weightsPath },
    ...model.auxiliaryFiles.map((a) => ({ component: a.role, path: a.path })),
  ];
  const out: MediaWeightFile[] = [];
  for (const entry of entries) {
    const format = weightFileFormat(entry.path);
    if (!format) continue;
    let sizeBytes: number;
    try {
      sizeBytes = (await stat(entry.path)).size;
    } catch {
      continue;
    }
    const tensors = format === 'safetensors' ? await readLocalWeightTensors(entry.path) : undefined;
    out.push({ component: entry.component, sizeBytes, format, ...(tensors ? { tensors } : {}) });
  }
  return out;
}
