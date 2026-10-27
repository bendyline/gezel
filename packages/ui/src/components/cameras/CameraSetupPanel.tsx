import type { CameraDevice, CameraStoragePolicy } from '@bendyline/gezel';
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { Select } from '../../primitives/index.js';
import { onRadioKeyDown } from '../../primitives/radio-keyboard.js';
import './cameras.css';

/** The camera binding's settings as the panel edits them. */
export interface CameraForm {
  device: string;
  deviceName: string;
  displayName: string;
  storage: CameraStoragePolicy;
  intervalSeconds: number;
  sensitivity: 'low' | 'medium' | 'high';
  review: boolean;
  keepDays: number;
  maxGigabytes: number;
  allowCloudModels: boolean;
}

export const DEFAULT_CAMERA_FORM: CameraForm = {
  device: '',
  deviceName: '',
  displayName: '',
  storage: 'interesting',
  intervalSeconds: 10,
  sensitivity: 'medium',
  review: true,
  keepDays: 7,
  maxGigabytes: 2,
  allowCloudModels: false,
};

export function cameraFormFromConfig(
  config: Record<string, unknown> | undefined,
  displayName?: string,
): CameraForm {
  const c = config ?? {};
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  return {
    device: typeof c.device === 'string' ? c.device : '',
    deviceName: typeof c.deviceName === 'string' ? c.deviceName : '',
    displayName: displayName ?? '',
    storage: (['interesting', 'motion', 'interval', 'latest-only'] as const).includes(
      c.storage as CameraStoragePolicy,
    )
      ? (c.storage as CameraStoragePolicy)
      : 'interesting',
    intervalSeconds: num(c.intervalSeconds, 10),
    sensitivity: (['low', 'medium', 'high'] as const).includes(c.sensitivity as 'low')
      ? (c.sensitivity as CameraForm['sensitivity'])
      : 'medium',
    review: c.review !== false,
    keepDays: num(c.keepDays, 7),
    maxGigabytes: num(c.maxGigabytes, 2),
    allowCloudModels: c.allowCloudModels === true,
  };
}

/** The binding config the daemon stores for a form. */
export function cameraConfigFromForm(form: CameraForm): Record<string, unknown> {
  return {
    device: form.device,
    ...(form.deviceName ? { deviceName: form.deviceName } : {}),
    storage: form.storage,
    intervalSeconds: Math.min(60, Math.max(1, Math.round(form.intervalSeconds))),
    sensitivity: form.sensitivity,
    review: form.review,
    keepDays: Math.min(365, Math.max(1, Math.round(form.keepDays))),
    maxGigabytes: Math.min(1000, Math.max(0.1, form.maxGigabytes)),
    allowCloudModels: form.allowCloudModels,
  };
}

const STORAGE_CHOICES: Array<{ id: CameraStoragePolicy; label: string; hint: string }> = [
  { id: 'interesting', label: 'Moments', hint: 'Only what the camera found worth noting' },
  {
    id: 'motion',
    label: 'While moving',
    hint: 'A picture every few seconds while something moves',
  },
  { id: 'interval', label: 'On a schedule', hint: 'A picture every few seconds, always' },
  { id: 'latest-only', label: 'Nothing', hint: 'Just the live view' },
];

const SENSITIVITY: Array<{ id: CameraForm['sensitivity']; label: string }> = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
];

