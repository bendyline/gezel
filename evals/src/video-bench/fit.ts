/**
 * Fits video memory coefficients from the bench's `calibration.jsonl`, and
 * checks every clip against the estimate it was rendered under.
 *
 * Per engine, backend and architecture:
 *
 * - **Weights**: sd-server's own `total params memory size` against the
 *   estimator's weight bytes. More than 2% apart means the precision rules
 *   are wrong, and nothing below is worth fitting until they are fixed.
 * - **Sampling**: the diffusion model's compute buffer against
 *   batch x hidden width x latent tokens, by least squares. The slope is
 *   `sampleBytesPerTokenWidth`.
 * - **Decoding**: the decoder's buffer against pixel-frames.
 * - **Fixed**: what the peak held beyond the weights and the larger phase,
 *   the largest over the clips.
 *
 * The acceptance band is the plan's: an estimate never under the measured
 * peak, and never over the larger of 1.15x it and 1.5 GiB more. The output
 * is a report to read, never an edit: the coefficients change by hand in
 * `packages/core/src/media-memory-coefficients.ts`.
 */

const GIB = 1024 ** 3;

export interface CalibrationLine {
  host?: string;
  engine?: string;
  backend?: string;
  pool?: string;
  architecture?: string;
  model: string;
  size?: { width: number; height: number; numFrames: number };
  latentTokens?: number;
  hiddenSize?: number;
  batch?: number;
  estimateBytes?: number;
  weightBytes?: number;
  measuredPeakBytes?: number;
  /** The engine's lifetime footprint peak alone; misses pages only the GPU touched. */
  footprintPeakBytes?: number;
  /** The polled peak with Metal buffers counted as the GPU driver holds them. */
  gpuPeakBytes?: number;
  source?: string;
  /** Render settings the bench merged over the catalog's for this run. */
  sdCppOverride?: Record<string, unknown>;
  /** The sd.cpp render settings the engine read: the trial home's install record. */
  renderSettings?: Record<string, unknown>;
  /** The clip animated a picture. */
  animatesPicture?: boolean;
  /** The run directory the line came from; set when it is read, never written. */
  runDir?: string;
  engineReported?: { paramsBytes?: number };
  phases?: { encode: number; sample: number; decode: number };
}

export interface LineFit {
  slope: number;
  intercept: number;
  /** Largest residual of the points the line was fit to, bytes. */
  maxResidual: number;
}

/** Ordinary least squares; one point fits a line through the origin. */
export function linearFit(xs: readonly number[], ys: readonly number[]): LineFit | undefined {
  const n = Math.min(xs.length, ys.length);
  if (n === 0) return undefined;
  let slope: number;
  let intercept: number;
  if (n === 1) {
    slope = (xs[0] as number) === 0 ? 0 : (ys[0] as number) / (xs[0] as number);
    intercept = 0;
  } else {
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxx = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
      sxx += ((xs[i] as number) - mx) ** 2;
      sxy += ((xs[i] as number) - mx) * ((ys[i] as number) - my);
    }
    slope = sxx === 0 ? 0 : sxy / sxx;
    intercept = my - slope * mx;
  }
  let maxResidual = 0;
  for (let i = 0; i < n; i++) {
    const r = Math.abs(intercept + slope * (xs[i] as number) - (ys[i] as number));
    maxResidual = Math.max(maxResidual, r);
  }
  return { slope, intercept, maxResidual };
}

/** The plan's band: never under the measured peak, never far over it. */
export function inAcceptanceBand(measured: number, estimate: number): boolean {
  return estimate >= measured && estimate <= Math.max(1.15 * measured, measured + 1.5 * GIB);
}

export interface GroupFit {
  key: string;
  clips: number;
  /** Engine-reported weights over the estimator's, worst of the clips. */
  weightRatio?: number;
  sample?: LineFit & { bytesPerTokenWidth: number };
  decode?: LineFit & { bytesPerPixelFrame: number };
  fixedBytes?: number;
  /**
   * The most a clip's measured peak fell short of its reported weights and
   * larger buffer. The GPU holds those buffers, so a shortfall means the peak
   * missed them: `footprint` alone never sees pages only the GPU touched.
   */
  shortOfBuffersBytes?: number;
  rows: Array<{
    model: string;
    size: string;
    measured: number;
    estimate?: number;
    params?: number;
    sample?: number;
    decode?: number;
    inBand?: boolean;
  }>;
}

