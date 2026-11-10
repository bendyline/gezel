/**
 * What sd-server says it allocated for each video job, from its verbose log
 * (`GEZEL_MEDIA_MEMORY_TRACE=1` launches it with `--log-level verbose`).
 *
 * A peak is one number for a whole clip; these split it into the parts the
 * estimator prices separately: the weights (`total params memory size`), and
 * each graph's compute buffer (the diffusion model while sampling, the text
 * encoder, the VAE or tiny decoder). sd-server logs a buffer only when its
 * size changes, so a job's buffers are the latest size of every graph when
 * the job completes. Sizes are printed in MiB.
 */

export interface SdVideoJobBuffers {
  size: { width: number; height: number; numFrames: number };
  /** Weights resident on the compute device and in RAM. */
  paramsBytes?: number;
  /** Each graph's compute buffer, by graph name and device (`VRAM` or `RAM`). */
  buffers: Record<string, { vramBytes: number; ramBytes: number }>;
  completedSeconds?: number;
}

const MIB = 1024 * 1024;
const PARAMS = /total params memory size = ([\d.]+)MB/;
const BUFFER = /\] \[V\] (.+?) compute buffer size: ([\d.]+) MB\((VRAM|RAM)\)/;
const START = /generate_video (\d+)x(\d+)x(\d+) ---/;
const DONE = /generate_video completed in ([\d.]+)s/;

export function parseSdVideoLog(text: string): SdVideoJobBuffers[] {
  const jobs: SdVideoJobBuffers[] = [];
  const latest = new Map<string, { vramBytes: number; ramBytes: number }>();
  let paramsBytes: number | undefined;
  let open: SdVideoJobBuffers | undefined;
  for (const line of text.split('\n')) {
    const params = PARAMS.exec(line);
    if (params) {
      paramsBytes = Math.round(Number(params[1]) * MIB);
      latest.clear();
      continue;
    }
    const buffer = BUFFER.exec(line);
    if (buffer) {
      const [, name, mib, device] = buffer as unknown as [string, string, string, string];
      const entry = latest.get(name) ?? { vramBytes: 0, ramBytes: 0 };
      const bytes = Math.round(Number(mib) * MIB);
      if (device === 'VRAM') entry.vramBytes = bytes;
      else entry.ramBytes = bytes;
      latest.set(name, entry);
      continue;
    }
    const start = START.exec(line);
    if (start) {
      open = {
        size: { width: Number(start[1]), height: Number(start[2]), numFrames: Number(start[3]) },
        ...(paramsBytes !== undefined ? { paramsBytes } : {}),
        buffers: {},
      };
      continue;
    }
    const done = DONE.exec(line);
    if (done && open) {
      open.completedSeconds = Number(done[1]);
      open.buffers = Object.fromEntries([...latest].map(([name, b]) => [name, { ...b }]));
      jobs.push(open);
      open = undefined;
    }
  }
  return jobs;
}

export type GraphPhase = 'encode' | 'sample' | 'decode';

/**
 * The estimator phase a graph's buffer belongs to, by the name sd-server logs
 * it under (`t5`, `Wan2.2-TI2V-5B`, `taehv`, ...). A name nothing here knows
 * counts as sampling: the diffusion model's name follows the checkpoint.
 */
export function graphPhase(name: string): GraphPhase {
  if (/vae|taehv|\btae|decoder/i.test(name)) return 'decode';
  if (/t5|clip|llm|qwen|gemma|text|conditioner|connector|vision|mmproj|embed/i.test(name)) {
    return 'encode';
  }
  return 'sample';
}

/** Each phase's largest graph for one job, VRAM and RAM together. Graphs of a phase run one at a time. */
export function jobPhaseBytes(buffers: SdVideoJobBuffers['buffers']): Record<GraphPhase, number> {
  const out: Record<GraphPhase, number> = { encode: 0, sample: 0, decode: 0 };
  for (const [name, b] of Object.entries(buffers)) {
    const phase = graphPhase(name);
    out[phase] = Math.max(out[phase], b.vramBytes + b.ramBytes);
  }
  return out;
}

