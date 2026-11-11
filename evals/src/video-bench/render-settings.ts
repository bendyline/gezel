import { open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type MediaWeightFile,
  type WeightTensors,
  tallySafetensorsHeader,
  weightFileFormat,
} from '@bendyline/gezel';

/**
 * The sd.cpp render settings an engine read for a bench run: the install
 * record in the trial home, which the bench may have overridden
 * (`--sd-cpp`) and which can differ from a catalog that moved on since the
 * model was cached. `undefined` when the record is missing or unreadable.
 */
export async function installedRenderSettings(
  manifestPath: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const installed = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      sdCpp?: Record<string, unknown>;
    };
    return installed.sdCpp;
  } catch {
    return undefined;
  }
}

/** Where a bench run's trial home keeps an sd.cpp video model's install record. */
export function trialInstallRecord(runDir: string, model: string): string {
  return join(runDir, 'homes', model, 'engines', 'sd-cpp-video', 'models', model, 'manifest.json');
}

/** What pricing reads of a run's install record: the model as the engine loaded it. */
export interface TrialInstall {
  family: string;
  architecture?: string;
  sdCpp?: Record<string, unknown>;
  guidanceScale?: number;
  defaultWidth?: number;
  defaultHeight?: number;
  defaultNumFrames?: number;
  components?: Array<{ role: string; file: string }>;
}

/**
 * A run's record of what each model's engine loaded, written beside its
 * calibration lines, so the trial home's copies of the weights can be
 * deleted without losing what the fixture prices the run from.
 */
export const TRIAL_WEIGHTS_FILE = 'trial-weights.json';

type TrialWeights = Record<string, { install: TrialInstall; files: MediaWeightFile[] }>;

async function readSnapshot(runDir: string): Promise<TrialWeights | undefined> {
  try {
    return JSON.parse(await readFile(join(runDir, TRIAL_WEIGHTS_FILE), 'utf8')) as TrialWeights;
  } catch {
    return undefined;
  }
}

export async function readTrialInstall(
  runDir: string,
  model: string,
): Promise<TrialInstall | undefined> {
  try {
    return JSON.parse(await readFile(trialInstallRecord(runDir, model), 'utf8')) as TrialInstall;
  } catch {
    return (await readSnapshot(runDir))?.[model]?.install;
  }
}

/**
 * Writes the run's record of every sd.cpp model in its trial homes (see
 * {@link TRIAL_WEIGHTS_FILE}), keeping models an earlier record holds whose
 * weights are gone. Returns the models recorded.
 */
export async function snapshotTrialWeights(runDir: string): Promise<string[]> {
  const record: TrialWeights = { ...((await readSnapshot(runDir)) ?? {}) };
  const models = await readdir(join(runDir, 'homes')).catch(() => [] as string[]);
  for (const model of models) {
    const install = await readTrialInstall(runDir, model);
    const files = await trialWeightFiles(runDir, model);
    if (install && files) record[model] = { install, files };
  }
  await writeFile(join(runDir, TRIAL_WEIGHTS_FILE), `${JSON.stringify(record, null, 2)}\n`);
  return Object.keys(record);
}

/**
 * The weight files a run's engine loaded, read from the trial home: each
 * component's size on disk and, for safetensors, its tensors; or, once the
 * trial home's weights are deleted, from the run's record of them. A catalog
 * entry can change or go away after a run; these are what the clip was
 * measured on.
 */
export async function trialWeightFiles(
  runDir: string,
  model: string,
): Promise<MediaWeightFile[] | undefined> {
  const install = await readTrialInstall(runDir, model);
  if (!install?.components?.length) return undefined;
  const dir = join(runDir, 'homes', model, 'engines', 'sd-cpp-video', 'models', model);
  const onDisk = await stat(join(dir, install.components[0]?.file ?? '')).catch(() => undefined);
  if (!onDisk) return (await readSnapshot(runDir))?.[model]?.files;
  const files: MediaWeightFile[] = [];
  for (const { role, file } of install.components) {
    const path = join(dir, file);
    const format = weightFileFormat(path) ?? 'opaque';
    const tensors = format === 'safetensors' ? await readTensors(path) : undefined;
    files.push({
      component: role,
      sizeBytes: (await stat(path)).size,
      format,
      ...(tensors ? { tensors } : {}),
    });
  }
  return files;
}

async function readTensors(path: string): Promise<WeightTensors | undefined> {
  const handle = await open(path, 'r');
  try {
    const prefix = Buffer.alloc(8);
    await handle.read(prefix, 0, 8, 0);
    const length = Number(prefix.readBigUInt64LE(0));
    const header = Buffer.alloc(length);
    await handle.read(header, 0, length, 8);
    return tallySafetensorsHeader(JSON.parse(header.toString('utf8')));
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}
