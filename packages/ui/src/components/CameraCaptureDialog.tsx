import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog, Select } from '../primitives/index.js';
import {
  cameraErrorMessage,
  encodeJpeg,
  listCameras,
  openCameraStream,
  photoFileName,
  stopStream,
} from './camera-photo.js';
import './CameraCaptureDialog.css';

const CAMERA_PREFERENCE_KEY = 'gezel.composer.camera';

type Phase =
  | { kind: 'starting' }
  | { kind: 'live' }
  | { kind: 'review'; photo: File; url: string }
  | { kind: 'error'; message: string };

export interface CameraCaptureDialogProps {
  open: boolean;
  onClose: () => void;
  /** Store the photo and insert it into the draft. Rejecting keeps the dialog open on the review. */
  onCapture: (photo: File) => Promise<void>;
}

function playPreview(video: HTMLVideoElement, stream: MediaStream): void {
  if (video.srcObject === stream) return;
  video.srcObject = stream;
  try {
    void Promise.resolve(video.play()).catch(() => {});
  } catch {
    // autoPlay starts it anyway once the element can play.
  }
}

function rememberedCamera(): string | undefined {
  try {
    return window.localStorage.getItem(CAMERA_PREFERENCE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function rememberCamera(deviceId: string): void {
  try {
    window.localStorage.setItem(CAMERA_PREFERENCE_KEY, deviceId);
  } catch {
    // A per-viewer convenience; losing it only means the default camera next time.
  }
}

/**
 * The desktop path for the composer's Take photo key: a live preview, one
 * shutter press, and a still to keep or retake. The camera runs only while
 * the preview is on screen — it stops on capture and on close, so the
 * indicator light never outlives what the person can see.
 */
export function CameraCaptureDialog({ open, onClose, onCapture }: CameraCaptureDialogProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const shutterRef = useRef<HTMLButtonElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const generationRef = useRef(0);
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' });
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | undefined>(() => rememberedCamera());
  const [inserting, setInserting] = useState(false);
  const [insertError, setInsertError] = useState<string | null>(null);

  // Radix mounts the dialog's portal a commit after `open` turns true, so the
  // stream can be ready before or after the <video> exists; whichever comes
  // second connects them.
  const attachVideo = useCallback((video: HTMLVideoElement | null) => {
    videoRef.current = video;
    if (video && streamRef.current) playPreview(video, streamRef.current);
  }, []);

  const release = useCallback(() => {
    generationRef.current += 1;
    stopStream(streamRef.current);
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const start = useCallback(
    async (requested: string | undefined) => {
      release();
      const generation = generationRef.current;
      setPhase({ kind: 'starting' });
      setInsertError(null);
      let stream: MediaStream;
      try {
        stream = await openCameraStream(requested).catch((err: unknown) => {
          // A remembered camera that has since been unplugged: fall back to
          // whichever one the system offers rather than reporting no camera.
          const name = err instanceof Error || err instanceof DOMException ? err.name : '';
          if (requested && (name === 'OverconstrainedError' || name === 'NotFoundError')) {
            return openCameraStream();
          }
          throw err;
        });
      } catch (err) {
        if (generation === generationRef.current) {
          setPhase({ kind: 'error', message: cameraErrorMessage(err) });
        }
        return;
      }
      if (generation !== generationRef.current) {
        stopStream(stream);
        return;
      }
      streamRef.current = stream;
      const active = stream.getVideoTracks()[0]?.getSettings().deviceId;
      if (active) setDeviceId(active);
      // Labels are only readable once permission is granted, which the
      // stream above just proved.
      setCameras(await listCameras().catch(() => []));
      if (generation !== generationRef.current) return;
      if (videoRef.current) playPreview(videoRef.current, stream);
      setPhase({ kind: 'live' });
    },
    [release],
  );

  useEffect(() => {
    if (!open) return;
    void start(rememberedCamera());
    return release;
  }, [open, release, start]);

  useEffect(() => {
    if (phase.kind !== 'review') return;
    return () => URL.revokeObjectURL(phase.url);
  }, [phase]);

  const takePhoto = useCallback(async () => {
    const video = videoRef.current;
    if (!video || video.videoWidth < 1 || video.videoHeight < 1) return;
    try {
      const blob = await encodeJpeg(video, video.videoWidth, video.videoHeight);
      const photo = new File([blob], photoFileName(), { type: 'image/jpeg' });
      release();
      setPhase({ kind: 'review', photo, url: URL.createObjectURL(blob) });
    } catch {
      setPhase({ kind: 'error', message: 'Could not capture a photo from the camera.' });
    }
  }, [release]);

  const keepPhoto = useCallback(async () => {
    if (phase.kind !== 'review') return;
    setInserting(true);
    setInsertError(null);
    try {
      await onCapture(phase.photo);
      onClose();
    } catch (err) {
      setInsertError(err instanceof Error ? err.message : 'Could not insert that photo.');
    } finally {
      setInserting(false);
    }
  }, [onCapture, onClose, phase]);

  const switchCamera = useCallback(
    (next: string) => {
      rememberCamera(next);
      setDeviceId(next);
      void start(next);
    },
    [start],
  );

  // The shutter is disabled while the camera starts, so the dialog opens with
  // focus on Cancel. Hand it to the shutter once there is something to shoot,
  // so Space or Enter takes the picture — unless the person is in the camera
  // picker they just used.
  useEffect(() => {
    if (phase.kind !== 'live') return;
    const active = document.activeElement;
    if (active?.closest('.camera-capture-device')) return;
    shutterRef.current?.focus();
  }, [phase.kind]);

  const reviewing = phase.kind === 'review';
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className="camera-capture-dialog" aria-describedby={undefined}>
          <Dialog.Title asChild>
            <h3>Take a photo</h3>
          </Dialog.Title>
          <div className="camera-capture-frame" data-phase={phase.kind}>
            <video
              ref={attachVideo}
              className="camera-capture-video"
              autoPlay
              muted
              playsInline
              hidden={phase.kind !== 'live' && phase.kind !== 'starting'}
              aria-label="Camera preview"
            />
            {phase.kind === 'starting' && (
              <p className="camera-capture-status" aria-live="polite">
                Starting the camera…
              </p>
            )}
            {phase.kind === 'error' && (
              <p className="camera-capture-status camera-capture-status-error" role="alert">
                {phase.message}
              </p>
            )}
            {reviewing && (
              <img
                className="camera-capture-still"
                src={phase.url}
                alt="What the camera captured"
              />
            )}
          </div>
          {insertError && (
            <p className="gz-dialog-error" role="alert">
              {insertError}
            </p>
          )}
          <div className="camera-capture-controls">
            {cameras.length > 1 && !reviewing ? (
              <Select.Root
                value={deviceId ?? ''}
                onValueChange={switchCamera}
                disabled={phase.kind === 'starting'}
              >
                <Select.Trigger className="camera-capture-device" aria-label="Camera">
                  <Select.Value placeholder="Camera" />
                </Select.Trigger>
                <Select.Content>
                  {cameras.map((camera, index) => (
                    <Select.Item key={camera.deviceId} value={camera.deviceId}>
                      {camera.label || `Camera ${index + 1}`}
                    </Select.Item>
                  ))}
                </Select.Content>
              </Select.Root>
            ) : (
              <span />
            )}
            <Dialog.Actions>
              <button type="button" onClick={onClose}>
                Cancel
              </button>
              {reviewing ? (
                <>
                  <button type="button" onClick={() => void start(deviceId)} disabled={inserting}>
                    Retake
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void keepPhoto()}
                    disabled={inserting}
                    aria-busy={inserting}
                  >
                    {inserting ? 'Inserting…' : 'Insert photo'}
                  </button>
                </>
              ) : phase.kind === 'error' ? (
                <button type="button" className="primary" onClick={() => void start(deviceId)}>
                  Try again
                </button>
              ) : (
                <button
                  type="button"
                  className="primary"
                  ref={shutterRef}
                  onClick={() => void takePhoto()}
                  disabled={phase.kind !== 'live'}
                  data-testid="camera-shutter"
                >
                  Take photo
                </button>
              )}
            </Dialog.Actions>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
