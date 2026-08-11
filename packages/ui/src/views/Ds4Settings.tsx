import type { ConfigResponse } from '@bendyline/gezel-client';
import { useCallback, useState } from 'react';
import { api } from '../api.js';
import { Ds4ModelManager } from '../components/Ds4ModelManager.js';
import { useTotalRamBytes } from '../components/useTotalRamBytes.js';
import { detectDs4Availability } from './ds4-availability.js';

interface Props {
  config: ConfigResponse | null;
  onConfigChanged: (cfg: ConfigResponse) => void;
}

/**
 * Settings tab for DwarfStar (ds4). DwarfStar is a specialized, GPU-only
 * on-device engine that streams very large mixture-of-experts models from SSD
 * — so the panel leads with an availability banner (it can't run on Windows /
 * Intel macOS), then explains the model-specific disk and memory costs. Low-
 * level residency controls deliberately stay out of the desktop UI: the
 * service keeps SSD streaming on by default and rejects overrides that cannot
 * safely fit.
 */
export function Ds4Settings({ config }: Props) {
  const totalRamBytes = useTotalRamBytes();
  const availability = detectDs4Availability({
    externalBaseUrl: config?.ds4BaseUrl,
    totalRamBytes: totalRamBytes ?? undefined,
  });

  return (
    <div>
      <section style={{ marginBottom: '2rem' }}>
        <h3>On-device (DwarfStar - DS4)</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          DwarfStar (ds4) is an inference engine built for a handful of very large
          mixture-of-experts models — DeepSeek V4 and GLM 5.2. They may not fit in memory; DwarfStar
          keeps a bounded expert cache in RAM and reads the other experts from SSD as they are
          needed.
        </p>

        {/* ── Availability banner ── */}
        <div className="new-row" style={{ marginTop: '0.75rem', alignItems: 'center' }}>
          <span className="muted small">Status:</span>
          {availability.status === 'available' && (
            <span className="home-status-pill home-status-ok">
              engine available · {availability.backend}
            </span>
          )}
          {availability.status === 'external' && (
            <span
              className="home-status-pill home-status-warn"
              title={`Using an external ds4-server at: ${config?.ds4BaseUrl}`}
            >
              using external DwarfStar server
            </span>
          )}
          {availability.status === 'requires-cuda' && (
            <span className="home-status-pill home-status-warn">requires NVIDIA / CUDA</span>
          )}
          {availability.status === 'unavailable' && (
            <span className="home-status-pill home-status-warn">unavailable on this device</span>
          )}
        </div>
        {availability.status === 'available' && (
          <p className="muted small" style={{ marginTop: '0.4rem' }}>
            This means the engine can launch on this Mac. Each model below still has its own disk
            and memory requirements.
          </p>
        )}
        {(availability.status === 'unavailable' || availability.status === 'requires-cuda') && (
          <p className="muted small" style={{ marginTop: '0.4rem' }}>
            {availability.reason}
          </p>
        )}
      </section>

      {/* ── Catalog models ── */}
      {availability.status !== 'unavailable' && availability.status !== 'external' && (
        <section style={{ marginBottom: '2rem' }}>
          <h4>DwarfStar models</h4>
          <p className="muted small" style={{ marginTop: 0 }}>
            Lower quantizations (Q2) start faster and need less disk and memory; higher ones (Q4)
            keep more model detail but can need several times the disk space and a larger memory
            working set. Check the size on each row before starting — these downloads run to
            hundreds of gigabytes.
          </p>
          <Ds4ModelManager />
          <p className="muted small" style={{ marginTop: '1rem' }}>
            SSD streaming stays on automatically. Gezel uses the selected model's recommended expert
            cache and reduces it when necessary to preserve memory for the system and your other
            apps.
          </p>
          <Ds4EngineLogViewer />
        </section>
      )}

      {availability.status === 'external' && (
        <p className="muted small">
          This external DwarfStar server manages its own model files and memory settings. Local
          downloads are not used while the external server is configured.
        </p>
      )}
    </div>
  );
}

function Ds4EngineLogViewer() {
  const [state, setState] = useState<
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'loaded'; path: string | null; tail: string }
    | { kind: 'error'; message: string }
  >({ kind: 'idle' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      setState({ kind: 'loaded', ...(await api.getDs4Log(4096)) });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  return (
    <details style={{ marginTop: '1rem' }}>
      <summary style={{ cursor: 'pointer', userSelect: 'none' }}>
        Diagnostics{' '}
        <span className="muted small">— DwarfStar engine output retained for troubleshooting.</span>
      </summary>
      <div style={{ marginTop: '0.5rem' }}>
        <div className="new-row" style={{ alignItems: 'center', gap: '0.5rem' }}>
          <button type="button" onClick={() => void load()} disabled={state.kind === 'loading'}>
            {state.kind === 'loading' ? 'Loading…' : 'Refresh engine log'}
          </button>
          {state.kind === 'loaded' && state.path && (
            <span className="muted small" title={state.path}>
              {state.path}
            </span>
          )}
          {state.kind === 'loaded' && !state.path && (
            <span className="muted small">No DwarfStar engine log yet.</span>
          )}
        </div>
        {state.kind === 'error' && (
          <div className="muted small" style={{ marginTop: '0.5rem', color: '#ff9b9b' }}>
            Couldn't load log: {state.message}
          </div>
        )}
        {state.kind === 'loaded' && state.tail && (
          <pre
            style={{
              marginTop: '0.5rem',
              padding: '0.5rem',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.1)',
              borderRadius: 4,
              maxHeight: '18rem',
              overflow: 'auto',
              fontSize: '0.75rem',
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {state.tail}
          </pre>
        )}
        {state.kind === 'loaded' && state.path && !state.tail && (
          <div className="muted small" style={{ marginTop: '0.5rem' }}>
            The log exists but is empty. Start a DwarfStar chat, then refresh.
          </div>
        )}
      </div>
    </details>
  );
}
