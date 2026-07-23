import type { ChannelStatus, WebhookChannelConfig } from '@bendyline/gezel';
import type { ConfigResponse, SendChannelResult } from '@bendyline/gezel-client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

interface Props {
  config: ConfigResponse | null;
  onConfigChanged: (cfg: ConfigResponse) => void;
}

type ProbeState =
  | { kind: 'idle' }
  | { kind: 'probing' }
  | { kind: 'ok'; detail?: string }
  | { kind: 'fail'; error: string };

type HeaderRow = { id: string; key: string; value: string };

let headerRowSeq = 0;
function newHeaderRow(key = '', value = ''): HeaderRow {
  headerRowSeq += 1;
  return { id: `h-${headerRowSeq}`, key, value };
}

function webhookConfig(c: ConfigResponse | null): WebhookChannelConfig | undefined {
  return c?.channels?.webhook;
}

export function ChannelsSettings({ config, onConfigChanged }: Props) {
  const initial = webhookConfig(config);
  const [urlDraft, setUrlDraft] = useState(initial?.url ?? '');
  const [methodDraft, setMethodDraft] = useState<'POST' | 'PUT'>(initial?.method ?? 'POST');
  const [bodyTemplateDraft, setBodyTemplateDraft] = useState(initial?.bodyTemplate ?? '');
  const [contentTypeDraft, setContentTypeDraft] = useState(initial?.bodyContentType ?? '');
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>(() =>
    Object.entries(initial?.headers ?? {}).map(([k, v]) => newHeaderRow(k, v)),
  );
  const [bearerDraft, setBearerDraft] = useState('');
  const [basicDraft, setBasicDraft] = useState('');
  const [statuses, setStatuses] = useState<ChannelStatus[]>([]);
  const [probe, setProbe] = useState<ProbeState>({ kind: 'idle' });
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  useEffect(() => {
    const next = webhookConfig(config);
    setUrlDraft(next?.url ?? '');
    setMethodDraft(next?.method ?? 'POST');
    setBodyTemplateDraft(next?.bodyTemplate ?? '');
    setContentTypeDraft(next?.bodyContentType ?? '');
    setHeaderRows(Object.entries(next?.headers ?? {}).map(([k, v]) => newHeaderRow(k, v)));
  }, [config]);

  const refreshStatuses = useCallback(async () => {
    try {
      const res = await api.listChannels();
      setStatuses(res.channels);
    } catch {
      /* swallow — UI just won't show live state */
    }
  }, []);

  useEffect(() => {
    void refreshStatuses();
  }, [refreshStatuses]);

  const webhookStatus = statuses.find((s) => s.name === 'webhook');
  const hasBearer = config?.hasWebhookBearerToken ?? false;
  const hasBasic = config?.hasWebhookBasicAuth ?? false;

  const saveWebhook = useCallback(async () => {
    if (!urlDraft.trim()) {
      setSaveMsg('A URL is required.');
      return;
    }
    const headers: Record<string, string> = {};
    for (const row of headerRows) {
      const k = row.key.trim();
      if (!k) continue;
      headers[k] = row.value;
    }
    const webhook: WebhookChannelConfig = {
      url: urlDraft.trim(),
      method: methodDraft,
      ...(bodyTemplateDraft.trim() ? { bodyTemplate: bodyTemplateDraft } : {}),
      ...(contentTypeDraft.trim() ? { bodyContentType: contentTypeDraft.trim() } : {}),
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    };
    setSaveMsg('saving…');
    try {
      const updated = await api.updateConfig({
        channels: { ...(config?.channels ?? {}), webhook },
        ...(bearerDraft.trim() ? { webhookBearerToken: bearerDraft.trim() } : {}),
        ...(basicDraft.trim() ? { webhookBasicAuth: basicDraft.trim() } : {}),
      });
      onConfigChanged(updated);
      setBearerDraft('');
      setBasicDraft('');
      setSaveMsg('Saved.');
      void refreshStatuses();
    } catch (err) {
      setSaveMsg(`Save failed: ${(err as Error).message}`);
    }
  }, [
    urlDraft,
    methodDraft,
    bodyTemplateDraft,
    contentTypeDraft,
    headerRows,
    bearerDraft,
    basicDraft,
    config,
    onConfigChanged,
    refreshStatuses,
  ]);

  const clearWebhook = useCallback(async () => {
    setSaveMsg('clearing…');
    try {
      const updated = await api.updateConfig({
        channels: { ...(config?.channels ?? {}), webhook: undefined },
        webhookBearerToken: '',
        webhookBasicAuth: '',
      });
      onConfigChanged(updated);
      setSaveMsg('Cleared.');
      void refreshStatuses();
    } catch (err) {
      setSaveMsg(`Clear failed: ${(err as Error).message}`);
    }
  }, [config, onConfigChanged, refreshStatuses]);

  const clearBearer = useCallback(async () => {
    try {
      const updated = await api.updateConfig({ webhookBearerToken: '' });
      onConfigChanged(updated);
      setSaveMsg('Bearer token cleared.');
    } catch (err) {
      setSaveMsg(`Clear failed: ${(err as Error).message}`);
    }
  }, [onConfigChanged]);

  const clearBasic = useCallback(async () => {
    try {
      const updated = await api.updateConfig({ webhookBasicAuth: '' });
      onConfigChanged(updated);
      setSaveMsg('Basic auth cleared.');
    } catch (err) {
      setSaveMsg(`Clear failed: ${(err as Error).message}`);
    }
  }, [onConfigChanged]);

  const sendTest = useCallback(async () => {
    setProbe({ kind: 'probing' });
    try {
      const result: SendChannelResult = await api.testChannel('webhook');
      if (result.ok) setProbe({ kind: 'ok' });
      else setProbe({ kind: 'fail', error: result.error });
    } catch (err) {
      setProbe({ kind: 'fail', error: (err as Error).message });
    }
  }, []);

  return (
    <>
      <section className="provider-card">
        <h3>Webhook</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          A generic HTTP channel. Gezels (and the service itself) can POST a message here, and
          whatever listens on the other end decides what to do with it — push to your phone via
          ntfy.sh, drop into a Slack channel via an incoming webhook, forward to Discord, or relay
          through a self-hosted service.
        </p>

        <WebhookStatusLine status={webhookStatus} />

        <details className="home-section-fold" style={{ marginTop: '1rem' }} open>
          <summary className="home-section-fold-summary">
            <strong>Endpoint</strong>
          </summary>
          <div className="new-row" style={{ flexWrap: 'wrap', marginTop: '0.5rem' }}>
            <input
              type="url"
              placeholder="https://ntfy.sh/your-topic"
              value={urlDraft}
              onChange={(e) => setUrlDraft(e.target.value)}
              style={{ flex: '1 1 260px' }}
            />
            <select
              value={methodDraft}
              onChange={(e) => setMethodDraft(e.target.value as 'POST' | 'PUT')}
            >
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
            </select>
          </div>

          <div style={{ marginTop: '0.75rem' }}>
            <label className="muted small">Headers (optional)</label>
            <HeaderRowsEditor rows={headerRows} onChange={setHeaderRows} />
          </div>

          <div style={{ marginTop: '0.75rem' }}>
            <label className="muted small">
              Body template (optional — <code>{'{{message}}'}</code> is replaced with the
              JSON-encoded message text)
            </label>
            <textarea
              placeholder={'{"message":{{message}}}'}
              value={bodyTemplateDraft}
              onChange={(e) => setBodyTemplateDraft(e.target.value)}
              rows={3}
              style={{ width: '100%', fontFamily: 'var(--font-mono, monospace)' }}
            />
          </div>

          <div style={{ marginTop: '0.5rem' }}>
            <label className="muted small">Content-Type (optional, default application/json)</label>
            <input
              type="text"
              placeholder="application/json"
              value={contentTypeDraft}
              onChange={(e) => setContentTypeDraft(e.target.value)}
              style={{ width: '100%' }}
            />
          </div>
        </details>

        <details className="home-section-fold" style={{ marginTop: '1rem' }}>
          <summary className="home-section-fold-summary">
            <strong>Auth</strong>{' '}
            <span className="muted small">
              {hasBearer ? '— bearer set' : hasBasic ? '— basic set' : '— none'}
            </span>
          </summary>
          <div style={{ marginTop: '0.5rem' }}>
            <label className="muted small">Bearer token (optional)</label>
            <div className="new-row">
              <input
                type="password"
                placeholder={hasBearer ? 'Replace bearer token…' : 'Paste bearer token'}
                value={bearerDraft}
                onChange={(e) => setBearerDraft(e.target.value)}
                style={{ flex: 1 }}
              />
              {hasBearer && (
                <button type="button" onClick={() => void clearBearer()}>
                  Clear
                </button>
              )}
            </div>
          </div>
          <div style={{ marginTop: '0.5rem' }}>
            <label className="muted small">Basic auth (optional — "user:pass")</label>
            <div className="new-row">
              <input
                type="password"
                placeholder={hasBasic ? 'Replace basic auth…' : 'user:pass'}
                value={basicDraft}
                onChange={(e) => setBasicDraft(e.target.value)}
                style={{ flex: 1 }}
              />
              {hasBasic && (
                <button type="button" onClick={() => void clearBasic()}>
                  Clear
                </button>
              )}
            </div>
          </div>
        </details>

        <div className="new-row" style={{ marginTop: '1rem' }}>
          <button type="button" className="primary" onClick={() => void saveWebhook()}>
            Save webhook
          </button>
          {webhookStatus?.configured && (
            <button type="button" onClick={() => void clearWebhook()}>
              Remove
            </button>
          )}
          <button
            type="button"
            onClick={() => void sendTest()}
            disabled={!webhookStatus?.configured || probe.kind === 'probing'}
            style={{ marginLeft: 'auto' }}
          >
            {probe.kind === 'probing' ? 'Sending…' : 'Send test message'}
          </button>
        </div>

        {probe.kind === 'ok' && (
          <p className="muted small" style={{ marginTop: '0.5rem' }}>
            Test sent.
          </p>
        )}
        {probe.kind === 'fail' && (
          <p className="error small" style={{ marginTop: '0.5rem' }}>
            Test failed: {probe.error}
          </p>
        )}
        {saveMsg && (
          <p className="muted small" style={{ marginTop: '0.5rem' }}>
            {saveMsg}
          </p>
        )}

        <details className="home-section-fold" style={{ marginTop: '1rem' }}>
          <summary className="home-section-fold-summary">
            <strong>Recipes</strong>
          </summary>
          <ul className="muted small" style={{ marginTop: '0.5rem' }}>
            <li>
              <strong>ntfy.sh (mobile push):</strong> install the ntfy app on your phone, subscribe
              to a random topic like <code>gezel-xyz123</code>, and paste{' '}
              <code>https://ntfy.sh/gezel-xyz123</code> as the URL. No auth needed; leave the body
              template blank.
            </li>
            <li>
              <strong>Slack:</strong> create an incoming webhook in your workspace, paste the URL.
              Set the body template to <code>{'{"text":{{message}}}'}</code>.
            </li>
            <li>
              <strong>Discord:</strong> paste a channel webhook URL. Set the body template to{' '}
              <code>{'{"content":{{message}}}'}</code>.
            </li>
          </ul>
        </details>
      </section>
    </>
  );
}

