/**
 * Reading ffmpeg's device listings. Pure; the fixtures in the test are real
 * output from each platform and ffmpeg generation, because the format moved
 * (ffmpeg 6 switched DirectShow's headers to `(video)` / `(audio)` tags).
 */

import type { CameraDevice } from '@bendyline/gezel';

/** Strip ffmpeg's `[dshow @ 0x…]` / `[in#0 @ 0x…]` log prefix. */
function body(line: string): string {
  return line.replace(/^\s*\[[^\]]*\]\s?/, '');
}

/**
 * DirectShow devices. Prefers each device's "Alternative name" as its id —
 * the PnP path survives a replug into the same port and tells two identical
 * webcams apart, where the friendly name does neither.
 */
export function parseDshowDevices(stderr: string): CameraDevice[] {
  const out: CameraDevice[] = [];
  let section: 'video' | 'audio' | null = null;
  let pending: { name: string; video: boolean } | null = null;
  const flush = () => {
    if (pending?.video) out.push({ id: pending.name, name: pending.name, backend: 'dshow' });
    pending = null;
  };
  for (const raw of stderr.split(/\r?\n/)) {
    const line = body(raw);
    if (/DirectShow video devices/i.test(line)) {
      flush();
      section = 'video';
      continue;
    }
    if (/DirectShow audio devices/i.test(line)) {
      flush();
      section = 'audio';
      continue;
    }
    const alt = /^\s*Alternative name\s+"(.+)"\s*$/.exec(line);
    if (alt && pending) {
      const p = pending as { name: string; video: boolean };
      if (p.video) out.push({ id: alt[1] as string, name: p.name, backend: 'dshow' });
      pending = null;
      continue;
    }
    const dev = /^\s*"(.+)"\s*(?:\((video|audio|none)\))?\s*$/.exec(line);
    if (dev) {
      flush();
      const tag = dev[2];
      const video = tag ? tag === 'video' : section === 'video';
      pending = { name: dev[1] as string, video };
    }
  }
  flush();
  return out;
}

/**
 * AVFoundation devices. The id is the device name, which ffmpeg accepts in
 * place of an index; indices shuffle when a camera is plugged in. Screen
 * capture devices are dropped: a camera connector must never become a
 * screen recorder.
 */
export function parseAvfoundationDevices(stderr: string): CameraDevice[] {
  const out: CameraDevice[] = [];
  let inVideo = false;
  for (const raw of stderr.split(/\r?\n/)) {
    const line = body(raw);
    if (/AVFoundation video devices/i.test(line)) {
      inVideo = true;
      continue;
    }
    if (/AVFoundation audio devices/i.test(line)) {
      inVideo = false;
      continue;
    }
    if (!inVideo) continue;
    const m = /^\s*\[(\d+)\]\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const name = m[2] as string;
    if (isScreenCaptureName(name)) continue;
    out.push({ id: name, name, backend: 'avfoundation' });
  }
  return out;
}

export function isScreenCaptureName(name: string): boolean {
  return /^capture screen\b/i.test(name.trim());
}

/**
 * Linux v4l2 devices from `/dev/v4l/by-id` links (stable) or `/dev/video*`
 * nodes with their sysfs names. Only `index0` links are capture nodes; the
 * others are metadata streams a webcam exposes beside its picture.
 */
export function v4lDevicesFromListing(input: {
  byId: string[];
  nodes: { node: string; name?: string }[];
}): CameraDevice[] {
  const capture = input.byId.filter((n) => /-video-index0$/.test(n));
  if (capture.length > 0) {
    return capture.map((link) => ({
      id: `/dev/v4l/by-id/${link}`,
      name: prettyV4lName(link),
      backend: 'v4l2' as const,
    }));
  }
  return input.nodes.map((n) => ({
    id: n.node,
    name: n.name?.trim() || n.node,
    backend: 'v4l2' as const,
  }));
}

function prettyV4lName(link: string): string {
  return link
    .replace(/^usb-/, '')
    .replace(/-video-index0$/, '')
    .replace(/_[0-9A-F]{6,}$/i, '')
    .replace(/_/g, ' ')
    .trim();
}

export type CaptureFailureKind =
  | 'not-found'
  | 'in-use'
  | 'permission'
  | 'unsupported-size'
  | 'unknown';

/** Classify ffmpeg's stderr from a capture that failed to start or died. */
export function classifyCaptureError(stderr: string): CaptureFailureKind {
  const s = stderr.toLowerCase();
  if (
    /could not set video options|cannot set video size|unsupported .*size|video size .* not supported/.test(
      s,
    )
  ) {
    return 'unsupported-size';
  }
  if (/not authorized|not permitted|permission denied|access is denied|0x80070005/.test(s)) {
    return 'permission';
  }
  if (/already in use|device busy|resource busy|could not run graph/.test(s)) return 'in-use';
  if (
    /could not find video device|no such file or directory|no such device|i\/o error|error opening input/.test(
      s,
    )
  ) {
    return 'not-found';
  }
  return 'unknown';
}
