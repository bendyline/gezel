import { describe, expect, it } from 'vitest';
import { parseVideoProgress, parseVideoWarmupStatus } from './diffusers-video.js';
import { MockVideoProvider } from './mock.js';
import { detectVideoAccelerator, resetAcceleratorCache, videoVenvSpec } from './venv.js';

describe('videoVenvSpec', () => {
  it('mps: floor-pinned torch from PyPI, no extra index', () => {
    const spec = videoVenvSpec('mps');
    expect(spec.extraIndexUrls).toBeUndefined();
    // Floor, not exact — an exact pin breaks on Pythons without that
    // wheel; the floor lets pip resolve a compatible build.
    expect(spec.packages).toContain('torch>=2.5.1');
    expect(spec.packages).not.toContain('torch==2.5.1');
    expect(spec.packages.some((p) => p.startsWith('diffusers'))).toBe(true);
  });

  it('cuda: pins +cu124 wheels and adds the PyTorch CUDA index', () => {
    const spec = videoVenvSpec('cuda');
    expect(spec.packages).toContain('torch==2.5.1+cu124');
    expect(spec.packages).toContain('torchvision==0.20.1+cu124');
    expect(spec.extraIndexUrls).toEqual(['https://download.pytorch.org/whl/cu124']);
  });

  it('cpu: pins +cpu wheels and adds the PyTorch CPU index', () => {
    const spec = videoVenvSpec('cpu');
    expect(spec.packages).toContain('torch==2.5.1+cpu');
    expect(spec.extraIndexUrls).toEqual(['https://download.pytorch.org/whl/cpu']);
  });
});

describe('detectVideoAccelerator', () => {
  it('maps Apple Silicon to mps', async () => {
    resetAcceleratorCache();
    const accel = await detectVideoAccelerator({ platform: 'darwin', arch: 'arm64' });
    expect(accel).toBe('mps');
  });

  it('maps Intel Mac to cpu (no usable GPU path)', async () => {
    resetAcceleratorCache();
    const accel = await detectVideoAccelerator({ platform: 'darwin', arch: 'x64' });
    expect(accel).toBe('cpu');
  });
});

describe('parseVideoProgress', () => {
  it('parses a bare step line', () => {
    expect(parseVideoProgress('step 7/40')).toEqual({ step: 7, totalSteps: 40 });
  });

  it('parses a supervisor-prefixed line', () => {
    expect(parseVideoProgress('[video-server] step 12/40')).toEqual({ step: 12, totalSteps: 40 });
  });

  it('returns null for unrelated noise', () => {
    expect(parseVideoProgress('loading pipeline on cuda …')).toBeNull();
  });
});

describe('parseVideoWarmupStatus', () => {
  it('maps our own pipeline-load marker to a loading message', () => {
    expect(parseVideoWarmupStatus('[video-server] loading ltx t2v pipeline on mps …')).toMatch(
      /loading the model/i,
    );
    expect(parseVideoWarmupStatus('loading wan i2v pipeline on cuda …')).toMatch(
      /loading the model/i,
    );
  });

  it('maps diffusers loader chatter to weight/component messages', () => {
    expect(parseVideoWarmupStatus('Loading weights:  61%|████  | 133/219')).toMatch(
      /loading model weights/i,
    );
    expect(parseVideoWarmupStatus('Loading checkpoint shards: 100%|██| 2/2')).toMatch(
      /loading model weights/i,
    );
    expect(parseVideoWarmupStatus('Loading pipeline components...:  60%|██| 3/5')).toMatch(
      /loading pipeline components/i,
    );
  });

  it('maps the ready line to a starting message', () => {
    expect(parseVideoWarmupStatus('[video-server] pipeline ready')).toMatch(/starting generation/i);
  });

  it('returns null for sampling-step and unrelated lines', () => {
    expect(parseVideoWarmupStatus('step 3/40')).toBeNull();
    expect(parseVideoWarmupStatus('listening on http://127.0.0.1:9091')).toBeNull();
  });
});

describe('MockVideoProvider', () => {
  it('generates a placeholder clip with a poster and fires progress', async () => {
    const provider = new MockVideoProvider();
    let progressed = false;
    const out = await provider.generate({
      prompt: 'a cat surfing',
      onProgress: () => {
        progressed = true;
      },
    });
    expect(progressed).toBe(true);
    expect(out.video.length).toBeGreaterThan(0);
    expect(out.poster?.length).toBeGreaterThan(0);
    expect(out.meta.mimeType).toBe('video/mp4');
  });

  it('reports a healthy mock engine', async () => {
    const provider = new MockVideoProvider();
    const health = await provider.health();
    expect(health.status).toBe('ok');
  });
});
