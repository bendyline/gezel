import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { locateFfmpeg } from '../../../media/ffmpeg.js';
import {
  type CameraFrame,
  FfmpegFrameSource,
  JpegStreamSplitter,
  RawFrameSlicer,
} from './capture-process.js';
import {
  classifyCaptureError,
  parseAvfoundationDevices,
  parseDshowDevices,
  v4lDevicesFromListing,
} from './discovery-parse.js';
import { ANALYSIS_FRAME_BYTES, captureArgs } from './ffmpeg-args.js';

// Real output: ffmpeg 8.1 (gyan build) on Windows 11.
const DSHOW_NEW = `[in#0 @ 00000207db511c00] "Razer Kiyo Pro Ultra" (video)
[in#0 @ 00000207db511c00]   Alternative name "@device_pnp_\\\\?\\usb#vid_1532&pid_0e08&mi_00#a&2f4bfbd3&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global"
[in#0 @ 00000207db511c00] "Microphone (Shure MV7+)" (audio)
[in#0 @ 00000207db511c00]   Alternative name "@device_cm_{33D9A762-90C8-11D0-BD43-00A0C911CE86}\\wave_{62BE8CF6-ADCD-47C8-9490-FDE2FEEAB396}"
Error opening input file dummy.`;

// ffmpeg 5 and earlier: section headers, no type tags.
const DSHOW_OLD = `[dshow @ 000001] DirectShow video devices (some may be both video and audio devices)
[dshow @ 000001]  "Integrated Camera"
[dshow @ 000001]     Alternative name "@device_pnp_\\\\?\\usb#vid_04f2&pid_b6d9#global"
[dshow @ 000001]  "OBS Virtual Camera"
[dshow @ 000001]     Alternative name "@device_sw_{860BB310}"
[dshow @ 000001] DirectShow audio devices
[dshow @ 000001]  "Microphone Array (Realtek)"
[dshow @ 000001]     Alternative name "@device_cm_{33D9}\\wave_{AA}"
dummy: Immediate exit requested`;

const AVF = `[AVFoundation indev @ 0x7f8] AVFoundation video devices:
[AVFoundation indev @ 0x7f8] [0] FaceTime HD Camera
[AVFoundation indev @ 0x7f8] [1] Continuity Camera
[AVFoundation indev @ 0x7f8] [2] Capture screen 0
[AVFoundation indev @ 0x7f8] AVFoundation audio devices:
[AVFoundation indev @ 0x7f8] [0] MacBook Pro Microphone
: Input/output error`;

describe('camera discovery parsing', () => {
  it('reads DirectShow cameras by their stable alternative name (ffmpeg 6+)', () => {
    expect(parseDshowDevices(DSHOW_NEW)).toEqual([
      {
        id: '@device_pnp_\\\\?\\usb#vid_1532&pid_0e08&mi_00#a&2f4bfbd3&0&0000#{65e8773d-8f56-11d0-a3b9-00a0c9223196}\\global',
        name: 'Razer Kiyo Pro Ultra',
        backend: 'dshow',
      },
    ]);
  });

  it('reads the older sectioned DirectShow listing and skips microphones', () => {
    expect(parseDshowDevices(DSHOW_OLD).map((d) => d.name)).toEqual([
      'Integrated Camera',
      'OBS Virtual Camera',
    ]);
  });

  it('reads AVFoundation cameras by name and never offers screen capture', () => {
    expect(parseAvfoundationDevices(AVF)).toEqual([
      { id: 'FaceTime HD Camera', name: 'FaceTime HD Camera', backend: 'avfoundation' },
      { id: 'Continuity Camera', name: 'Continuity Camera', backend: 'avfoundation' },
    ]);
  });

  it('prefers stable by-id links on Linux, falling back to nodes', () => {
    expect(
      v4lDevicesFromListing({
        byId: [
          'usb-Logitech_C920_ABCDEF12-video-index0',
          'usb-Logitech_C920_ABCDEF12-video-index1',
        ],
        nodes: [],
      }),
    ).toEqual([
      {
        id: '/dev/v4l/by-id/usb-Logitech_C920_ABCDEF12-video-index0',
        name: 'Logitech C920',
        backend: 'v4l2',
      },
    ]);
    expect(
      v4lDevicesFromListing({ byId: [], nodes: [{ node: '/dev/video0', name: 'HD Webcam\n' }] }),
    ).toEqual([{ id: '/dev/video0', name: 'HD Webcam', backend: 'v4l2' }]);
  });

  it('classifies the ways a capture fails', () => {
    expect(
      classifyCaptureError(
        '[in#0 @ 0] Could not set video options\nError opening input: I/O error',
      ),
    ).toBe('unsupported-size');
    expect(
      classifyCaptureError('Could not find video device with name [X] among source devices'),
    ).toBe('not-found');
    expect(
      classifyCaptureError('Could not run graph (sometimes caused by a device already in use)'),
    ).toBe('in-use');
    expect(classifyCaptureError('Failed to create AV capture input device: not authorized')).toBe(
      'permission',
    );
    expect(classifyCaptureError('something else')).toBe('unknown');
  });
});

