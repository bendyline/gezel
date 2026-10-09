/**
 * Cut an audio or video file into the windows a multimodal profile embeds,
 * with the system ffmpeg (media/ffmpeg.ts). Audio becomes mono PCM at the
 * profile's sample rate; video becomes frames at the profile's frame rate,
 * scaled by ffmpeg straight to the size the image processor would pick for
 * the per-frame token budget, so no frame is resized twice.
 *
 * Every input is untrusted: arguments are an array (no shell), ffmpeg reads
 * no stdin and only local files, each run has a hard timeout, and output is
 * bounded by the window cap before it is read.
 */

import { spawn } from 'node:child_process';
import type { KnowledgeEmbeddingProfile } from '@bendyline/gezel';
import { type RgbImage, gemmaVisionTargetSize } from '../memory/image-pixels.js';

/** Windows one file may produce: an hour of audio, or of video at 32 s per window. */
export const MAX_MEDIA_WINDOWS = 120;
const RUN_TIMEOUT_MS = 10 * 60_000;
const SAFE_INPUT = [
  '-nostdin',
  '-hide_banner',
  '-loglevel',
  'error',
  '-protocol_whitelist',
  'file',
];

export interface MediaWindow<T> {
  startMs: number;
  endMs: number;
  data: T;
}

/** Run ffmpeg, collecting stdout up to `maxBytes` (then stopping it). */
function runFfmpeg(ffmpeg: string, args: string[], maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = '';
    let truncated = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      if (truncated) return;
      const room = maxBytes - bytes;
      if (chunk.length >= room) {
        chunks.push(chunk.subarray(0, room));
        bytes = maxBytes;
        truncated = true;
        child.kill('SIGTERM');
        return;
      }
      chunks.push(chunk);
      bytes += chunk.length;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4_000) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || truncated) resolve(Buffer.concat(chunks));
      else
        reject(
          new Error(`ffmpeg exited ${code}: ${stderr.trim().split('\n').slice(-2).join(' ')}`),
        );
    });
  });
}

/** A file's first video stream size and its duration, from ffmpeg's own banner. */
export async function probeMedia(
  ffmpeg: string,
  path: string,
): Promise<{ durationMs: number | null; width: number | null; height: number | null }> {
  const out = await new Promise<string>((resolve) => {
    const child = spawn(
      ffmpeg,
      ['-nostdin', '-hide_banner', '-protocol_whitelist', 'file', '-i', path],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      },
    );
    let text = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stderr.on('data', (chunk: Buffer) => {
      if (text.length < 20_000) text += chunk.toString('utf8');
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(text);
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(text);
    });
  });
  const duration = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(out);
  const durationMs = duration
    ? Math.round(
        (Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000,
      )
    : null;
  const size = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(out);
  return {
    durationMs,
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
  };
}

/**
 * Mono PCM windows of at most `media.audio.maxWindowMs`. A trailing window
 * shorter than one second is dropped — too little sound to describe.
 */
export async function decodeAudioWindows(
  ffmpeg: string,
  path: string,
  profile: KnowledgeEmbeddingProfile,
): Promise<Array<MediaWindow<Float32Array>>> {
  const audio = profile.media?.audio;
  if (!audio) throw new Error(`profile ${profile.id} describes no audio encoder`);
  const windowSamples = Math.floor((audio.maxWindowMs / 1000) * audio.sampleRate);
  const maxBytes = windowSamples * MAX_MEDIA_WINDOWS * 4;
  const pcm = await runFfmpeg(
    ffmpeg,
    [
      ...SAFE_INPUT,
      '-i',
      path,
      '-vn',
      '-ac',
      '1',
      '-ar',
      String(audio.sampleRate),
      '-f',
      'f32le',
      '-',
    ],
    maxBytes,
  );
  const samples = new Float32Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 4));
  const windows: Array<MediaWindow<Float32Array>> = [];
  for (let start = 0; start < samples.length; start += windowSamples) {
    const end = Math.min(samples.length, start + windowSamples);
    if (end - start < audio.sampleRate) break;
    windows.push({
      startMs: Math.round((start / audio.sampleRate) * 1000),
      endMs: Math.round((end / audio.sampleRate) * 1000),
      data: samples.slice(start, end),
    });
  }
  return windows;
}

/**
 * Frame windows: frames at `media.video.framesPerSecond`, grouped into
 * windows of `maxFrames`, each frame already at the image processor's size
 * for `tokenBudgetPerFrame`.
 */
export async function decodeVideoWindows(
  ffmpeg: string,
  path: string,
  profile: KnowledgeEmbeddingProfile,
): Promise<Array<MediaWindow<RgbImage[]>>> {
  const video = profile.media?.video;
  if (!video) throw new Error(`profile ${profile.id} describes no video settings`);
  const probe = await probeMedia(ffmpeg, path);
  if (!probe.width || !probe.height) throw new Error(`${path}: no video stream found`);
  const size = gemmaVisionTargetSize(probe.width, probe.height, video.tokenBudgetPerFrame);
  const frameBytes = size.width * size.height * 3;
  const maxFrames = video.maxFrames * MAX_MEDIA_WINDOWS;
  const raw = await runFfmpeg(
    ffmpeg,
    [
      ...SAFE_INPUT,
      '-i',
      path,
      '-an',
      '-vf',
      `fps=${video.framesPerSecond},scale=${size.width}:${size.height}:flags=bicubic`,
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      '-',
    ],
    frameBytes * maxFrames,
  );
  const frames: RgbImage[] = [];
  for (let off = 0; off + frameBytes <= raw.byteLength; off += frameBytes) {
    frames.push({
      data: new Uint8Array(raw.subarray(off, off + frameBytes)),
      width: size.width,
      height: size.height,
    });
  }
  const msPerFrame = 1000 / video.framesPerSecond;
  const windows: Array<MediaWindow<RgbImage[]>> = [];
  for (let i = 0; i < frames.length; i += video.maxFrames) {
    const group = frames.slice(i, i + video.maxFrames);
    windows.push({
      startMs: Math.round(i * msPerFrame),
      endMs: Math.round((i + group.length) * msPerFrame),
      data: group,
    });
  }
  return windows;
}
