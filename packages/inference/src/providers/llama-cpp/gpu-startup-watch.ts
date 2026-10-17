/**
 * Did a GPU build of llama-server actually get its GPU? Read from the
 * engine's own startup output, because nothing else says.
 *
 * The bundled builds load their GPU backend with dlopen (`GGML_BACKEND_DL`),
 * and in a release build ggml skips a backend that fails to load without a
 * word. A CUDA backend that loads but cannot initialize prints one error line
 * and registers no devices. Either way the engine starts, answers, and runs
 * every token on the CPU — at a fraction of the speed the person's hardware
 * and Settings promise — while gezel reports the CUDA or Vulkan build it
 * launched.
 *
 * llama.cpp names every GPU it will use while loading a model
 * (`using device CUDA0 (NVIDIA GB10) …`), integrated GPUs included. A GPU
 * build that reached readiness after loading a model without that line ran
 * without its GPU. The explicit lines say why when there is a why to say.
 */

export type GpuUnusedReason =
  /** The CUDA runtime loaded and refused to start: `failed to initialize CUDA`. */
  | 'init-failed'
  /** The backend loaded and found no device it could use. */
  | 'no-devices'
  /** No sign of the GPU backend at all: it failed to load, silently. */
  | 'not-loaded';

export interface GpuUnused {
  backend: 'cuda' | 'vulkan';
  reason: GpuUnusedReason;
  /** The engine's own words, when it gave any. */
  detail?: string;
}

const USING_GPU = /\busing device (?:CUDA|Vulkan|ROCm|SYCL|MTL)\d+\b/;
const CUDA_INIT_FAILED = /ggml_cuda_init: failed to initialize CUDA:\s*(.+?)\s*$/;
const VULKAN_NO_DEVICES = /ggml_vulkan: No devices found/;
/**
 * Lines llama.cpp prints at the same verbosity as `using device`, while
 * loading a model. Without one the output is too quiet to conclude anything.
 */
const MODEL_LOAD =
  /\b(?:llama_model_loader:|load_tensors:|print_info:|llama_model_load_from_file_impl:)/;

export class GpuStartupWatch {
  private usingGpu = false;
  private sawModelLoad = false;
  private initFailure: string | undefined;
  private noDevices = false;

  constructor(private readonly backend: string | undefined) {}

  observe(line: string): void {
    if (USING_GPU.test(line)) this.usingGpu = true;
    if (MODEL_LOAD.test(line)) this.sawModelLoad = true;
    const failure = CUDA_INIT_FAILED.exec(line);
    if (failure?.[1]) this.initFailure = failure[1];
    if (VULKAN_NO_DEVICES.test(line)) this.noDevices = true;
  }

  /** At readiness: what kept the GPU out, or null when it is in use or this is no GPU build. */
  verdict(): GpuUnused | null {
    const backend = this.backend;
    if ((backend !== 'cuda' && backend !== 'vulkan') || this.usingGpu) return null;
    if (backend === 'cuda' && this.initFailure) {
      return { backend, reason: 'init-failed', detail: this.initFailure };
    }
    if (backend === 'vulkan' && this.noDevices) return { backend, reason: 'no-devices' };
    return this.sawModelLoad ? { backend, reason: 'not-loaded' } : null;
  }
}