function WebhookStatusLine({ status }: { status: ChannelStatus | undefined }) {
  if (!status || !status.configured) {
    return (
      <p className="muted small" style={{ marginTop: 0 }}>
        Not configured.
      </p>
    );
  }
  if (status.ready) {
    const url = (status.detail as { url?: string } | undefined)?.url;
    return (
      <p className="muted small" style={{ marginTop: 0 }}>
        Active{url ? ` — ${url}` : ''}
      </p>
    );
  }
  return (
    <p className="error small" style={{ marginTop: 0 }}>
      Not ready{status.lastError ? `: ${status.lastError}` : ''}
    </p>
  );
}

function HeaderRowsEditor({
  rows,
  onChange,
}: {
  rows: HeaderRow[];
  onChange: (rows: HeaderRow[]) => void;
}) {
  return (
    <div>
      {rows.map((row, i) => (
        <div
          key={row.id}
          className="new-row"
          style={{ marginTop: i === 0 ? '0.25rem' : '0.35rem' }}
        >
          <input
            type="text"
            placeholder="Header name"
            value={row.key}
            onChange={(e) => {
              const next = [...rows];
              next[i] = { ...row, key: e.target.value };
              onChange(next);
            }}
            style={{ flex: 1 }}
          />
          <input
            type="text"
            placeholder="Value"
            value={row.value}
            onChange={(e) => {
              const next = [...rows];
              next[i] = { ...row, value: e.target.value };
              onChange(next);
            }}
            style={{ flex: 2 }}
          />
          <button
            type="button"
            onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
            aria-label="Remove header"
          >
            −
          </button>
        </div>
      ))}
      <div style={{ marginTop: '0.35rem' }}>
        <button type="button" onClick={() => onChange([...rows, newHeaderRow()])}>
          + Add header
        </button>
      </div>
    </div>
  );
}