function KeyTray<T extends string>({
  label,
  value,
  choices,
  onChange,
}: {
  label: string;
  value: T;
  choices: Array<{ id: T; label: string; hint?: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div
      className="gz-tray camera-setup-tray"
      role="radiogroup"
      aria-label={label}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => onRadioKeyDown(event)}
    >
      {choices.map((choice) => {
        const selected = choice.id === value;
        return (
          <button
            key={choice.id}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: keys in a tray are the house radio control (docs/ux.md); native inputs would duplicate the surface.
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className={`gz-key${choice.hint ? ' gz-key--stacked' : ''}${selected ? ' gz-key-active' : ''}`}
            onClick={() => onChange(choice.id)}
          >
            {choice.hint ? (
              <>
                <span className="gz-key-label">{choice.label}</span>
                <span className="gz-key-hint">{choice.hint}</span>
              </>
            ) : (
              choice.label
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Pick a camera, check the view, and say what to keep. Used when adding a
 * camera and when changing one's settings; the parent owns saving.
 */
export function CameraSetupPanel({
  form,
  onChange,
  showName = true,
}: {
  form: CameraForm;
  onChange: (next: CameraForm) => void;
  showName?: boolean;
}) {
  const [cameras, setCameras] = useState<CameraDevice[] | null>(null);
  const [discoveryError, setDiscoveryError] = useState('');
  const [ffmpegMissing, setFfmpegMissing] = useState(false);
  const [checking, setChecking] = useState(false);
  const [testUrl, setTestUrl] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState('');
  const formRef = useRef(form);
  formRef.current = form;

  const discover = useCallback(
    async (refresh = false) => {
      setChecking(true);
      try {
        const res = await api.listCameraDevices({ refresh });
        setCameras(res.cameras);
        setFfmpegMissing(!res.ffmpeg.available);
        setDiscoveryError(res.error ?? '');
        const current = formRef.current;
        if (!current.device && res.cameras[0]) {
          const first = res.cameras[0];
          onChange({
            ...current,
            device: first.id,
            deviceName: first.name,
            displayName: current.displayName || '',
          });
        }
      } catch (err) {
        setDiscoveryError(err instanceof Error ? err.message : String(err));
        setCameras([]);
      } finally {
        setChecking(false);
      }
    },
    [onChange],
  );

  useEffect(() => {
    void discover();
  }, [discover]);

  useEffect(
    () => () => {
      if (testUrl) URL.revokeObjectURL(testUrl);
    },
    [testUrl],
  );

  const takeTest = async () => {
    if (!form.device) return;
    setTesting(true);
    setTestError('');
    try {
      const blob = await api.probeCamera(form.device);
      setTestUrl(URL.createObjectURL(blob));
    } catch (err) {
      setTestError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  const set = <K extends keyof CameraForm>(key: K, value: CameraForm[K]) =>
    onChange({ ...form, [key]: value });
  const savesPictures = form.storage === 'motion' || form.storage === 'interval';
  const known = cameras?.find((c) => c.id === form.device);

  return (
    <div className="camera-setup">
      {ffmpegMissing ? (
        <div className="camera-setup-notice">
          <strong>Gezel needs ffmpeg to read a camera.</strong>
          <p className="small">
            Install it, then check again: on Windows run <code>winget install ffmpeg</code>, on
            macOS <code>brew install ffmpeg</code>, on Linux use your package manager.
          </p>
          <button type="button" onClick={() => void discover(true)} disabled={checking}>
            {checking ? 'Checking…' : 'Check again'}
          </button>
        </div>
      ) : null}

      <div className="gz-connector-field">
        <span className="gz-connector-field-label">Camera</span>
        <span className="gz-connector-field-control camera-setup-device">
          {cameras === null ? (
            <span className="muted small">Looking for cameras…</span>
          ) : cameras.length === 0 ? (
            <span className="muted small">{discoveryError || 'No camera was found.'}</span>
          ) : (
            <Select.Root
              value={form.device}
              onValueChange={(id) => {
                const cam = cameras.find((c) => c.id === id);
                onChange({ ...form, device: id, deviceName: cam?.name ?? '' });
                setTestUrl(null);
              }}
            >
              <Select.Trigger className="camera-setup-select" aria-label="Camera">
                <Select.Value placeholder="Pick a camera" />
              </Select.Trigger>
              <Select.Content>
                {cameras.map((camera) => (
                  <Select.Item key={camera.id} value={camera.id}>
                    {camera.name}
                  </Select.Item>
                ))}
                {form.device && !known ? (
                  <Select.Item value={form.device}>
                    {form.deviceName || 'This camera'} (not connected)
                  </Select.Item>
                ) : null}
              </Select.Content>
            </Select.Root>
          )}
          {cameras && cameras.length > 0 ? (
            <button
              type="button"
              onClick={() => void takeTest()}
              disabled={!form.device || testing}
            >
              {testing ? 'Looking…' : 'Take a test picture'}
            </button>
          ) : null}
        </span>
      </div>
      {testUrl ? (
        <img className="camera-setup-test" src={testUrl} alt="Test from the camera" />
      ) : null}
      {testError ? <p className="error small">{testError}</p> : null}

      {showName ? (
        <div className="gz-connector-field">
          <label className="gz-connector-field-label" htmlFor="camera-setup-name">
            Name
          </label>
          <span className="gz-connector-field-control">
            <input
              id="camera-setup-name"
              value={form.displayName}
              placeholder="Mud room"
              onChange={(e) => set('displayName', e.target.value)}
            />
          </span>
        </div>
      ) : null}

      <div className="camera-setup-group">
        <span className="gz-connector-field-label">What to keep</span>
        <KeyTray
          label="What to keep"
          value={form.storage}
          choices={STORAGE_CHOICES}
          onChange={(v) => set('storage', v)}
        />
      </div>

      {savesPictures ? (
        <div className="gz-connector-field">
          <label className="gz-connector-field-label" htmlFor="camera-setup-interval">
            A picture every {form.intervalSeconds} second{form.intervalSeconds === 1 ? '' : 's'}
          </label>
          <span className="gz-connector-field-control">
            <input
              id="camera-setup-interval"
              type="range"
              min={1}
              max={60}
              step={1}
              value={form.intervalSeconds}
              onChange={(e) => set('intervalSeconds', Number(e.target.value))}
            />
          </span>
        </div>
      ) : null}

      <div className="camera-setup-group">
        <span className="gz-connector-field-label">Motion sensitivity</span>
        <KeyTray
          label="Motion sensitivity"
          value={form.sensitivity}
          choices={SENSITIVITY}
          onChange={(v) => set('sensitivity', v)}
        />
      </div>

      <label className="camera-setup-check">
        <input
          type="checkbox"
          checked={form.review}
          onChange={(e) => set('review', e.target.checked)}
        />
        <span>
          <strong>Recognize what's happening</strong>
          <span className="muted small">
            When something moves, the on-device image reader looks at it. Lookouts that ask a
            question need this.
          </span>
        </span>
      </label>

      {savesPictures ? (
        <div className="camera-setup-row">
          <label className="small">
            Keep pictures for
            <input
              type="number"
              min={1}
              max={365}
              value={form.keepDays}
              onChange={(e) => set('keepDays', Number(e.target.value))}
            />
            days, up to
            <input
              type="number"
              min={0.1}
              max={1000}
              step={0.5}
              value={form.maxGigabytes}
              onChange={(e) => set('maxGigabytes', Number(e.target.value))}
            />
            GB
          </label>
        </div>
      ) : null}

      <label className="camera-setup-check">
        <input
          type="checkbox"
          checked={form.allowCloudModels}
          onChange={(e) => set('allowCloudModels', e.target.checked)}
        />
        <span>
          <strong>Let cloud AI see these pictures</strong>
          <span className="muted small">
            Off: only gezellen running on this computer may look at this camera. Pictures are saved
            on this computer either way.
          </span>
        </span>
      </label>
    </div>
  );
}
