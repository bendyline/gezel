import { describe, expect, it } from 'vitest';
import { GpuStartupWatch } from './gpu-startup-watch.js';

// Lines as llama-server v0.6 prints them at its default verbosity.
const MODEL_LOAD = '0.00.512.004 I llama_model_loader: loaded meta data with 41 key-value pairs';
const USING_CUDA =
  '0.00.498.211 I llama_model_load_from_file_impl: using device CUDA0 (NVIDIA GB10) (0000:0f:01.0) - 120000 MiB free';
const USING_IGPU =
  '0.00.498.211 I llama_model_load_from_file_impl: using device Vulkan0 (AMD Radeon 8060S Graphics (RADV GFX1151)) (unknown id) - 96000 MiB free';

function watch(backend: string | undefined, lines: string[]) {
  const w = new GpuStartupWatch(backend);
  for (const line of lines) w.observe(line);
  return w.verdict();
}

describe('GpuStartupWatch', () => {
  it('is satisfied by a GPU llama.cpp says it is using, integrated ones included', () => {
    expect(watch('cuda', [MODEL_LOAD, USING_CUDA])).toBeNull();
    expect(watch('vulkan', [MODEL_LOAD, USING_IGPU])).toBeNull();
  });

  it('names CUDA’s own reason when it refused to start', () => {
    expect(
      watch('cuda', [
        '0.00.283.928 E ggml_cuda_init: failed to initialize CUDA: CUDA driver version is insufficient for CUDA runtime version',
        MODEL_LOAD,
      ]),
    ).toEqual({
      backend: 'cuda',
      reason: 'init-failed',
      detail: 'CUDA driver version is insufficient for CUDA runtime version',
    });
  });

  it('reports a Vulkan build that found no device', () => {
    expect(watch('vulkan', ['ggml_vulkan: No devices found.', MODEL_LOAD])).toEqual({
      backend: 'vulkan',
      reason: 'no-devices',
    });
  });

  it('catches a GPU library that never loaded, which prints nothing', () => {
    expect(watch('cuda', [MODEL_LOAD])).toEqual({ backend: 'cuda', reason: 'not-loaded' });
  });

  it('concludes nothing from output too quiet to show a model load, or for a CPU build', () => {
    expect(watch('cuda', ['0.00.421.354 W srv  llama_server: CORS is set'])).toBeNull();
    expect(watch('cpu', [MODEL_LOAD])).toBeNull();
    expect(watch(undefined, [MODEL_LOAD])).toBeNull();
  });
});
