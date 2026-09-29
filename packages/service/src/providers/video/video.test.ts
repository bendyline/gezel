import { describe, expect, it } from 'vitest';
import { parseVideoProgress, parseVideoWarmupStatus } from './diffusers-video.js';
import { buildVideoServerArgs } from './factory.js';
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

  it('floors diffusers and transformers at the LTX-2.3-capable releases on every accelerator', () => {
    for (const accel of ['mps', 'cuda', 'cpu'] as const) {
      const { packages } = videoVenvSpec(accel);
      expect(packages).toContain('diffusers>=0.39.0');
      expect(packages).toContain('transformers>=4.50.0');
    }
  });
});

describe('buildVideoServerArgs', () => {
  const base = {
    serverPath: '/srv/gezel_video_server.py',
    accelerator: 'mps' as const,
    port: 9123,
  };

  it('passes only the core flags for a plain diffusers tree', () => {
    const args = buildVideoServerArgs({
      ...base,
      model: { modelDir: '/models/wan', family: 'wan' },
    });
    expect(args).toEqual([
      '/srv/gezel_video_server.py',
      '--model',
      '/models/wan',
      '--family',
      'wan',
      '--accelerator',
      'mps',
      '--host',
      '127.0.0.1',
      '--port',
      '9123',
    ]);
  });

  it('forwards the load descriptor, including a distilled sigma schedule', () => {
    const args = buildVideoServerArgs({
      ...base,
      model: {
        modelDir: '/models/ltx-2.3-22b-distilled',
        family: 'ltx2',
        load: {
          strategy: 'diffusers-tree',
          pipelineClass: 'LTX2Pipeline',
          vaeDtype: 'float32',
          audio: true,
          sigmas: [1, 0.99375, 0.421875],
        },
      },
    });
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(flag('--load-strategy')).toBe('diffusers-tree');
    expect(flag('--pipeline-class')).toBe('LTX2Pipeline');
    expect(flag('--vae-dtype')).toBe('float32');
    expect(args).toContain('--audio');
    expect(flag('--sigmas')).toBe('1,0.99375,0.421875');
  });

  it('omits --sigmas when the model uses its scheduler', () => {
    const args = buildVideoServerArgs({
      ...base,
      model: {
        modelDir: '/models/ltx-2.3-22b',
        family: 'ltx2',
        load: { strategy: 'diffusers-tree', audio: true },
      },
    });
    expect(args).not.toContain('--sigmas');
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
