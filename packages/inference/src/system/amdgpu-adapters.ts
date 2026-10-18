/**
 * The amdgpu devices Linux describes in sysfs, for the carve-out decision in
 * gpu-carve-out.ts — the Linux counterpart of the DXCore adapter listing the
 * device-health helper reads on Windows. Everything read here is
 * world-readable, so the machine service's unprivileged account sees it too.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { GpuAdapterFacts } from './gpu-carve-out.js';

const DRM_ROOT = '/sys/class/drm';
const AMD_PCI_VENDOR = 0x1002;

export interface SysfsIo {
  readFile?: (path: string) => string;
  readDir?: (path: string) => string[];
}

/**
 * One entry per amdgpu device: `dedicatedBytes` from `mem_info_vram_total`,
 * `sharedSystemBytes` from `mem_info_gtt_total` (the system RAM the kernel
 * lets it map). Connector entries (`card0-HDMI-A-1`) and render nodes are
 * skipped. Empty off Linux, without amdgpu, or when sysfs cannot be read.
 */
export function readAmdgpuAdapters(io: SysfsIo = {}): GpuAdapterFacts[] {
  const readFile = io.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const readDir = io.readDir ?? ((path: string) => readdirSync(path));
  const read = (path: string): string | undefined => {
    try {
      return readFile(path).trim();
    } catch {
      return undefined;
    }
  };
  let cards: string[];
  try {
    cards = readDir(DRM_ROOT).filter((entry) => /^card\d+$/.test(entry));
  } catch {
    return [];
  }
  const adapters: GpuAdapterFacts[] = [];
  for (const card of cards) {
    const device = join(DRM_ROOT, card, 'device');
    if (Number.parseInt(read(join(device, 'vendor')) ?? '', 16) !== AMD_PCI_VENDOR) continue;
    const vram = byteCount(read(join(device, 'mem_info_vram_total')));
    if (vram === undefined) continue;
    const gtt = byteCount(read(join(device, 'mem_info_gtt_total')));
    adapters.push({
      vendorId: AMD_PCI_VENDOR,
      dedicatedBytes: vram,
      ...(gtt !== undefined ? { sharedSystemBytes: gtt } : {}),
    });
  }
  return adapters;
}

function byteCount(raw: string | undefined): number | undefined {
  const value = raw ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
