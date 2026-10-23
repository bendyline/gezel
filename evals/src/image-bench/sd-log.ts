/**
 * Read stable-diffusion.cpp's own account of each generation from the
 * daemon log: where the time went (text encoding, sampling, decoding, weight
 * loading) and how much memory its parameters hold. The engine prints these
 * at info level, and the daemon mirrors every sd-server line with a
 * `[sd-server]` prefix.
 */

export interface SdGeneration {
  width: number;
  height: number;
  /** `get_learned_condition` — the text encoder. */
  textEncodeSeconds?: number;
  samplingSeconds?: number;
  decodeSeconds?: number;
  totalSeconds?: number;
  /** Weight loads during this generation; the first one after launch loads everything. */
  tensorLoadSeconds: number;
}

export interface SdServerLog {
  /** `total params memory size`, in MiB, split as the engine reports it. */
  paramsMiB?: number;
  paramsVramMiB?: number;
  paramsRamMiB?: number;
  components: Record<string, number>;
  generations: SdGeneration[];
  /** `[W]` and `[E]` lines, deduplicated, in first-seen order. */
  warnings: string[];
  errors: string[];
  /** Engine choices worth recording beside a result: flash attention, auto-fit, backend. */
  notes: string[];
}

const NUM = String.raw`([\d.]+)`;

export function parseSdServerLog(lines: readonly string[]): SdServerLog {
  const out: SdServerLog = {
    components: {},
    generations: [],
    warnings: [],
    errors: [],
    notes: [],
  };
  const seen = new Set<string>();
  let current: SdGeneration | undefined;
  for (const raw of lines) {
    const at = raw.indexOf('[sd-server]');
    const line = (at >= 0 ? raw.slice(at + '[sd-server]'.length) : raw).trim();
    const body = line.replace(/\s+---\s+\S+:\d+\s*$/, '');

    const params = body.match(
      new RegExp(`total params memory size = ${NUM}MB \\(VRAM ${NUM}MB, RAM ${NUM}MB\\): (.*)$`),
    );
    if (params) {
      out.paramsMiB = Number(params[1]);
      out.paramsVramMiB = Number(params[2]);
      out.paramsRamMiB = Number(params[3]);
      for (const part of (params[4] ?? '').split(',')) {
        const m = part.trim().match(new RegExp(`^(\\w+) ${NUM}MB`));
        if (m?.[1]) out.components[m[1]] = Number(m[2]);
      }
      continue;
    }
    const start = body.match(/\bgenerate_image (\d+)x(\d+)$/);
    if (start) {
      current = { width: Number(start[1]), height: Number(start[2]), tensorLoadSeconds: 0 };
      out.generations.push(current);
      continue;
    }
    const timed = (pattern: string) => body.match(new RegExp(`${pattern}${NUM}s`))?.[1];
    if (current) {
      const te = timed('get_learned_condition completed, taking ');
      if (te) current.textEncodeSeconds = Number(te);
      const sampling = timed('sampling completed, taking ');
      if (sampling) current.samplingSeconds = Number(sampling);
      const decode = timed('decode_first_stage completed, taking ');
      if (decode) current.decodeSeconds = Number(decode);
      const load = timed('loading tensors completed, taking ');
      if (load) current.tensorLoadSeconds += Number(load);
      const total = timed('generate_image completed in ');
      if (total) {
        current.totalSeconds = Number(total);
        current = undefined;
      }
    }
    const level = body.match(/^\[([WE])\]\s*(.*)$/);
    if (level?.[2] && !seen.has(level[2])) {
      seen.add(level[2]);
      (level[1] === 'E' ? out.errors : out.warnings).push(level[2]);
    }
    if (/flash attention|auto-fit|direct auto|params backend/i.test(body)) {
      const note = body.replace(/^\[[IWED]\]\s*/, '');
      if (!seen.has(`note:${note}`)) {
        seen.add(`note:${note}`);
        out.notes.push(note);
      }
    }
  }
  return out;
}
