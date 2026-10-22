/**
 * Which cameras this computer has. Asks ffmpeg on Windows and macOS and reads
 * `/dev` on Linux; the simulated camera joins the list when
 * `GEZEL_CAMERA_SIMULATOR` is set. Never throws — an empty list carries a
 * plain-language `error` the setup panel shows instead.
 */

import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import type { CameraDevice, CameraDiscoveryResponse } from '@bendyline/gezel';
import { locateFfmpeg } from '../../../media/ffmpeg.js';
import {
  parseAvfoundationDevices,
  parseDshowDevices,
  v4lDevicesFromListing,
} from './discovery-parse.js';
import { listDevicesArgs } from './ffmpeg-args.js';
import { SIMULATED_CAMERA, cameraSimulatorEnabled } from './simulator.js';

const LIST_TIMEOUT_MS = 10_000;

export const FFMPEG_MISSING_TEXT =
  'Camera capture needs ffmpeg, which is not installed. Install it (Windows: `winget install ffmpeg`; macOS: `brew install ffmpeg`; Linux: your package manager), then check again.';

function runForStderr(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    // -list_devices always "fails" (there is no input to open); the listing
    // is on stderr either way.
    execFile(cmd, args, { timeout: LIST_TIMEOUT_MS, windowsHide: true }, (_err, _stdout, stderr) =>
      resolve(String(stderr ?? '')),
    );
  });
}

async function linuxDevices(): Promise<CameraDevice[]> {
  const byId = await readdir('/dev/v4l/by-id').catch(() => [] as string[]);
  const nodes: { node: string; name?: string }[] = [];
  if (byId.length === 0) {
    const entries = await readdir('/sys/class/video4linux').catch(() => [] as string[]);
    for (const entry of entries.sort()) {
      const name = await readFile(`/sys/class/video4linux/${entry}/name`, 'utf8').catch(() => '');
      // A webcam registers a metadata node beside its capture node; the
      // capture node's `index` is 0.
      const index = await readFile(`/sys/class/video4linux/${entry}/index`, 'utf8').catch(
        () => '0',
      );
      if (index.trim() !== '0') continue;
      nodes.push({ node: `/dev/${entry}`, name });
    }
  }
  return v4lDevicesFromListing({ byId, nodes });
}

export async function discoverCameras(
  platform: NodeJS.Platform = process.platform,
): Promise<CameraDiscoveryResponse> {
  const extra = cameraSimulatorEnabled() ? [SIMULATED_CAMERA] : [];
  const ffmpeg = await locateFfmpeg();
  if (!ffmpeg) {
    return { ffmpeg: { available: false }, cameras: extra, error: FFMPEG_MISSING_TEXT };
  }
  let cameras: CameraDevice[] = [];
  try {
    const args = listDevicesArgs(platform);
    if (args) {
      const stderr = await runForStderr(ffmpeg.path, args);
      cameras = platform === 'win32' ? parseDshowDevices(stderr) : parseAvfoundationDevices(stderr);
    } else {
      cameras = await linuxDevices();
    }
  } catch {
    cameras = [];
  }
  return {
    ffmpeg: { available: true, path: ffmpeg.path },
    cameras: [...cameras, ...extra],
    ...(cameras.length === 0 && extra.length === 0
      ? { error: 'No camera was found. Plug one in, or check that no privacy setting hides it.' }
      : {}),
  };
}
