import { describe, expect, it } from 'vitest';
import { parseSdServerLog } from './sd-log.ts';

const prefix = '2026-10-18T06:47:00.000Z INFO  [native] [sd-server] ';

const lines = [
  '[I] total params memory size = 4841.39MB (VRAM 4841.39MB, RAM 0.00MB): text_encoders 2375.91MB(VRAM), diffusion_model 2346.40MB(VRAM), vae 119.08MB(VRAM), controlnet 0.00MB(N/A), extensions 0.00MB(N/A) --- diffusion_engine.cpp:1329',
  '[W] auto-fit: no GPU devices; using the default backend --- backend_fit.cpp:444',
  '[I] flash attention auto: CUDA0 -> on (CUDA MMA) --- flash_attn.cpp:70',
  '[I] generate_image 512x512 --- image.cpp:814',
  '[I] loading tensors completed, taking 0.52s (read: 0.31s, memcpy: 0.00s) --- model_loader.cpp:1385',
  '[I] get_learned_condition completed, taking 1.01s --- image.cpp:529',
  '[I] loading tensors completed, taking 0.60s (read: 0.42s) --- model_loader.cpp:1385',
  '[I] sampling completed, taking 4.30s --- image.cpp:899',
  '[I] decode_first_stage completed, taking 0.71s --- image.cpp:624',
  '[I] generate_image completed in 6.03s --- image.cpp:1050',
  '[I] generate_image 1024x768 --- image.cpp:814',
  '[I] get_learned_condition completed, taking 0.01s --- image.cpp:529',
  '[I] sampling completed, taking 3.53s --- image.cpp:899',
  '[I] decode_first_stage completed, taking 0.46s --- image.cpp:624',
  '[I] generate_image completed in 4.00s --- image.cpp:1050',
  '[W] auto-fit: no GPU devices; using the default backend --- backend_fit.cpp:444',
].map((l) => `${prefix}${l}`);

describe('parseSdServerLog', () => {
  const log = parseSdServerLog(lines);

  it('reads the params memory and its components', () => {
    expect(log.paramsMiB).toBe(4841.39);
    expect(log.paramsVramMiB).toBe(4841.39);
    expect(log.paramsRamMiB).toBe(0);
    expect(log.components).toMatchObject({
      text_encoders: 2375.91,
      diffusion_model: 2346.4,
      vae: 119.08,
    });
  });

  it('splits phase timings per generation', () => {
    expect(log.generations).toEqual([
      {
        width: 512,
        height: 512,
        textEncodeSeconds: 1.01,
        samplingSeconds: 4.3,
        decodeSeconds: 0.71,
        totalSeconds: 6.03,
        tensorLoadSeconds: 1.12,
      },
      {
        width: 1024,
        height: 768,
        textEncodeSeconds: 0.01,
        samplingSeconds: 3.53,
        decodeSeconds: 0.46,
        totalSeconds: 4,
        tensorLoadSeconds: 0,
      },
    ]);
  });

  it('keeps each warning once and notes engine placement choices', () => {
    expect(log.warnings).toEqual(['auto-fit: no GPU devices; using the default backend']);
    expect(log.notes).toEqual([
      'auto-fit: no GPU devices; using the default backend',
      'flash attention auto: CUDA0 -> on (CUDA MMA)',
    ]);
    expect(log.errors).toEqual([]);
  });
});
