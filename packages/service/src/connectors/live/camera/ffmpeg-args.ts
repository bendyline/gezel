/**
 * ffmpeg argument lists for camera capture. Pure, so each platform's command
 * is pinned by a test. Never reuses the indexer's `SAFE_INPUT`, whose
 * `-protocol_whitelist file` is right for files on disk and wrong for a
 * device or a network stream.
 *
 * One process per physical camera, two outputs at the same rate so they pair
 * one-to-one:
 *  - `pipe:1` — 160x90 grayscale raw frames, the motion detector's diet;
 *  - `pipe:3` — MJPEG frames, long edge capped, for storage and review.
 * Pipes rather than files: nothing reaches disk unless the storage policy
 * keeps it, and an ffmpeg orphaned by a crashed daemon dies on its next write
 * instead of holding the webcam.
 */

import type { CameraBackend } from '@bendyline/gezel';

export const ANALYSIS_WIDTH = 160;
export const ANALYSIS_HEIGHT = 90;
export const ANALYSIS_FRAME_BYTES = ANALYSIS_WIDTH * ANALYSIS_HEIGHT;
/** Frames per second the camera pipeline sees. */
export const CAPTURE_FPS = 2;
export const JPEG_MAX_EDGE = 1280;

export interface CaptureInput {
  backend: CameraBackend;
  /** Device handle as discovery returned it. */
  device: string;
  /** Ask the camera for this mode; omitted on the retry after a refusal. */
  videoSize?: string;
}

/** The input half: how to open the device. */
export function deviceInputArgs(input: CaptureInput): string[] {
  const size = input.videoSize ? ['-video_size', input.videoSize] : [];
  switch (input.backend) {
    case 'dshow':
      // A large real-time buffer keeps a slow consumer from dropping the
      // device; `video=` takes a friendly name or an "Alternative name".
      return ['-f', 'dshow', '-rtbufsize', '64M', ...size, '-i', `video=${input.device}`];
    case 'avfoundation':
      // avfoundation refuses its default 29.97 on most cameras; 30 is
      // accepted everywhere. `:none` opens video without audio.
      return ['-f', 'avfoundation', '-framerate', '30', ...size, '-i', `${input.device}:none`];
    case 'v4l2':
      return ['-f', 'v4l2', ...size, '-i', input.device];
    case 'simulator':
      throw new Error('the simulated camera does not run ffmpeg');
  }
}

/** A filter-graph label that names this process, so a stray ffmpeg can be traced back. */
export function captureMarker(homeHash: string, bindingKey: string): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
  return `gz_${safe(homeHash)}_${safe(bindingKey)}`;
}

export function captureArgs(
  input: CaptureInput,
  opts: { marker: string; fps?: number } = { marker: 'gz_capture' },
): string[] {
  const fps = opts.fps ?? CAPTURE_FPS;
  const graph = [
    `[0:v]fps=${fps},split=2[a][b]`,
    `[a]scale=${ANALYSIS_WIDTH}:${ANALYSIS_HEIGHT},format=gray[${opts.marker}]`,
    `[b]scale='min(${JPEG_MAX_EDGE},iw)':-2[gz_jpeg]`,
  ].join(';');
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    ...deviceInputArgs(input),
    '-filter_complex',
    graph,
    '-map',
    `[${opts.marker}]`,
    '-f',
    'rawvideo',
    '-pix_fmt',
    'gray',
    'pipe:1',
    '-map',
    '[gz_jpeg]',
    '-f',
    'image2pipe',
    '-c:v',
    'mjpeg',
    '-q:v',
    '5',
    'pipe:3',
  ];
}

/** `ffmpeg -list_devices` for a platform, or null where discovery reads the filesystem. */
export function listDevicesArgs(platform: NodeJS.Platform): string[] | null {
  if (platform === 'win32') {
    return ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'];
  }
  if (platform === 'darwin') {
    return ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''];
  }
  return null;
}

export function backendFor(platform: NodeJS.Platform): CameraBackend {
  if (platform === 'win32') return 'dshow';
  if (platform === 'darwin') return 'avfoundation';
  return 'v4l2';
}