export function fitGroups(lines: readonly CalibrationLine[]): GroupFit[] {
  const groups = new Map<string, CalibrationLine[]>();
  for (const line of lines) {
    if (!line.measuredPeakBytes) continue;
    const key = `${line.engine ?? '?'}:${line.backend ?? '?'}:${line.architecture ?? '?'}`;
    groups.set(key, [...(groups.get(key) ?? []), line]);
  }
  return [...groups].map(([key, group]) => {
    const fit: GroupFit = { key, clips: group.length, rows: [] };
    const ratios = group
      .filter((l) => l.engineReported?.paramsBytes && l.weightBytes)
      .map((l) => (l.engineReported?.paramsBytes as number) / (l.weightBytes as number));
    if (ratios.length > 0) {
      fit.weightRatio = ratios.reduce((a, b) => (Math.abs(b - 1) > Math.abs(a - 1) ? b : a));
    }
    const sampled = group.filter((l) => l.phases && l.latentTokens && l.hiddenSize);
    const sample = linearFit(
      sampled.map((l) => (l.batch ?? 1) * (l.hiddenSize as number) * (l.latentTokens as number)),
      sampled.map((l) => l.phases?.sample ?? 0),
    );
    if (sample) fit.sample = { ...sample, bytesPerTokenWidth: sample.slope };
    const decoded = group.filter((l) => l.phases && l.size);
    const decode = linearFit(
      decoded.map((l) => pixelFrames(l)),
      decoded.map((l) => l.phases?.decode ?? 0),
    );
    if (decode) fit.decode = { ...decode, bytesPerPixelFrame: decode.slope };
    for (const l of group) {
      const params = l.engineReported?.paramsBytes;
      if (params !== undefined && l.phases) {
        const held =
          (l.measuredPeakBytes as number) - params - Math.max(l.phases.sample, l.phases.decode);
        fit.fixedBytes = Math.max(fit.fixedBytes ?? 0, held);
        if (held < 0) fit.shortOfBuffersBytes = Math.max(fit.shortOfBuffersBytes ?? 0, -held);
      }
      fit.rows.push({
        model: l.model,
        size: l.size ? `${l.size.width}x${l.size.height}x${l.size.numFrames}` : '?',
        measured: l.measuredPeakBytes as number,
        ...(l.estimateBytes !== undefined
          ? {
              estimate: l.estimateBytes,
              inBand: inAcceptanceBand(l.measuredPeakBytes as number, l.estimateBytes),
            }
          : {}),
        ...(params !== undefined ? { params } : {}),
        ...(l.phases ? { sample: l.phases.sample, decode: l.phases.decode } : {}),
      });
    }
    return fit;
  });
}

function pixelFrames(l: CalibrationLine): number {
  return l.size ? l.size.width * l.size.height * l.size.numFrames : 0;
}

export function renderFit(groups: readonly GroupFit[]): string {
  const gb = (b?: number) => (b === undefined ? '—' : (b / GIB).toFixed(2));
  const out: string[] = ['# Video memory fit', ''];
  for (const g of groups) {
    out.push(`## ${g.key} (${g.clips} clips)`, '');
    if (g.weightRatio !== undefined) {
      const off = Math.abs(g.weightRatio - 1) > 0.02;
      out.push(
        `- Weights: engine / estimate = ${g.weightRatio.toFixed(3)}${off ? ' — **fix the precision rules before fitting**' : ''}`,
      );
    }
    if (g.sample) {
      out.push(
        `- Sampling: ${g.sample.bytesPerTokenWidth.toFixed(2)} B per token-width (batch included), intercept ${gb(g.sample.intercept)} GiB, worst residual ${gb(g.sample.maxResidual)} GiB`,
      );
    }
    if (g.decode) {
      out.push(
        `- Decoding: ${gb(g.decode.intercept)} GiB + ${g.decode.bytesPerPixelFrame.toFixed(2)} B per pixel-frame, worst residual ${gb(g.decode.maxResidual)} GiB`,
      );
    }
    if (g.fixedBytes !== undefined) {
      out.push(`- Fixed (peak beyond weights and the larger phase): ${gb(g.fixedBytes)} GiB`);
    }
    if (g.shortOfBuffersBytes !== undefined) {
      out.push(
        `- A measured peak fell up to ${gb(g.shortOfBuffersBytes)} GiB short of the weights plus the larger buffer the GPU held: re-measure it with the GPU-aware peak (a footprint-only line misses GPU-only pages)`,
      );
    }
    out.push(
      '',
      '| model | size | peak GiB | estimate GiB | in band | weights | sample | decode |',
      '| --- | --- | --- | --- | --- | --- | --- | --- |',
      ...g.rows.map(
        (r) =>
          `| ${r.model} | ${r.size} | ${gb(r.measured)} | ${gb(r.estimate)} | ${r.inBand === undefined ? '—' : r.inBand ? 'yes' : '**no**'} | ${gb(r.params)} | ${gb(r.sample)} | ${gb(r.decode)} |`,
      ),
      '',
    );
  }
  return out.join('\n');
}
