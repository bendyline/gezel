import type { SearchMedia, UnifiedSearchResult } from '@bendyline/gezel';
import { formatKnowledgeUri, mediaSpanLabel, parseKnowledgeUri } from '@bendyline/gezel';
import type {
  KnowledgeCatalogStatus,
  KnowledgeDocumentRead,
  KnowledgeDocumentSummary,
  KnowledgeTopicNode,
} from '@bendyline/gezel-client';
import type { MediaProvider } from '@bendyline/squisq';
import { LinearDocView, MediaContext } from '@bendyline/squisq-react';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { KnowledgeCatalogMark } from '../components/KnowledgeCatalogMark.js';
import { KnowledgeCatalogsDialog } from '../components/KnowledgeCatalogsDialog.js';
import { GEZEL_LIGHT_SURFACE, gezelChatTheme } from '../components/chat-theme.js';
import { queueComposerPrefill } from '../components/composer-prefill.js';
import { AuthedMediaPreview } from '../components/file-browser/FilePreview.js';
import { navigateToTab } from '../components/nav-actions.js';
import { consumeOpenKnowledge } from '../components/pending-open-knowledge.js';
import { MODEL_INVENTORY_CHANGED_EVENT, changedInventoryKey } from '../model-inventory.js';
import { Select } from '../primitives/index.js';
import { useEffectiveTheme } from '../theme.js';
import { inlineBundledAssets } from './handboek/HandboekMediaProvider.js';
import { createKnowledgeMediaProvider } from './knowledge/KnowledgeMediaProvider.js';
import '../styles/knowledge.css';

const CATALOG_KEY = 'gezel:knowledge:catalog';
const DOCUMENT_KEY = 'gezel:knowledge:document';
const EXPANDED_KEY_PREFIX = 'gezel:knowledge:expanded:';
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

