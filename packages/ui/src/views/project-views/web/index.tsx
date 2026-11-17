import {
  type ChatEventEnvelope,
  type WebPageEntry,
  type WebPagesListResponse,
  normalizePageUrl,
} from '@bendyline/gezel';
import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { apiErrorMessage } from '../../../api-error.js';
import { api } from '../../../api.js';
import { ReportDocument } from '../../../components/ReportDocument.js';
import { Select } from '../../../primitives/index.js';
import { forEachEvent } from '../../../reconnecting-stream.js';
import { formatAbsoluteTime, formatRelativeTime } from '../../../relative-time.js';
import { streamSharedProjectChatEvents } from '../../../shared-chat-events.js';
import type { ProjectViewProps } from '../types.js';
import '../../../styles/reports-view.css';
import '../../../styles/web-pages-view.css';

/** The record's screenshots section; the Screenshots key shows those pictures instead. */
function withoutScreenshots(content: string): string {
  return content.replace(/\n## How the page looked[\s\S]*$/, '\n');
}

function isSaved(p: WebPageEntry): boolean {
  return Boolean(p.path) && p.state !== 'gone';
}

/** A short line under a page's title in the list. */
function metaLine(p: WebPageEntry): string {
  if (p.state === 'queued' && !p.path) return 'Waiting to be saved';
  if ((p.state === 'failed' || p.state === 'blocked') && !p.path)
    return p.reason ?? 'Could not be saved';
  if (p.state === 'skipped') return p.reason ?? 'Found, not saved';
  const changed = p.changedAt ? Date.parse(p.changedAt) : null;
  if (changed && Date.now() - changed < 7 * 24 * 3_600_000 && p.changedAt !== p.firstSeenAt) {
    return `Changed ${formatRelativeTime(changed, { style: 'long' })}`;
  }
  return p.capturedAt
    ? `Checked ${formatRelativeTime(Date.parse(p.capturedAt), { style: 'long' })}`
    : 'Saved';
}

/**
 * The Web pages view: the offline copies of the web pages this project
 * follows, by site, beside a reader. What a page says, how it looked, and when
 * it last changed — read from the saved copy, never from the web. A link to
 * another saved page opens it here; any other link opens in the browser.
 */
export default function WebPagesProjectView({
  projectId,
  compact,
  onSelectPath,
  setInspectorExtras,
}: ProjectViewProps) {
  const [data, setData] = useState<WebPagesListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [mode, setMode] = useState<'reading' | 'screenshots'>('reading');
  const [showFound, setShowFound] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveUrl, setSaveUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [continuing, setContinuing] = useState(false);

  const load = useCallback(
    (select?: string) =>
      api
        .listWebPages(projectId)
        .then((res) => {
          setData(res);
          setError(null);
          if (select) setChosen(select);
        })
        .catch((e: unknown) => setError(apiErrorMessage(e))),
    [projectId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    setInspectorExtras(null);
    return () => setInspectorExtras(null);
  }, [setInspectorExtras]);

  // A pass that saved or removed pages refreshes the list; never polled.
  useEffect(() => {
    const ctrl = new AbortController();
    void forEachEvent(
      streamSharedProjectChatEvents({
        url: api.projectEventsUrl(projectId),
        headers: api.authHeader(),
        signal: ctrl.signal,
        fetch: api.getFetch(),
      }),
      (env) => {
        const ev = (env as ChatEventEnvelope).event;
        if (ev.type === 'connector_synced' && ev.connectorType === 'website') {
          setContinuing(Boolean(ev.continuing));
          void load();
        }
      },
    );
    return () => ctrl.abort();
  }, [projectId, load]);

  const pages = data?.pages ?? [];
  const found = pages.filter((p) => p.state === 'skipped');
  const visible = pages.filter((p) => p.state !== 'skipped' && p.state !== 'gone');
  const listed = showFound ? [...visible, ...found] : visible;
  const savedByUrl = useMemo(() => new Map(pages.filter(isSaved).map((p) => [p.url, p])), [pages]);
  const current = listed.find((p) => p.url === chosen) ?? listed.find(isSaved) ?? listed[0] ?? null;
  const groups = useMemo(() => {
    const bySite = new Map<string, WebPageEntry[]>();
    for (const p of listed) bySite.set(p.site, [...(bySite.get(p.site) ?? []), p]);
    return [...bySite.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [listed]);

  const openUrl = useCallback(
    (href: string): boolean => {
      const url = normalizePageUrl(href);
      const page = url ? savedByUrl.get(url) : undefined;
      if (!page) return false;
      setChosen(page.url);
      setMode('reading');
      return true;
    },
    [savedByUrl],
  );

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const url = saveUrl.trim();
    if (!url) return;
    setSaving(true);
    setNote(null);
    try {
      const res = await api.saveWebPage(projectId, { url });
      setSaveUrl('');
      setSaveOpen(false);
      await load(res.page.url);
      if (!isSaved(res.page))
        setNote(res.page.reason ?? 'The page could not be saved yet. Gezel will try again.');
    } catch (e: unknown) {
      setNote(apiErrorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const bindingNotes = (data?.bindings ?? []).flatMap((b) => [
    ...(b.lastError ? [`${b.displayName}: ${b.lastError}`] : []),
    ...(b.browserUnavailableReason ? [`${b.displayName}: ${b.browserUnavailableReason}`] : []),
  ]);

  return (
    <section
      className={
        compact
          ? 'reports-view reports-view--compact web-pages-view'
          : 'reports-view web-pages-view'
      }
    >
      <header className="reports-view-header">
        {compact && listed.length > 0 ? (
          <Select.Root value={current?.url ?? ''} onValueChange={setChosen}>
            <Select.Trigger aria-label="Choose a page">
              <Select.Value />
            </Select.Trigger>
            <Select.Content>
              {listed.map((p) => (
                <Select.Item key={p.url} value={p.url}>
                  {p.title ?? p.url}
                </Select.Item>
              ))}
            </Select.Content>
          </Select.Root>
        ) : (
          <h2>Web pages</h2>
        )}
        {data?.canSave !== false && (
          <div className="gz-tray" role="toolbar" aria-label="Web pages">
            <button
              type="button"
              className="gz-key"
              aria-expanded={saveOpen}
              onClick={() => setSaveOpen((o) => !o)}
            >
              Save a page
            </button>
          </div>
        )}
      </header>
      {saveOpen && data?.canSave !== false && (
        <form className="web-pages-save" onSubmit={(e) => void save(e)}>
          <label htmlFor="web-pages-save-url">Web address</label>
          <input
            id="web-pages-save-url"
            type="url"
            inputMode="url"
            placeholder="https://example.com/page"
            value={saveUrl}
            onChange={(e) => setSaveUrl(e.target.value)}
            disabled={saving}
          />
          <button type="submit" className="gz-key" disabled={saving || !saveUrl.trim()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <p className="reports-view-note">
            Gezel visits the page once in its own browser and keeps a copy here. It does not follow
            links or refresh it on its own; add the site under Connections for that.
          </p>
        </form>
      )}
      {note && <p className="reports-view-note">{note}</p>}
      {continuing && <p className="reports-view-note">Saving more pages in the background…</p>}
      {bindingNotes.map((n) => (
        <p key={n} className="reports-view-note">
          {n}
        </p>
      ))}
      {error && <p className="reports-view-empty">Couldn’t load the saved pages: {error}</p>}
      {!error && data && visible.length === 0 && (
        <p className="reports-view-empty">
          No pages saved yet. Add a website under Connections, or save one page with Save a page.
        </p>
      )}
      {listed.length > 0 && (
        <div className="reports-view-body">
          {!compact && (
            <nav className="reports-list" aria-label="Saved web pages">
              {groups.map(([site, list]) => (
                <section key={site} className="reports-list-group">
                  <h3>{site}</h3>
                  <ul>
                    {list.map((p) => (
                      <li key={p.url}>
                        <button
                          type="button"
                          className="reports-list-item"
                          aria-current={p.url === current?.url ? 'true' : undefined}
                          title={p.url}
                          onClick={() => {
                            setChosen(p.url);
                            setMode('reading');
                          }}
                        >
                          <span className="reports-list-title">{p.title ?? p.url}</span>
                          <span
                            className={`reports-list-meta web-pages-meta web-pages-meta--${isSaved(p) ? 'saved' : p.state}`}
                          >
                            {metaLine(p)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              {found.length > 0 && (
                <button
                  type="button"
                  className="web-pages-found-toggle"
                  onClick={() => setShowFound((s) => !s)}
                >
                  {showFound
                    ? 'Hide links found but not saved'
                    : `Show ${found.length} links found but not saved`}
                </button>
              )}
            </nav>
          )}
          {current && (
            <article
              className="reports-reader web-pages-reader"
              aria-label={current.title ?? current.url}
            >
              <header className="web-pages-reader-header">
                <h3>{current.title ?? current.url}</h3>
                <a
                  href={current.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="web-pages-address"
                >
                  {current.url}
                </a>
                <p className="web-pages-facts">
                  {current.capturedAt && (
                    <span title={formatAbsoluteTime(Date.parse(current.capturedAt))}>
                      Checked{' '}
                      {formatRelativeTime(Date.parse(current.capturedAt), { style: 'long' })}
                    </span>
                  )}
                  {current.changedAt && (
                    <span title={formatAbsoluteTime(Date.parse(current.changedAt))}>
                      Last changed{' '}
                      {formatRelativeTime(Date.parse(current.changedAt), { style: 'long' })}
                    </span>
                  )}
                  {current.render === 'http' && <span>Text only</span>}
                  {current.signedIn && <span>Saved while signed in</span>}
                </p>
                {current.reason && <p className="web-pages-reason">{current.reason}</p>}
                {current.summary && (
                  <p className="web-pages-synopsis">
                    <span className="web-pages-synopsis-label">
                      Synopsis, written from the page
                    </span>
                    {current.summary}
                  </p>
                )}
                {isSaved(current) && current.screenshots.length > 0 && (
                  <div className="gz-tray" role="radiogroup" aria-label="Show the page as">
                    {(['reading', 'screenshots'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        // biome-ignore lint/a11y/useSemanticElements: keys in a tray are the house radio control (docs/ux.md); native inputs would duplicate the surface.
                        role="radio"
                        aria-checked={mode === m}
                        className={`gz-key${mode === m ? ' gz-key-active' : ''}`}
                        onClick={() => setMode(m)}
                      >
                        {m === 'reading' ? 'Reading' : 'Screenshots'}
                      </button>
                    ))}
                  </div>
                )}
              </header>
              {isSaved(current) && current.path ? (
                mode === 'screenshots' ? (
                  <Screenshots
                    projectId={projectId}
                    paths={current.screenshots}
                    title={current.title ?? current.url}
                  />
                ) : (
                  <ReportDocument
                    key={`${current.path}:${current.capturedAt ?? ''}`}
                    projectId={projectId}
                    path={current.path}
                    transformContent={withoutScreenshots}
                    onOpenUrl={openUrl}
                    onOpenPath={(path, line) => onSelectPath(path, line ? { line } : undefined)}
                  />
                )
              ) : (
                <p className="reports-view-empty">
                  {current.state === 'skipped'
                    ? 'Gezel found this link but has not saved the page. It saves the page when it needs it, or you can save it now with Save a page.'
                    : 'Not saved yet.'}
                </p>
              )}
            </article>
          )}
        </div>
      )}
    </section>
  );
}

/** The page's screenshots, top of the page first, loaded from the saved copy. */
function Screenshots({
  projectId,
  paths,
  title,
}: { projectId: string; paths: readonly string[]; title: string }) {
  const [urls, setUrls] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    const made: string[] = [];
    void (async () => {
      for (const path of paths) {
        const blob = await api.fetchProjectArtifactBlob(projectId, path).catch(() => null);
        if (cancelled || !blob) continue;
        const url = URL.createObjectURL(blob);
        made.push(url);
        setUrls((u) => [...u, url]);
      }
    })();
    return () => {
      cancelled = true;
      for (const u of made) URL.revokeObjectURL(u);
      setUrls([]);
    };
  }, [projectId, paths]);
  return (
    <div className="web-pages-shots">
      {urls.map((src, i) => (
        <img
          key={src}
          src={src}
          alt={
            i === 0
              ? `The top of ${title}, as a visitor first sees it`
              : `Further down ${title} (${i + 1})`
          }
        />
      ))}
    </div>
  );
}
