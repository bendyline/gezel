# Video bench

`pnpm --filter @bendyline/gezel-evals run video-bench -- --models <a,b> [flags]`

Renders clips through local video models the way a person's request does, and
records what each clip cost: wall time, the frames and size delivered, simple
sanity flags, and the engine's peak memory beside the estimates Gezel admits
renders with. The flags and their defaults are at the top of
`src/bin/video-bench.ts`.

## What one run does

For each model:

1. Links the model from the eval cache (`--cache`, default
   `~/.gezel-eval-cache`) into a fresh trial home. sd.cpp models live in
   `engines/sd-cpp-video/models/<id>/`, diffusers models in
   `engines/video/models/<id>/`.
2. Starts a trial daemon with the catalog at `--gilde-data` (default the
   sibling `../gilde/data`), a private capacity ledger, and
   `GEZEL_MEDIA_MEMORY_TRACE=1` (verbose sd-server logs; the diffusers
   engine's per-phase memory trace).
3. Renders every size × prompt × seed with `POST /api/video-gen/generate`,
   naming the model, seed and size. Image-to-video with `--image`.
4. Saves each clip, probes it with ffprobe (frames, size, sound), and flags
   `black`, `frozen` or `undecodable` from eight grey thumbnails.

## Memory

On macOS a clip's peak is the larger of two readings, both taken while the
engine runs:

- `footprint`'s `phys_footprint_peak` for the engine process: the kernel's
  lifetime maximum, so a short spike in the VAE decode cannot be missed
  between samples. It counts only pages the process touched itself.
- A once-a-second poll of what the engine holds with Metal buffers counted as
  the GPU driver holds them: the process's footprint less its `Untagged`
  category (where ggml's Metal buffers sit), plus the rise in the GPU
  driver's "In use system memory" (`ioreg -c IOAccelerator`) since before the
  engine started. ggml's compute buffers are written by the GPU alone, so
  footprint never sees them: during sampling a 2.4 GB LingBot buffer and an
  856 MB Wan2.1 one were missing from it while the driver held them. The
  driver's figure covers every process, so run the bench on an otherwise
  idle machine.

`calibration.jsonl` keeps both (`footprintPeakBytes`, `gpuPeakBytes`) beside
`measuredPeakBytes`, and `gpuPeakParts` (the footprint, its `Untagged` and
GPU-owned categories, and the driver's rise) for the sample that set the
peak. The GPU-owned categories (`IOAccelerator`, `IOSurface`, owned graphics
footprint) are subtracted from the footprint, since the driver's figure
already holds them: lines without `gpuPeakParts` predate that and read up to
1.1 GiB high (82.9 GiB once, for a 54.5 GiB LTX clip). Lines written before
2026-11-10 have only the footprint peak (`source: "footprint"`) and read low
on clips whose peak is in sampling. Each line also records the render
settings the engine read (`renderSettings`, from the trial home's install
record) and whether the clip animated a picture (`animatesPicture`), which
core prices. On Linux the image bench's `MemoryWatch` supplies the MemAvailable
drop and VmRSS.

Each clip's line in `calibration.jsonl` carries the size rendered, core's
size-aware estimate for it (`sdCppVideoMemoryRequirement` /
`videoMemoryRequirement`, with the catalog's files), and the measured peak.
For sd.cpp it also carries `engineReported`: the weights and each graph's
compute buffer as sd-server logged them for that clip (diffusion model, text
encoder, decoder; `engine-log.ts`). Those split the peak into the parts the
estimator prices separately, and fit the sampling slope directly.
For diffusers, PyTorch reports no per-graph buffers, so the engine
(`gezel_video_server.py --memory-trace`) logs each loaded component's weights
once and the device's peak in each phase of every clip: encoding the prompt,
sampling, decoding, muxing. CUDA's peak counter is exact and reset per phase;
on MPS the driver's allocation is polled every 100 ms and includes the
allocator's cache. `engineReported` then holds the components and those
peaks, and `phases` each peak less the weights, which is what the fit reads.
The trace's `memory versions` line names the torch, diffusers and
transformers a constant was measured with.
One engine serves every clip in a model's run, so its peak is the run's: for
calibration, run one size per invocation, largest last, or read the per-clip
lines in order.

## Outputs

`--runs-dir` (default `evals/runs/video-bench-<timestamp>`):

- `report.md`: per model (clips, cold and steady seconds, peak, daemon fit,
  verdict) and per clip (rendered size, seconds, estimate, probe, flags,
  settings notes).
- `renders.jsonl`, `calibration.jsonl`.
- `<model>/` with the clips, `model.json` and the trial daemon's log.
- `trial-weights.json`: each model's install record and weight files (sizes,
  safetensors tensors) as its engine loaded them. `fit-media-memory` prices a
  run from it once the trial home's copies of the weights are deleted
  (`homes/*/engines/`, the bulk of a run's size), so a fixture still
  regenerates from old runs.

## Recorded runs

sd.cpp video on this Mac (M5 Max, Metal), 2026-11-09 and -10: every
first-wave entry at small sizes and at its default, image-to-video, and a
fixed-seed scale ladder. The tables are in `docs/media-model-memory.md`; the
clips that counted GPU-held memory are core's calibration fixture
(`packages/core/src/__fixtures__/media-memory/sd-cpp-metal-m5max.json`,
written by `fit-media-memory --write-fixture`). Still to run: the DGX Spark
(CUDA), an AMD/Intel PC (Vulkan), and the diffusers entries with the trace.

What the clips showed, beyond memory (same prompt and seed throughout):
Wan2.2 TI2V-5B Turbo rendered as well as the 20-step model or better (the
20-step city clip came out nearly black and frozen) in a tenth of the time,
with more muted color. LingBot animating a picture (vision encoder, patched
sd-server) held the picture's scene at 17 and 33 frames but moved to another
scene within a third of a second at 49 and 81, so its catalog entry makes
clips from words only. Wan2.1 1.3B's tiny decoder bands the sky, and
the 20-step Wan2.2 clips at the default size came out overexposed.
