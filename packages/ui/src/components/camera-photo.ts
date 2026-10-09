/**
 * Camera capture for the chat composer. Two paths produce the same result —
 * a JPEG in the prompt draft's media bin:
 *
 * - **native**: phones open their own camera from
 *   `<input type="file" accept="image/*" capture="environment">`. iOS and
 *   Android's Capacitor WebView both honor `capture`; Android only does so
 *   when `accept` is exactly `image/*`.
 * - **viewfinder**: desktops ignore `capture` and would show a file picker,
 *   so they get an in-app live preview over `getUserMedia`.
 */

export type CameraCaptureMode = 'native' | 'viewfinder';

/**
 * Longest edge of a photo we keep. Every vision model we route to tiles or
 * downsamples well below this, and a phone's 12-48 MP original would cost
 * megabytes per message in the draft folder and in each provider request.
 */
export const CAMERA_PHOTO_MAX_EDGE = 2048;
export const CAMERA_PHOTO_QUALITY = 0.88;

const NATIVE_PLATFORMS = new Set(['mobile', 'ios', 'android']);

export function cameraCaptureMode(): CameraCaptureMode {
  if (NATIVE_PLATFORMS.has(window.__GEZEL__?.platform ?? '')) return 'native';
  // A phone browser reaching the daemon UI over a tunnel: coarse-only
  // pointers mean a touch device whose file input opens the camera.
  const coarseOnly =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(pointer: coarse)').matches &&
    !window.matchMedia('(any-pointer: fine)').matches;
  return coarseOnly ? 'native' : 'viewfinder';
}

export function supportsCameraViewfinder(): boolean {
  return (
    window.isSecureContext !== false &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  );
}

/**
 * Whether this machine has a camera at all. Before permission is granted the
 * browser still lists one placeholder entry per device kind, so a `videoinput`
 * entry is a reliable presence signal without prompting.
 */
export async function hasVideoInput(): Promise<boolean> {
  if (typeof navigator.mediaDevices?.enumerateDevices !== 'function') return false;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.some((device) => device.kind === 'videoinput');
  } catch {
    return false;
  }
}

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  if (typeof navigator.mediaDevices?.enumerateDevices !== 'function') return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === 'videoinput' && device.deviceId !== '');
}

/** Video-only: a request that also asked for audio would be refused by the desktop shell. */
export function openCameraStream(deviceId?: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' }),
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    },
    audio: false,
  });
}

export function stopStream(stream: MediaStream | null | undefined): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}

export function photoFileName(at: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `photo-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(
    at.getHours(),
  )}${pad(at.getMinutes())}${pad(at.getSeconds())}.jpg`;
}

export function fitWithin(
  width: number,
  height: number,
  maxEdge: number = CAMERA_PHOTO_MAX_EDGE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Draw a frame or decoded image once, at most `CAMERA_PHOTO_MAX_EDGE` on its long side. */
export function encodeJpeg(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
): Promise<Blob> {
  const { width, height } = fitWithin(sourceWidth, sourceHeight);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return Promise.reject(new Error('canvas is unavailable'));
  context.drawImage(source, 0, 0, width, height);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('photo could not be encoded'))),
      'image/jpeg',
      CAMERA_PHOTO_QUALITY,
    );
  });
}

/**
 * Re-encode a photo the phone's camera handed back. Besides the size cap this
 * drops the original's EXIF block, which on a phone carries the GPS position
 * the picture was taken at — a prompt is not where that should travel.
 * `createImageBitmap` applies the EXIF orientation while decoding, so the
 * re-encoded pixels stand upright without it. A format this browser cannot
 * decode (HEIC outside Safari) keeps the original rather than failing.
 */
export async function normalizeCapturedPhoto(file: File): Promise<File> {
  if (typeof createImageBitmap !== 'function') return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return file;
  }
  try {
    const blob = await encodeJpeg(bitmap, bitmap.width, bitmap.height);
    return new File([blob], photoFileName(new Date(file.lastModified || Date.now())), {
      type: 'image/jpeg',
    });
  } catch {
    return file;
  } finally {
    bitmap.close();
  }
}

export function cameraErrorMessage(err: unknown): string {
  const name = err instanceof DOMException || err instanceof Error ? err.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return window.__GEZEL__?.platform === 'darwin'
        ? 'Gezel is not allowed to use the camera. Turn it on in System Settings → Privacy & Security → Camera.'
        : 'Gezel is not allowed to use the camera. Allow camera access for Gezel and try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera is busy. Close any other app using it and try again.';
    default:
      return 'Could not start the camera.';
  }
}
