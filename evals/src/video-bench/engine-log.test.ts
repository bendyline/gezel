import { describe, expect, it } from 'vitest';
import {
  diffusersJobReport,
  graphPhase,
  jobPhaseBytes,
  parseDiffusersVideoLog,
  parseSdVideoLog,
} from './engine-log.ts';

const P = 'INFO  [native] [sd-video-server]';
const MIB = 1024 * 1024;

// Shapes from a real Wan2.2 TI2V-5B run (2026-11-09), trimmed.
const LOG = [
  `${P} [I] total params memory size = 6779.03MB (VRAM 6779.03MB, RAM 0.00MB): text_encoders 3479.75MB(VRAM) --- diffusion_engine.cpp:1438`,
  `${P} [V] t5 compute buffer size: 1.00 MB(RAM) on CPU (peak across 1 segment) --- ggml_runner.cpp:1068`,
  `${P} [V] t5 compute buffer size: 360.00 MB(VRAM) on MTL0 (peak across 1 segment) --- ggml_runner.cpp:1068`,
  `${P} [I] generate_video 640x512x33 --- video.cpp:1928`,
  `${P} [V] Wan2.2-TI2V-5B compute buffer size: 471.36 MB(VRAM) on MTL0 (peak across 1 segment) --- ggml_runner.cpp:1068`,
  `${P} [V] taehv compute buffer size: 972.00 MB(VRAM) on MTL0 (peak across 1 segment) --- ggml_runner.cpp:1068`,
  `${P} [I] generate_video completed in 94.48s --- video.cpp:2282`,
  `${P} [I] generate_video 1280x704x33 --- video.cpp:1928`,
  `${P} [V] Wan2.2-TI2V-5B compute buffer size: 1189.43 MB(VRAM) on MTL0 (peak across 1 segment) --- ggml_runner.cpp:1068`,
  `${P} [I] generate_video completed in 482.29s --- video.cpp:2282`,
].join('\n');

describe('parseSdVideoLog', () => {
  it("gives each job the weights and every graph's latest buffer", () => {
    const jobs = parseSdVideoLog(LOG);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      size: { width: 640, height: 512, numFrames: 33 },
      paramsBytes: Math.round(6779.03 * MIB),
      completedSeconds: 94.48,
    });
    expect(jobs[0]?.buffers.t5).toEqual({
      vramBytes: Math.round(360 * MIB),
      ramBytes: Math.round(1 * MIB),
    });
    expect(jobs[0]?.buffers['Wan2.2-TI2V-5B']?.vramBytes).toBe(Math.round(471.36 * MIB));
  });

  it('carries a buffer the engine did not log again into the next job', () => {
    const second = parseSdVideoLog(LOG)[1];
    expect(second?.buffers['Wan2.2-TI2V-5B']?.vramBytes).toBe(Math.round(1189.43 * MIB));
    expect(second?.buffers.taehv?.vramBytes).toBe(Math.round(972 * MIB));
  });

  it('starts over when the engine relaunches', () => {
    const relaunched = `${LOG}\n${P} [I] total params memory size = 100.00MB (VRAM 100.00MB, RAM 0.00MB)\n${P} [I] generate_video 64x64x5 --- video.cpp:1928\n${P} [I] generate_video completed in 1.00s --- video.cpp:2282`;
    const last = parseSdVideoLog(relaunched)[2];
    expect(last?.paramsBytes).toBe(Math.round(100 * MIB));
    expect(last?.buffers).toEqual({});
  });
});

describe('graphPhase', () => {
  it('sorts the graphs sd-server names into the phases the estimator prices', () => {
    expect(graphPhase('t5')).toBe('encode');
    expect(graphPhase('Wan2.2-TI2V-5B')).toBe('sample');
    expect(graphPhase('taehv')).toBe('decode');
    expect(graphPhase('wan_vae')).toBe('decode');
  });

  it("takes each phase's largest graph", () => {
    const job = parseSdVideoLog(LOG)[1];
    expect(jobPhaseBytes(job?.buffers ?? {})).toEqual({
      encode: Math.round(360 * MIB) + Math.round(1 * MIB),
      sample: Math.round(1189.43 * MIB),
      decode: Math.round(972 * MIB),
    });
  });
});

describe('parseDiffusersVideoLog', () => {
  const V = 'INFO  [native] [video-server]';
  const TRACE = [
    `${V} memory versions torch=2.9.1 diffusers=0.39.0 transformers=4.57.0 accelerate=1.10.0`,
    `${V} loading wan t2v pipeline (WanPipeline) on mps …`,
    `${V} pipeline ready`,
    `${V} memory components transformer=10000 text_encoder=5000 vae=1000`,
    `${V} memory job 1280x704x121`,
    `${V} memory phase=encode device_peak=17000 process_max=900 accel=mps`,
    `${V} step 1/2`,
    `${V} memory phase=sample device_peak=40000 process_max=950 accel=mps`,
    `${V} memory phase=decode device_peak=30000 process_max=990 accel=mps`,
    `${V} memory phase=mux device_peak=16500 process_max=990 accel=mps`,
    `${V} memory job 640x352x33`,
    `${V} memory phase=encode device_peak=16500 process_max=990 accel=mps`,
  ].join('\n');

  it("gives each job its size, the loaded weights, and every phase's device peak", () => {
    const [first, second] = parseDiffusersVideoLog(TRACE);
    expect(first).toMatchObject({
      size: { width: 1280, height: 704, numFrames: 121 },
      componentBytes: { transformer: 10000, text_encoder: 5000, vae: 1000 },
      devicePeakBytes: { encode: 17000, sample: 40000, decode: 30000, mux: 16500 },
      processMaxBytes: 990,
      completed: true,
    });
    // A render that failed mid-way never reaches the mux.
    expect(second?.completed).toBe(false);
  });

  it('reports working memory as the device peak less the weights', () => {
    const [first] = parseDiffusersVideoLog(TRACE);
    const { size: _size, ...job } = first as NonNullable<typeof first>;
    const report = diffusersJobReport(job);
    expect(report.engineReported.paramsBytes).toBe(16000);
    expect(report.phases).toEqual({ encode: 1000, sample: 24000, decode: 14000 });
  });
});
