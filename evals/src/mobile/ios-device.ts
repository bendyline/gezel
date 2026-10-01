import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const BUNDLE = 'com.bendyline.gezel.mobile';

/**
 * A physical iPhone or iPad is reached only through devicectl. Its app data
 * container is readable and writable for a development-signed build, with
 * paths relative to the container root (`Documents/…`, `Library/Caches/…`).
 */
export function iosContainerCopyArgs(
  direction: 'from' | 'to',
  device: string,
  local: string,
  remote: string,
): string[] {
  return [
    'devicectl',
    'device',
    'copy',
    direction,
    '--device',
    device,
    '--domain-type',
    'appDataContainer',
    '--domain-identifier',
    BUNDLE,
    '--source',
    direction === 'from' ? remote : local,
    '--destination',
    direction === 'from' ? local : remote,
    '--quiet',
  ];
}

export async function iosDeviceCopyFrom(
  device: string,
  remote: string,
  local: string,
  options: { signal?: AbortSignal; timeout?: number } = {},
): Promise<void> {
  await exec('xcrun', iosContainerCopyArgs('from', device, local, remote), {
    timeout: options.timeout ?? 30000,
    signal: options.signal,
  });
}

export async function iosDeviceCopyTo(
  device: string,
  local: string,
  remote: string,
  options: { signal?: AbortSignal; timeout?: number } = {},
): Promise<void> {
  await exec('xcrun', iosContainerCopyArgs('to', device, local, remote), {
    timeout: options.timeout ?? 30 * 60 * 1000,
    signal: options.signal,
  });
}

/** Reads one container file through a private temp copy, or null when absent. */
export async function readIosDeviceFile(
  device: string,
  remote: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const directory = await mkdtemp(join(tmpdir(), 'gezel-ios-device-'));
  try {
    const local = join(directory, 'file');
    await iosDeviceCopyFrom(device, remote, local, { signal, timeout: 10000 });
    return await readFile(local, 'utf8');
  } catch {
    return null;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Refuses anything but a connected physical device with Developer Mode on. */
export async function requireReadyIosDevice(device: string): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'gezel-ios-device-'));
  try {
    const json = join(directory, 'details.json');
    await exec(
      'xcrun',
      [
        'devicectl',
        'device',
        'info',
        'details',
        '--device',
        device,
        '--quiet',
        '--json-output',
        json,
      ],
      { timeout: 60000 },
    );
    const result = JSON.parse(await readFile(json, 'utf8')).result ?? {};
    if (result.hardwareProperties?.reality !== 'physical')
      throw new Error(
        `${device} is not a physical device; drop --physical-device for a simulator.`,
      );
    if (result.deviceProperties?.developerModeStatus !== 'enabled')
      throw new Error(`Enable Developer Mode on ${device} before a device eval.`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