/**
 * What the diffusers engine says each video job held, from its memory trace
 * (`GEZEL_MEDIA_MEMORY_TRACE=1` launches `gezel_video_server.py` with
 * `--memory-trace`). PyTorch reports no per-graph buffers, so the engine logs
 * the device's peak in each phase instead: CUDA's exact reserved peak, or on
 * MPS the driver's allocation polled every 100 ms (it includes the allocator's
 * cache). The weights come from `memory components`, logged once per load.
 */
export interface DiffusersVideoJob {
  size: { width: number; height: number; numFrames: number };
  /** Each loaded component's weights at the precision it was loaded in. */
  componentBytes: Record<string, number>;
  /** The device's peak in each phase, weights included. */
  devicePeakBytes: Partial<Record<GraphPhase | 'mux', number>>;
  /** The engine process's lifetime maximum resident size when the job ended. */
  processMaxBytes?: number;
  /** The job reached its last phase; a failed render stops earlier. */
  completed: boolean;
}

const TRACE_JOB = /memory job (\d+)x(\d+)x(\d+)/;
const TRACE_PHASE = /memory phase=(\w+) device_peak=(\d+) process_max=(\d+)/;
const TRACE_COMPONENTS = /memory components ?(.*)$/;

export function parseDiffusersVideoLog(text: string): DiffusersVideoJob[] {
  const jobs: DiffusersVideoJob[] = [];
  let componentBytes: Record<string, number> = {};
  let open: DiffusersVideoJob | undefined;
  for (const line of text.split('\n')) {
    const components = TRACE_COMPONENTS.exec(line);
    if (components) {
      componentBytes = Object.fromEntries(
        (components[1] ?? '')
          .split(/\s+/)
          .map((part) => part.split('='))
          .filter((kv): kv is [string, string] => kv.length === 2 && /^\d+$/.test(kv[1] ?? ''))
          .map(([name, bytes]) => [name, Number(bytes)]),
      );
      continue;
    }
    const job = TRACE_JOB.exec(line);
    if (job) {
      open = {
        size: { width: Number(job[1]), height: Number(job[2]), numFrames: Number(job[3]) },
        componentBytes: { ...componentBytes },
        devicePeakBytes: {},
        completed: false,
      };
      jobs.push(open);
      continue;
    }
    const phase = TRACE_PHASE.exec(line);
    if (phase && open) {
      const name = phase[1] as GraphPhase | 'mux';
      open.devicePeakBytes[name] = Number(phase[2]);
      open.processMaxBytes = Number(phase[3]);
      if (name === 'mux') open.completed = true;
    }
  }
  return jobs;
}

/**
 * A diffusers job in the shape the memory fit reads: the weights it loaded,
 * and each phase's working memory as its device peak less those weights.
 * Everything stays on the device without offload, so the difference is what
 * the phase held beyond the model.
 */
export function diffusersJobReport(job: Omit<DiffusersVideoJob, 'size'>): {
  engineReported: {
    paramsBytes: number;
    componentBytes: Record<string, number>;
    devicePeakBytes: DiffusersVideoJob['devicePeakBytes'];
    processMaxBytes?: number;
  };
  phases: Record<GraphPhase, number>;
} {
  const paramsBytes = Object.values(job.componentBytes).reduce((sum, b) => sum + b, 0);
  const working = (phase: GraphPhase) =>
    Math.max(0, (job.devicePeakBytes[phase] ?? 0) - paramsBytes);
  return {
    engineReported: {
      paramsBytes,
      componentBytes: job.componentBytes,
      devicePeakBytes: job.devicePeakBytes,
      ...(job.processMaxBytes !== undefined ? { processMaxBytes: job.processMaxBytes } : {}),
    },
    phases: { encode: working('encode'), sample: working('sample'), decode: working('decode') },
  };
}