describe('capture arguments', () => {
  it('opens a DirectShow camera with two lockstep outputs on pipes 1 and 3', () => {
    const args = captureArgs(
      { backend: 'dshow', device: '@device_pnp_x', videoSize: '1280x720' },
      { marker: 'gz_home_cam' },
    );
    expect(args).toContain('video=@device_pnp_x');
    expect(
      args.slice(args.indexOf('-filter_complex'), args.indexOf('-filter_complex') + 2),
    ).toEqual([
      '-filter_complex',
      "[0:v]fps=2,split=2[a][b];[a]scale=160:90,format=gray[gz_home_cam];[b]scale='min(1280,iw)':-2[gz_jpeg]",
    ]);
    expect(args.indexOf('pipe:1')).toBeLessThan(args.indexOf('pipe:3'));
    expect(args).not.toContain('-protocol_whitelist');
  });

  it('opens avfoundation at 30 fps without audio', () => {
    const args = captureArgs(
      { backend: 'avfoundation', device: 'FaceTime HD Camera' },
      { marker: 'gz' },
    );
    expect(args).toEqual(
      expect.arrayContaining(['-framerate', '30', '-i', 'FaceTime HD Camera:none']),
    );
  });
});

describe('frame stream splitting', () => {
  it('splits JPEGs across arbitrary chunk boundaries, including a split marker', () => {
    const a = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0x00, 3, 0xff, 0xd9]);
    const b = Buffer.from([0xff, 0xd8, 9, 9, 0xff, 0xd9]);
    const all = Buffer.concat([a, b]);
    const splitter = new JpegStreamSplitter();
    const out: Buffer[] = [];
    for (let i = 0; i < all.length; i++) out.push(...splitter.push(all.subarray(i, i + 1)));
    expect(out.map((x) => [...x])).toEqual([[...a], [...b]]);
  });

  it('slices raw frames whatever the chunk size', () => {
    const slicer = new RawFrameSlicer(10);
    expect(slicer.push(Buffer.alloc(7))).toHaveLength(0);
    expect(slicer.push(Buffer.alloc(18))).toHaveLength(2);
    expect(slicer.push(Buffer.alloc(5))).toHaveLength(1);
  });
});

// The real pipes, against a synthetic source, wherever ffmpeg is installed.
const ffmpeg = await locateFfmpeg();
describe.skipIf(!ffmpeg)('FfmpegFrameSource with a real ffmpeg', () => {
  it('pairs gray frames with JPEGs from both pipes', async () => {
    const spawnLavfi: typeof spawn = ((cmd: string, args: string[], opts: object) => {
      const i = args.indexOf('-i');
      const start = args.indexOf('-f');
      const rewritten = [
        ...args.slice(0, start),
        '-re',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=640x360:rate=10',
        ...args.slice(i + 2),
      ];
      return spawn(cmd, rewritten, opts as never);
    }) as never;
    const source = new FfmpegFrameSource({
      ffmpegPath: ffmpeg!.path,
      backend:
        process.platform === 'darwin'
          ? 'avfoundation'
          : process.platform === 'win32'
            ? 'dshow'
            : 'v4l2',
      device: 'synthetic',
      marker: 'gz_test',
      spawnImpl: spawnLavfi,
    });
    const frames: CameraFrame[] = [];
    source.onFrame((f) => frames.push(f));
    source.start();
    await new Promise((r) => setTimeout(r, 2_500));
    await source.stop();
    expect(frames.length).toBeGreaterThanOrEqual(3);
    for (const f of frames) {
      expect(f.gray.length).toBe(ANALYSIS_FRAME_BYTES);
      expect(f.jpeg[0]).toBe(0xff);
      expect(f.jpeg[1]).toBe(0xd8);
      expect(f.jpeg[f.jpeg.length - 1]).toBe(0xd9);
    }
  }, 15_000);
});
