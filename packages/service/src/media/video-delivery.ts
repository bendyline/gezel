/**
 * Turn an engine's clip into what Gezel saves: the clip itself, an MP4 when
 * it can make one, and a poster frame.
 *
 * The diffusers engine already writes MP4 and a PNG poster. sd.cpp writes
 * WebM, which the app plays but PowerPoint, Keynote and many phones do not;
 * when the person has ffmpeg (media/ffmpeg.ts), the clip is also converted
 * to H.264 MP4 and that becomes the primary file, with the WebM kept beside
 * it. Without ffmpeg the WebM stays primary and its first frame, lifted out
 * of the container, is the poster.
 *
 * This runs in the daemon that saves the clip, never in a machine broker or
 * paired server, so only the computer the person is using needs ffmpeg.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type FfmpegInfo, locateFfmpeg } from './ffmpeg.js';
import { SAFE_INPUT, runFfmpeg } from './segment.js';
import { webmFirstFrameWebp, webmVideoInfo } from './webm.js';

export interface DeliveredFile {
  data: Buffer;
  mimeType: string;
  ext: string;
}

export interface DeliveredVideo {
  /** The file a person and a gezel use first. */
  primary: DeliveredFile;
  /** The same clip in another container, kept beside the primary. */
  alternates: DeliveredFile[];
  poster?: DeliveredFile;
  /** Plain sentences about what could not be made, for the settings notes. */
  notes: string[];
}

export interface VideoDeliveryOptions {
  /** Test seam: the ffmpeg to use, or null for none. */
  ffmpeg?: () => Promise<FfmpegInfo | null>;
  /** Test seam: run ffmpeg with these arguments. */
  run?: (ffmpeg: string, args: string[]) => Promise<void>;
}

/** H.264 encoders in the order tried; system ffmpeg builds differ in which they carry. */
const H264_ENCODERS: ReadonlyArray<{ name: string; args: string[] }> = [
  { name: 'libx264', args: ['-crf', '18', '-preset', 'medium'] },
  { name: 'h264_videotoolbox', args: ['-b:v', '8M'] },
  { name: 'libopenh264', args: ['-b:v', '8M'] },
];

const encoderCache = new Map<string, Promise<(typeof H264_ENCODERS)[number] | null>>();

async function h264EncoderFor(
  ffmpeg: string,
  run: (args: string[]) => Promise<Buffer>,
): Promise<(typeof H264_ENCODERS)[number] | null> {
  let cached = encoderCache.get(ffmpeg);
  if (!cached) {
    cached = run(['-hide_banner', '-encoders'])
      .then((out) => {
        const listed = out.toString('utf8');
        // Match the name column (` V....D libx264  ...`), not a description that mentions it.
        return (
          H264_ENCODERS.find((e) => new RegExp(`^\\s*V\\S{5}\\s+${e.name}\\s`, 'm').test(listed)) ??
          null
        );
      })
      .catch(() => null);
    encoderCache.set(ffmpeg, cached);
  }
  return cached;
}

const WEBM: Pick<DeliveredFile, 'mimeType' | 'ext'> = { mimeType: 'video/webm', ext: 'webm' };

export async function deliverVideo(
  clip: { video: Buffer; mimeType: string; poster?: Buffer },
  opts: VideoDeliveryOptions = {},
): Promise<DeliveredVideo> {
  if (!clip.mimeType.includes('webm')) {
    return {
      primary: { data: clip.video, mimeType: clip.mimeType, ext: 'mp4' },
      alternates: [],
      ...(clip.poster ? { poster: { data: clip.poster, mimeType: 'image/png', ext: 'png' } } : {}),
      notes: [],
    };
  }

  const webm: DeliveredFile = { data: clip.video, ...WEBM };
  const framePoster = (): DeliveredFile | undefined => {
    const webp = webmFirstFrameWebp(clip.video);
    return webp ? { data: webp, mimeType: 'image/webp', ext: 'webp' } : undefined;
  };
  const withoutMp4 = (note: string): DeliveredVideo => {
    const poster = framePoster();
    return { primary: webm, alternates: [], ...(poster ? { poster } : {}), notes: [note] };
  };

  const ffmpeg = await (opts.ffmpeg ?? locateFfmpeg)();
  if (!ffmpeg) {
    return withoutMp4(
      'Saved as WebM. Install ffmpeg to also get an MP4 that PowerPoint, Keynote and phones play.',
    );
  }
  const capture = (args: string[]) => runFfmpeg(ffmpeg.path, args, 1024 * 1024);
  const encoder = await h264EncoderFor(ffmpeg.path, capture);
  if (!encoder) {
    return withoutMp4('Saved as WebM: the ffmpeg on this computer has no H.264 encoder for MP4.');
  }

  const run =
    opts.run ??
    ((path: string, args: string[]) => runFfmpeg(path, args, 1024 * 1024).then(() => {}));
  const dir = await mkdtemp(join(tmpdir(), 'gezel-video-'));
  try {
    const input = join(dir, 'clip.webm');
    const mp4 = join(dir, 'clip.mp4');
    const png = join(dir, 'poster.png');
    await writeFile(input, clip.video);
    const audio = webmVideoInfo(clip.video)?.hasAudio === true;
    await run(ffmpeg.path, [
      ...SAFE_INPUT,
      '-y',
      '-i',
      input,
      '-c:v',
      encoder.name,
      ...encoder.args,
      '-pix_fmt',
      'yuv420p',
      ...(audio ? ['-c:a', 'aac', '-b:a', '192k'] : ['-an']),
      '-movflags',
      '+faststart',
      mp4,
    ]);
    const mp4Data = await readFile(mp4);
    let poster: DeliveredFile | undefined;
    try {
      await run(ffmpeg.path, [...SAFE_INPUT, '-y', '-i', input, '-frames:v', '1', png]);
      poster = { data: await readFile(png), mimeType: 'image/png', ext: 'png' };
    } catch {
      poster = framePoster();
    }
    return {
      primary: { data: mp4Data, mimeType: 'video/mp4', ext: 'mp4' },
      alternates: [webm],
      ...(poster ? { poster } : {}),
      notes: [],
    };
  } catch (err) {
    return withoutMp4(
      `Saved as WebM: converting to MP4 failed (${err instanceof Error ? err.message : String(err)}).`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