function readExpandedTopics(catalogId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(EXPANDED_KEY_PREFIX + catalogId);
    const ids: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeExpandedTopics(catalogId: string, ids: Set<string>): void {
  try {
    window.localStorage.setItem(EXPANDED_KEY_PREFIX + catalogId, JSON.stringify([...ids]));
  } catch {
    /* private mode */
  }
}

/**
 * The Knowledge browser — installed reference catalogs, browsable through
 * the table of contents every `.gezk` ships. Catalog + topic rail on the
 * left, the paged document directory in the middle, the article on the
 * right with its provenance (source, license, citation) always visible.
 * Document selection stays internal to the view: encyclopedia articles
 * never flood the global navigation model.
 */
export function KnowledgeView({ initialCatalogId }: { initialCatalogId?: string } = {}) {
  const [catalogs, setCatalogs] = useState<KnowledgeCatalogStatus[] | null>(null);
  const [selectedCatalogId, setSelectedCatalogId] = useState<string | null>(() => {
    if (initialCatalogId) return initialCatalogId;
    try {
      return window.localStorage.getItem(CATALOG_KEY);
    } catch {
      return null;
    }
  });
  const [topics, setTopics] = useState<KnowledgeTopicNode[]>([]);
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  const [expandedTopics, setExpandedTopics] = useState<Set<string>>(() => new Set());
  const topicIdPrefix = useId();
  const [documents, setDocuments] = useState<KnowledgeDocumentSummary[] | null>(null);
  const [documentsTotal, setDocumentsTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(() => {
    if (initialCatalogId === 'handboek') return 'welcome';
    try {
      return window.localStorage.getItem(DOCUMENT_KEY);
    } catch {
      return null;
    }
  });
  const [mobilePane, setMobilePane] = useState<'topics' | 'list' | 'reader'>(
    selectedDocId ? 'reader' : 'topics',
  );
  const lastCatalogRef = useRef<string | null>(null);
  const [doc, setDoc] = useState<KnowledgeDocumentRead | null>(null);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<UnifiedSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  // The media hit that opened the current document: shown above the article,
  // a clip or recording starting at the matched moment.
  const [playing, setPlaying] = useState<{ documentId: string; media: SearchMedia } | null>(null);
  const [copied, setCopied] = useState(false);
  const [managingCatalogs, setManagingCatalogs] = useState(false);
  const searchTimer = useRef<number | null>(null);

  const effectiveTheme = useEffectiveTheme();
  const surface = effectiveTheme === 'light' ? GEZEL_LIGHT_SURFACE : undefined;

  // Catalog roster + queued search-intent consumption (mount only).
  useEffect(() => {
    let alive = true;
    const intent = consumeOpenKnowledge();
    if (intent) {
      setSelectedCatalogId(intent.catalogId);
      if (intent.documentId) {
        setSelectedDocId(intent.documentId);
        setPlaying(intent.media ? { documentId: intent.documentId, media: intent.media } : null);
        setMobilePane('reader');
      }
    }
    const refresh = () => {
      api
        .listKnowledgeCatalogs()
        .then((r) => {
          if (!alive) return;
          const mounted = r.catalogs.filter((c) => c.mounted);
          setCatalogs(mounted);
        })
        .catch(() => {
          if (alive) setCatalogs([]);
        });
    };
    refresh();
    const onInventoryChanged = (event: Event) => {
      if (changedInventoryKey(event) === 'knowledge') refresh();
    };
    window.addEventListener(MODEL_INVENTORY_CHANGED_EVENT, onInventoryChanged);
    const onOpenDocument = (e: Event) => {
      const detail = (
        e as CustomEvent<{ catalogId?: string; documentId?: string; media?: SearchMedia }>
      ).detail;
      if (!detail?.catalogId) return;
      setSelectedCatalogId(detail.catalogId);
      if (detail.documentId) {
        setSelectedDocId(detail.documentId);
        setPlaying(detail.media ? { documentId: detail.documentId, media: detail.media } : null);
        setMobilePane('reader');
      }
    };
    window.addEventListener('gezel:open-knowledge-document', onOpenDocument);
    return () => {
      alive = false;
      window.removeEventListener(MODEL_INVENTORY_CHANGED_EVENT, onInventoryChanged);
      window.removeEventListener('gezel:open-knowledge-document', onOpenDocument);
    };
  }, []);

  useEffect(() => {
    if (!catalogs || catalogs.some((catalog) => catalog.ref.catalogId === selectedCatalogId))
      return;
    const next = catalogs[0]?.ref.catalogId ?? null;
    if (next === selectedCatalogId) return;
    setSelectedCatalogId(next);
    setSelectedDocId(null);
    setMobilePane('topics');
  }, [catalogs, selectedCatalogId]);

  useEffect(() => {
    try {
      if (selectedCatalogId) window.localStorage.setItem(CATALOG_KEY, selectedCatalogId);
    } catch {
      /* private mode */
    }
  }, [selectedCatalogId]);

  useEffect(() => {
    if (selectedCatalogId === lastCatalogRef.current) return;
    lastCatalogRef.current = selectedCatalogId;
    if (selectedCatalogId === 'handboek' && !selectedDocId) {
      setSelectedDocId('welcome');
      setMobilePane('reader');
    }
  }, [selectedCatalogId, selectedDocId]);

  // Topic tree per catalog.
  useEffect(() => {
    if (!selectedCatalogId) return;
    let alive = true;
    setTopics([]);
    setSelectedTopicId(null);
    setExpandedTopics(readExpandedTopics(selectedCatalogId));
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
  const topicTreeNests = useMemo(() => topicTree.some((n) => n.children.length > 0), [topicTree]);
  const topicNames = useMemo(() => new Map(topics.map((t) => [t.id, t.name])), [topics]);

  // Catalog images resolve through the daemon (bearer-authed, so never a
  // bare <img src>); one provider per mounted catalog version, disposed —
  // blob URLs revoked — when either changes.
  const mediaProvider = useMemo(
    () =>
      selectedCatalogId
        ? createKnowledgeMediaProvider({
            catalogId: selectedCatalogId,
            ...(selectedCatalog?.ref.version ? { version: selectedCatalog.ref.version } : {}),
          })
        : null,
    [selectedCatalogId, selectedCatalog?.ref.version],
  );
  const fetchAsset = useCallback(
    (path: string) =>
      api.fetchKnowledgeAsset(
        selectedCatalogId ?? '',
        path,
        selectedCatalog?.ref.version ? { version: selectedCatalog.ref.version } : {},
      ),
    [selectedCatalogId, selectedCatalog?.ref.version],
  );
  const providerRef = useRef(mediaProvider);
  useEffect(() => {
    providerRef.current = mediaProvider;
    return () => providerRef.current?.dispose?.();
  }, [mediaProvider]);

  // Cross-document links inside a body are `knowledge://` references (the
  // compiler rewrites relative article links to them). Same catalog: open
  // the document here. Another installed catalog: switch to it.
  const onBodyClickCapture = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const anchor = (event.target as HTMLElement | null)?.closest?.('a[href]');
      const href = anchor?.getAttribute('href');
      if (!href) return;
      const target = parseKnowledgeUri(href);
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      if (target.catalogId === selectedCatalogId) {
        setSelectedDocId(target.documentId);
        setMobilePane('reader');
        return;
      }
      const installed = catalogs?.find(
        (c) => c.ref.catalogId === target.catalogId && c.ref.publisherId === target.publisherId,
      );
      if (installed) {
        setSelectedCatalogId(installed.ref.catalogId);
        setSelectedDocId(target.documentId);
        setMobilePane('reader');
      }
    },
    [catalogs, selectedCatalogId],
  );
  const renderedDoc = useMemo(() => {
    if (!doc) return null;
    const markdown =
      selectedCatalogId === 'handboek' ? inlineBundledAssets(doc.markdown) : doc.markdown;
    try {
      return markdownToDoc(parseMarkdown(markdown), { articleId: doc.id });
    } catch {
      return null;
    }
  }, [doc, selectedCatalogId]);

  const citation = useMemo(() => {
    if (!selectedCatalogId || !doc) return null;
    const publisherId = catalogs?.find((c) => c.ref.catalogId === selectedCatalogId)?.ref
      .publisherId;
    if (!publisherId) return null;
    return formatKnowledgeUri({ publisherId, catalogId: selectedCatalogId, documentId: doc.id });
  }, [catalogs, selectedCatalogId, doc]);

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

  const setTopicExpanded = (topicId: string, expanded: boolean) => {
    if (!selectedCatalogId || expandedTopics.has(topicId) === expanded) return;
    const next = new Set(expandedTopics);
    if (expanded) next.add(topicId);
    else next.delete(topicId);
    setExpandedTopics(next);
    writeExpandedTopics(selectedCatalogId, next);
  };

  const catalogsDialog = (
    <KnowledgeCatalogsDialog open={managingCatalogs} onOpenChange={setManagingCatalogs} />
  );

  if (catalogs !== null && catalogs.length === 0) {
    return (
      <div className="knowledge-view" data-testid="knowledge-view">
        <div className="knowledge-empty" style={{ gridColumn: '1 / -1' }}>
          <h2>Knowledge</h2>
          <p className="muted">
            No knowledge catalogs are installed yet. A catalog is a searchable, citable reference
            library — install one and your gezellen can look things up and cite their sources.
          </p>
          <button type="button" onClick={() => setManagingCatalogs(true)}>
            Browse knowledge catalogs
          </button>
        </div>
        {catalogsDialog}
      </div>
    );
  }

  // A topic's name selects it (and opens it, since picking a shelf is a
  // request to see what is on it); only the chevron folds it back up.
  const renderTopic = (node: TopicTreeNode, path: string) => {
    const hasChildren = node.children.length > 0;
    const expanded = hasChildren && expandedTopics.has(node.id);
    const childrenId = `${topicIdPrefix}-topic-${path}`;
    return (
      <li key={node.id}>
        <div
          className={`knowledge-topic-line${
            selectedTopicId === node.id ? ' knowledge-topic-line--current' : ''
          }`}
        >
          {hasChildren ? (
            <button
              type="button"
              className="knowledge-topic-toggle"
              aria-expanded={expanded}
              aria-controls={expanded ? childrenId : undefined}
              aria-label={expanded ? `Collapse ${node.name}` : `Expand ${node.name}`}
              onClick={() => setTopicExpanded(node.id, !expanded)}
            >
              <svg
                width={12}
                height={12}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2.2}
                strokeLinecap="round"
                strokeLinejoin="round"
                focusable="false"
                aria-hidden="true"
              >
                <polyline points="9 6 15 12 9 18" />
              </svg>
            </button>
          ) : (
            topicTreeNests && <span className="knowledge-topic-toggle-spacer" />
          )}
          <button
            type="button"
            className="knowledge-topic-row"
            aria-current={selectedTopicId === node.id ? 'true' : undefined}
            onClick={() => {
              setSelectedTopicId((prev) => (prev === node.id ? null : node.id));
              if (hasChildren) setTopicExpanded(node.id, true);
              setQuery('');
              setMobilePane('list');
            }}
          >
            <span>{node.name}</span>
            <span className="knowledge-topic-count">
              {node.totalDocumentCount.toLocaleString()}
            </span>
          </button>
        </div>
        {expanded && (
          <ul id={childrenId}>
            {node.children.map((child, i) => renderTopic(child, `${path}-${i}`))}
          </ul>
        )}
      </li>
    );
  };

  const hasCatalogPicker = catalogs !== null && catalogs.length > 1;
  const addCatalogKey = (
    <button
      type="button"
      className="gz-key gz-key--icon"
      aria-label="Add knowledge catalogs"
      title="Add knowledge catalogs"
      onClick={() => setManagingCatalogs(true)}
      data-testid="knowledge-add-catalog"
    >
      <svg
        width={14}
        height={14}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2.2}
        strokeLinecap="round"
        focusable="false"
        aria-hidden="true"
      >
        <line x1="12" y1="5" x2="12" y2="19" />
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </button>
  );

  return (
    <div className={`knowledge-view knowledge-view--${mobilePane}`} data-testid="knowledge-view">
      <nav className="knowledge-rail" aria-label="Knowledge catalogs and topics">
        {hasCatalogPicker && (
          <div className="knowledge-rail-catalog-row knowledge-rail-catalog-row--picker">
            <Select.Root
              value={selectedCatalogId ?? ''}
              onValueChange={(next) => {
                setSelectedCatalogId(next);
                setSelectedDocId(null);
                setMobilePane('topics');
              }}
            >
              <Select.Trigger aria-label="Catalog" className="knowledge-catalog-picker">
                <Select.Value />
              </Select.Trigger>
              <Select.Content className="knowledge-catalog-picker-menu" align="start">
                {catalogs.map((c) => {
                  const name = c.name ?? c.ref.catalogId;
                  return (
                    <Select.Item
                      key={c.ref.catalogId}
                      value={c.ref.catalogId}
                      textValue={name}
                      trailing={
                        c.documents !== undefined ? (
                          <span className="knowledge-catalog-option-count">
                            {c.documents.toLocaleString()}
                          </span>
                        ) : undefined
                      }
                    >
                      <span className="knowledge-catalog-option">
                        <KnowledgeCatalogMark catalog={c} size="sm" />
                        <span className="knowledge-catalog-option-name">{name}</span>
                      </span>
                    </Select.Item>
                  );
                })}
              </Select.Content>
            </Select.Root>
            {addCatalogKey}
          </div>
        )}
        {selectedCatalog && (
          <div className="knowledge-rail-catalog-row">
            <div className="knowledge-catalog-header">
              <KnowledgeCatalogMark catalog={selectedCatalog} size="lg" />
              <div className="knowledge-catalog-heading">
                <h2 className="knowledge-catalog-name">
                  {selectedCatalog.name ?? selectedCatalogId}
                </h2>
                <p className="knowledge-catalog-meta">
                  {selectedCatalog.documents !== undefined && (
                    <span>{`${selectedCatalog.documents.toLocaleString()} documents`}</span>
                  )}
                  <span>
                    {[
                      selectedCatalog.license,
                      selectedCatalog.ref.version ? `v${selectedCatalog.ref.version}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </p>
              </div>
            </div>
            {!hasCatalogPicker && addCatalogKey}
          </div>
        )}
        <input
          type="search"
          className="knowledge-rail-search"
          placeholder="Search this catalog…"
          aria-label="Search knowledge"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            if (e.target.value.trim()) setMobilePane('list');
          }}
        />
        <button
          type="button"
          className="knowledge-topic-row knowledge-mobile-all"
          onClick={() => {
            setSelectedTopicId(null);
            setQuery('');
            setMobilePane('list');
          }}
        >
          All documents
        </button>
        <ul className="knowledge-topics">
          {topicTree.map((node, i) => renderTopic(node, String(i)))}
        </ul>
      </nav>

      <section className="knowledge-list" aria-label="Documents">
        <button
          type="button"
          className="knowledge-nav-back knowledge-mobile-topics"
          onClick={() => setMobilePane('topics')}
        >
          ← Topics
        </button>
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
                    className={`knowledge-doc-row${r.media ? ' knowledge-doc-row--media' : ''}`}
                    aria-current={r.documentId === selectedDocId ? 'true' : undefined}
                    onClick={() => {
                      if (r.documentId) {
                        setSelectedDocId(r.documentId);
                        setPlaying(r.media ? { documentId: r.documentId, media: r.media } : null);
                        setMobilePane('reader');
                      }
                    }}
                  >
                    {r.media?.modality === 'image' && mediaProvider && (
                      <KnowledgeMediaThumb provider={mediaProvider} path={r.media.assetPath} />
                    )}
                    <span className="knowledge-doc-text">
                      <span className="knowledge-doc-title">{r.title}</span>
                      {r.media && (
                        <span className="knowledge-doc-media">{mediaSpanLabel(r.media)}</span>
                      )}
                      {r.snippet && <span className="knowledge-doc-summary">{r.snippet}</span>}
                    </span>
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
            <ul className="knowledge-doc-list">
              {(documents ?? []).map((d) => (
                <li key={d.id}>
                  <button
                    type="button"
                    className="knowledge-doc-row"
                    aria-current={d.id === selectedDocId ? 'true' : undefined}
                    onClick={() => {
                      setSelectedDocId(d.id);
                      setPlaying(null);
                      setMobilePane('reader');
                    }}
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
                {`Show more (${documentsTotal - documents.length} left)`}
              </button>
            )}
          </>
        )}
      </section>

      <section className="knowledge-reader" aria-label="Article" aria-busy={docLoading}>
        <button
          type="button"
          className="knowledge-nav-back"
          onClick={() => {
            setSelectedDocId(null);
            setMobilePane('list');
          }}
        >
          ← Documents
        </button>
        {doc ? (
          <>
            <header className="knowledge-reader-header">
              <h2>{doc.title}</h2>
              <p className="knowledge-reader-meta">
                {topicNames.get(doc.topicId) ?? doc.topicId}
                {doc.sourceUpdatedAt ? ` · snapshot ${doc.sourceUpdatedAt.slice(0, 10)}` : ''}
              </p>
            </header>
            {playing && playing.documentId === doc.id && selectedCatalogId && (
              <figure className="knowledge-reader-media">
                <AuthedMediaPreview
                  kind={playing.media.modality}
                  path={playing.media.assetPath}
                  fetchBlob={fetchAsset}
                  {...(playing.media.startMs === undefined
                    ? {}
                    : { startMs: playing.media.startMs })}
                />
                <figcaption className="muted small">
                  {mediaSpanLabel(playing.media)}
                  {attributionText(playing.media.attribution)}
                </figcaption>
              </figure>
            )}
            <div className="knowledge-reader-body" onClickCapture={onBodyClickCapture}>
              {renderedDoc && mediaProvider ? (
                <MediaContext.Provider value={mediaProvider}>
                  <LinearDocView
                    doc={renderedDoc}
                    className="gezel-article-view"
                    theme={gezelChatTheme}
                    {...(surface ? { surface } : {})}
                    imageDisplayMode="inline"
                    showCover={false}
                    linkSchemes={['knowledge']}
                  />
                </MediaContext.Provider>
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
            {docLoading ? null : docError ? (
              <p className="error">{docError}</p>
            ) : (
              <p className="placeholder">Pick a document on the left to read it here.</p>
            )}
          </div>
        )}
      </section>
      {catalogsDialog}
    </div>
  );
}

/** A photo hit's thumbnail, resolved through the catalog's media provider (bearer-authed). */
function KnowledgeMediaThumb({ provider, path }: { provider: MediaProvider; path: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void provider.resolveUrl(path).then((resolved) => {
      if (alive && resolved.startsWith('blob:')) setUrl(resolved);
    });
    return () => {
      alive = false;
    };
  }, [provider, path]);
  return url ? <img className="knowledge-doc-thumb" src={url} alt="" /> : null;
}

/** ` · CC BY 4.0, Jane Doe` from a media row's attribution, or nothing. */
function attributionText(attribution: Record<string, unknown> | undefined): string {
  if (!attribution) return '';
  const parts = ['license', 'author', 'credit']
    .map((key) => attribution[key])
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '');
  return parts.length ? ` · ${parts.join(', ')}` : '';
}
