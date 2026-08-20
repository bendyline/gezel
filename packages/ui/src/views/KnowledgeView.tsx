import type { UnifiedSearchResult } from '@bendyline/gezel';
import { formatKnowledgeUri } from '@bendyline/gezel';
import type {
  KnowledgeCatalogStatus,
  KnowledgeDocumentMeta,
  KnowledgeTopicNode,
} from '@bendyline/gezel-client';
import { LinearDocView } from '@bendyline/squisq-react';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { queueComposerPrefill } from '../components/ChatComposer.js';
import { GEZEL_LIGHT_SURFACE, gezelChatTheme } from '../components/chat-theme.js';
import { navigateToTab } from '../components/nav-actions.js';
import { consumeOpenKnowledge } from '../components/pending-open-knowledge.js';
import { requestSettingsSection } from '../settings-nav.js';
import { useEffectiveTheme } from '../theme.js';
import '../styles/17-knowledge.css';

const CATALOG_KEY = 'gezel:knowledge:catalog';
const DOCUMENT_KEY = 'gezel:knowledge:document';
const PAGE_SIZE = 50;

interface TopicTreeNode extends KnowledgeTopicNode {
  children: TopicTreeNode[];
}

function foldTopics(topics: KnowledgeTopicNode[]): TopicTreeNode[] {
  const byId = new Map<string, TopicTreeNode>(
    topics.map((t) => [t.id, { ...t, children: [] as TopicTreeNode[] }]),
  );
  const roots: TopicTreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

/**
 * The Knowledge browser — installed reference catalogs, browsable through
 * the table of contents every `.gezk` ships. Catalog + topic rail on the
 * left, the paged document directory in the middle, the article on the
 * right with its provenance (source, license, citation) always visible.
 * Document selection stays internal to the view: encyclopedia articles
 * never flood the global navigation model.
 */
export function KnowledgeView() {
  const [catalogs, setCatalogs] = useState<KnowledgeCatalogStatus[] | null>(null);
  const [selectedCatalogId, setSelectedCatalogId] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(CATALOG_KEY);
    } catch {
      return null;
    }
  });
  const [topics, setTopics] = useState<KnowledgeTopicNode[]>([]);
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [documents, setDocuments] = useState<KnowledgeDocumentMeta[] | null>(null);
  const [documentsTotal, setDocumentsTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(DOCUMENT_KEY);
    } catch {
      return null;
    }
  });
  const [doc, setDoc] = useState<(KnowledgeDocumentMeta & { markdown: string }) | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<UnifiedSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [copied, setCopied] = useState(false);
  const searchTimer = useRef<number | null>(null);

  const effectiveTheme = useEffectiveTheme();
  const surface = effectiveTheme === 'light' ? GEZEL_LIGHT_SURFACE : undefined;

  // Catalog roster + queued search-intent consumption (mount only).
  useEffect(() => {
    let alive = true;
    const intent = consumeOpenKnowledge();
    if (intent) {
      setSelectedCatalogId(intent.catalogId);
      if (intent.documentId) setSelectedDocId(intent.documentId);
    }
    const refresh = () => {
      api
        .listKnowledgeCatalogs()
        .then((r) => {
          if (!alive) return;
          const mounted = r.catalogs.filter((c) => c.mounted);
          setCatalogs(mounted);
          setSelectedCatalogId(
            (prev) =>
              (prev && mounted.some((c) => c.ref.catalogId === prev) ? prev : null) ??
              mounted[0]?.ref.catalogId ??
              null,
          );
        })
        .catch(() => {
          if (alive) setCatalogs([]);
        });
    };
    refresh();
    window.addEventListener('gezel:knowledge-catalogs-updated', refresh);
    const onOpenDocument = (e: Event) => {
      const detail = (e as CustomEvent<{ catalogId?: string; documentId?: string }>).detail;
      if (!detail?.catalogId) return;
      setSelectedCatalogId(detail.catalogId);
      if (detail.documentId) setSelectedDocId(detail.documentId);
    };
    window.addEventListener('gezel:open-knowledge-document', onOpenDocument);
    return () => {
      alive = false;
      window.removeEventListener('gezel:knowledge-catalogs-updated', refresh);
      window.removeEventListener('gezel:open-knowledge-document', onOpenDocument);
    };
  }, []);

  useEffect(() => {
    try {
      if (selectedCatalogId) window.localStorage.setItem(CATALOG_KEY, selectedCatalogId);
    } catch {
      /* private mode */
    }
  }, [selectedCatalogId]);

  // Topic tree per catalog.
  useEffect(() => {
    if (!selectedCatalogId) return;
    let alive = true;
    setTopics([]);
    setSelectedTopicId(null);
    api
      .knowledgeCatalogTopics(selectedCatalogId)
      .then((r) => {
        if (alive) setTopics(r.topics);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [selectedCatalogId]);

  // Document directory for the selected topic (or the whole catalog).
  const loadDocuments = useCallback(
    async (offset: number) => {
      if (!selectedCatalogId) return;
      const page = await api.knowledgeCatalogDocuments(selectedCatalogId, {
        ...(selectedTopicId ? { topicId: selectedTopicId } : {}),
        offset,
        limit: PAGE_SIZE,
      });
      setDocumentsTotal(page.total);
      setDocuments((prev) =>
        offset === 0 || !prev ? page.documents : [...prev, ...page.documents],
      );
    },
    [selectedCatalogId, selectedTopicId],
  );

  useEffect(() => {
    setDocuments(null);
    loadDocuments(0).catch(() => setDocuments([]));
  }, [loadDocuments]);

  // The selected article body.
  useEffect(() => {
    if (!selectedCatalogId || !selectedDocId) {
      setDoc(null);
      return;
    }
    let alive = true;
    setDocLoading(true);
    setDocError(null);
    api
      .readKnowledgeDocument(selectedCatalogId, selectedDocId)
      .then((d) => {
        if (alive) setDoc(d);
      })
      .catch((err) => {
        if (alive) setDocError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setDocLoading(false);
      });
    try {
      window.localStorage.setItem(DOCUMENT_KEY, selectedDocId);
    } catch {
      /* private mode */
    }
    return () => {
      alive = false;
    };
  }, [selectedCatalogId, selectedDocId]);

  // Search answers the keystroke: the results phase mounts on the debounced
  // query, showing "Searching…" until the daemon responds.
  useEffect(() => {
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    const q = query.trim();
    if (!q) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchTimer.current = window.setTimeout(() => {
      api
        .searchKnowledge({
          query: q,
          maxResults: 20,
          ...(selectedCatalogId ? { catalogs: [selectedCatalogId] } : {}),
        })
        .then((r) => {
          setSearchResults(r.results);
        })
        .catch(() => {
          setSearchResults([]);
        })
        .finally(() => setSearching(false));
    }, 250);
    return () => {
      if (searchTimer.current) window.clearTimeout(searchTimer.current);
    };
  }, [query, selectedCatalogId]);

  const selectedCatalog = useMemo(
    () => catalogs?.find((c) => c.ref.catalogId === selectedCatalogId) ?? null,
    [catalogs, selectedCatalogId],
  );
  const topicTree = useMemo(() => foldTopics(topics), [topics]);
  const topicNames = useMemo(() => new Map(topics.map((t) => [t.id, t.name])), [topics]);
  const renderedDoc = useMemo(() => {
    if (!doc) return null;
    try {
      return markdownToDoc(parseMarkdown(doc.markdown), { articleId: doc.id });
    } catch {
      return null;
    }
  }, [doc]);

  const citation = useMemo(
    () =>
      selectedCatalogId && doc
        ? formatKnowledgeUri({ catalogId: selectedCatalogId, documentId: doc.id })
        : null,
    [selectedCatalogId, doc],
  );

  const copyCitation = useCallback(() => {
    if (!citation) return;
    void navigator.clipboard?.writeText(citation).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  }, [citation]);

  const askAGezel = useCallback(() => {
    if (!citation || !doc) return;
    queueComposerPrefill(
      'default',
      `I'm reading "${doc.title}" (${citation}). Can you help me with a question about it?\n\n`,
    );
    navigateToTab({ kind: 'project', id: 'default' });
  }, [citation, doc]);

  const openSettings = useCallback(() => {
    requestSettingsSection('knowledge');
    navigateToTab({ kind: 'area', area: 'settings' });
  }, []);

  if (catalogs !== null && catalogs.length === 0) {
    return (
      <div className="knowledge-view" data-testid="knowledge-view">
        <div className="knowledge-empty" style={{ gridColumn: '1 / -1' }}>
          <h2>Knowledge</h2>
          <p className="muted">
            No knowledge catalogs are installed yet. A catalog is a searchable, citable reference
            library — install one and your gezellen can look things up and cite their sources.
          </p>
          <button type="button" onClick={openSettings}>
            Open knowledge settings
          </button>
        </div>
      </div>
    );
  }

  const renderTopic = (node: TopicTreeNode, depth: number) => (
    <li key={node.id}>
      <button
        type="button"
        className="knowledge-topic-row"
        aria-current={selectedTopicId === node.id ? 'true' : undefined}
        onClick={() => {
          setSelectedTopicId((prev) => (prev === node.id ? null : node.id));
          setQuery('');
        }}
      >
        <span>{node.name}</span>
        <span className="knowledge-topic-count">{node.documentCount}</span>
      </button>
      {node.children.length > 0 && (
        <ul>{node.children.map((child) => renderTopic(child, depth + 1))}</ul>
      )}
    </li>
  );

  return (
    <div className="knowledge-view" data-testid="knowledge-view">
      <nav className="knowledge-rail" aria-label="Knowledge catalogs and topics">
        {catalogs && catalogs.length > 1 && (
          <select
            aria-label="Catalog"
            value={selectedCatalogId ?? ''}
            onChange={(e) => {
              setSelectedCatalogId(e.target.value);
              setSelectedDocId(null);
            }}
          >
            {catalogs.map((c) => (
              <option key={c.ref.catalogId} value={c.ref.catalogId}>
                {c.name ?? c.ref.catalogId}
              </option>
            ))}
          </select>
        )}
        {selectedCatalog && (
          <>
            <h2 className="knowledge-catalog-name">{selectedCatalog.name ?? selectedCatalogId}</h2>
            <p className="knowledge-catalog-meta">
              {selectedCatalog.documents ?? '?'} documents · {selectedCatalog.license ?? ''}
              {selectedCatalog.ref.version ? ` · v${selectedCatalog.ref.version}` : ''}
            </p>
          </>
        )}
        <input
          type="search"
          className="knowledge-rail-search"
          placeholder="Search this catalog…"
          aria-label="Search knowledge"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <ul className="knowledge-topics">{topicTree.map((node) => renderTopic(node, 0))}</ul>
      </nav>

      <section className="knowledge-list" aria-label="Documents">
        {query.trim() ? (
          <>
            <div className="knowledge-list-header">Search results</div>
            {searching && (
              <p className="muted small" style={{ padding: '0 1rem' }}>
                Searching…
              </p>
            )}
            {!searching && searchResults?.length === 0 && (
              <p className="muted small" style={{ padding: '0 1rem' }}>
                No results for “{query.trim()}”.
              </p>
            )}
            <ul className="knowledge-doc-list">
              {(searchResults ?? []).map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    className="knowledge-doc-row"
                    aria-current={r.documentId === selectedDocId ? 'true' : undefined}
                    onClick={() => {
                      if (r.documentId) setSelectedDocId(r.documentId);
                    }}
                  >
                    <span className="knowledge-doc-title">{r.title}</span>
                    {r.snippet && <span className="knowledge-doc-summary">{r.snippet}</span>}
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <div className="knowledge-list-header">
              {selectedTopicId ? (topicNames.get(selectedTopicId) ?? 'Documents') : 'All documents'}
            </div>
            {documents === null && (
              <p className="muted small" style={{ padding: '0 1rem' }}>
                Loading…
              </p>
            )}
            <ul className="knowledge-doc-list">
              {(documents ?? []).map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    className="knowledge-doc-row"
                    aria-current={d.id === selectedDocId ? 'true' : undefined}
                    onClick={() => setSelectedDocId(d.id)}
                  >
                    <span className="knowledge-doc-title">{d.title}</span>
                    {d.summary && <span className="knowledge-doc-summary">{d.summary}</span>}
                  </button>
                </li>
              ))}
            </ul>
            {documents && documents.length < documentsTotal && (
              <button
                type="button"
                className="knowledge-list-more"
                disabled={loadingMore}
                onClick={() => {
                  setLoadingMore(true);
                  void loadDocuments(documents.length).finally(() => setLoadingMore(false));
                }}
              >
                {loadingMore ? 'Loading…' : `Show more (${documentsTotal - documents.length} left)`}
              </button>
            )}
          </>
        )}
      </section>

      <section className="knowledge-reader" aria-label="Article">
        {doc ? (
          <>
            <header className="knowledge-reader-header">
              <h2>{doc.title}</h2>
              <p className="knowledge-reader-meta">
                {topicNames.get(doc.topicId) ?? doc.topicId}
                {doc.sourceUpdatedAt ? ` · snapshot ${doc.sourceUpdatedAt.slice(0, 10)}` : ''}
              </p>
            </header>
            <div className="knowledge-reader-body">
              {renderedDoc ? (
                <LinearDocView
                  doc={renderedDoc}
                  className="gezel-article-view"
                  theme={gezelChatTheme}
                  {...(surface ? { surface } : {})}
                  imageDisplayMode="inline"
                  showCover={false}
                />
              ) : (
                <p className="error small">This document could not be rendered.</p>
              )}
            </div>
            <footer className="knowledge-reader-footer">
              <span>
                {selectedCatalog?.license ?? ''}
                {doc.attribution?.text ? ` · ${doc.attribution.text}` : ''}
              </span>
              <span className="knowledge-footer-actions">
                <button type="button" onClick={copyCitation}>
                  {copied ? 'Copied' : 'Copy citation'}
                </button>
                {doc.sourceUrl && (
                  <a href={doc.sourceUrl} target="_blank" rel="noreferrer">
                    <button type="button">Open source</button>
                  </a>
                )}
                <button type="button" onClick={askAGezel}>
                  Ask a gezel about this
                </button>
              </span>
            </footer>
          </>
        ) : (
          <div className="knowledge-empty">
            {docLoading ? (
              <p className="muted">Loading…</p>
            ) : docError ? (
              <p className="error">{docError}</p>
            ) : (
              <p className="placeholder">Pick a document on the left to read it here.</p>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
