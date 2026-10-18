import type { KnowledgeDocumentSummary } from '@bendyline/gezel-client';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api.js';
import { cssAttrValue } from '../../components/chat-timeline-helpers.js';
import {
  type LetterIndexEntry,
  buildLetterIndex,
  letterKeyForDocument,
  showsLetterIndex,
} from './letter-index.js';

const PAGE_SIZE = 50;
/** How far ahead of an edge the next page starts loading. */
const EDGE_PREFETCH_MARGIN = '600px 0px';

type Edge = 'before' | 'after';

interface ListingWindow {
  /** A contiguous run of the listing, starting at position `start`; null while the first page loads. */
  documents: KnowledgeDocumentSummary[] | null;
  start: number;
  total: number;
}

/** What the next layout pass does to the scroller once the window it was planned for renders. */
type ScrollPlan =
  | { kind: 'top' }
  | { kind: 'row'; documentId: string; block: 'start' | 'reveal' }
  | { kind: 'keep'; scrollHeight: number; scrollTop: number };

const EMPTY_WINDOW: ListingWindow = { documents: null, start: 0, total: 0 };

function rowFor(scroller: HTMLElement, documentId: string): HTMLElement | null {
  return scroller.querySelector<HTMLElement>(`[data-doc-id="${cssAttrValue(documentId)}"]`);
}

/**
 * `start` puts the row at the top; `reveal` leaves a row that is already in
 * view alone and centers one that is not. Computed by hand rather than
 * scrollIntoView, which would also scroll the view's overflow-hidden
 * ancestors.
 */
function scrollRow(scroller: HTMLElement, row: HTMLElement, block: 'start' | 'reveal'): void {
  const view = scroller.getBoundingClientRect();
  const box = row.getBoundingClientRect();
  if (block === 'start') {
    scroller.scrollTop += box.top - view.top;
    return;
  }
  if (box.top >= view.top && box.bottom <= view.bottom) return;
  scroller.scrollTop += box.top - view.top - (scroller.clientHeight - box.height) / 2;
}

/**
 * The catalog's document directory as one continuous list. Pages load as
 * either edge nears, so a letter jump or a return to the open document can
 * start the window anywhere and scrolling still reaches both ends. The
 * letter index beside it stays put while the list scrolls.
 */
export function KnowledgeDocumentListing({
  catalogId,
  topicId,
  title,
  selectedDocId,
  revealKey,
  onOpen,
}: {
  catalogId: string | null;
  topicId: string | null;
  title: string;
  selectedDocId: string | null;
  /** A change asks the list to bring the open document back into view (the narrow layout showing the list again). */
  revealKey: string;
  onOpen: (documentId: string) => void;
}) {
  const [listing, setListing] = useState<ListingWindow>(EMPTY_WINDOW);
  const [loadingEdges, setLoadingEdges] = useState<ReadonlySet<Edge>>(() => new Set());
  const [initials, setInitials] = useState<LetterIndexEntry[]>([]);
  const [topIndex, setTopIndex] = useState(0);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const beforeRef = useRef<HTMLButtonElement | null>(null);
  const afterRef = useRef<HTMLButtonElement | null>(null);
  const listingRef = useRef(listing);
  listingRef.current = listing;
  const selectedRef = useRef(selectedDocId);
  selectedRef.current = selectedDocId;
  // Bumped whenever the window is replaced, so an edge page that was asked
  // for against the old window is dropped instead of spliced onto the new one.
  const generation = useRef(0);
  // Latest-wins among replacements (scope loads, letter jumps, reveals).
  const replaceSeq = useRef(0);
  const inFlight = useRef(new Set<Edge>());
  const scrollPlan = useRef<ScrollPlan | null>(null);
  const firstLoad = useRef(true);
  const pendingReveal = useRef<string | null>(null);

  const scope = useMemo(() => (topicId ? { topicId } : {}), [topicId]);

  const replaceWindow = useCallback(
    async (
      request: { offset: number } | { around: string },
      plan: (documents: KnowledgeDocumentSummary[]) => ScrollPlan | null,
      opts: { requireAround?: boolean } = {},
    ): Promise<boolean> => {
      if (!catalogId) return false;
      const seq = ++replaceSeq.current;
      const page = await api.knowledgeCatalogDocuments(catalogId, {
        ...scope,
        ...request,
        limit: PAGE_SIZE,
      });
      if (seq !== replaceSeq.current) return false;
      const around = 'around' in request ? request.around : null;
      const found = around !== null && page.documents.some((d) => d.id === around);
      if (opts.requireAround && !found) return false;
      generation.current++;
      scrollPlan.current = plan(page.documents);
      setListing({
        documents: page.documents,
        start: page.offset ?? ('offset' in request ? request.offset : 0),
        total: page.total,
      });
      return true;
    },
    [catalogId, scope],
  );

  const reveal = useCallback(
    (documentId: string) => {
      const { documents } = listingRef.current;
      if (!documents) {
        pendingReveal.current = documentId;
        return;
      }
      const scroller = scrollerRef.current;
      if (documents.some((d) => d.id === documentId)) {
        const row = scroller ? rowFor(scroller, documentId) : null;
        if (scroller && row) scrollRow(scroller, row, 'reveal');
        return;
      }
      void replaceWindow(
        { around: documentId },
        () => ({ kind: 'row', documentId, block: 'reveal' }),
        { requireAround: true },
      ).catch(() => {});
    },
    [replaceWindow],
  );
  const revealRef = useRef(reveal);
  revealRef.current = reveal;

  // A new scope starts over. The first load opens on the document being
  // read, when the listing holds it (returning to the view lands where you
  // were); picking another topic later starts at its top.
  useEffect(() => {
    generation.current++;
    replaceSeq.current++;
    // The ref too, so a reveal asked for in this same commit waits for the
    // new scope instead of reading the old window.
    listingRef.current = EMPTY_WINDOW;
    setListing(EMPTY_WINDOW);
    setTopIndex(0);
    if (!catalogId) return;
    const around = firstLoad.current ? selectedRef.current : null;
    firstLoad.current = false;
    const request = around ? { around } : { offset: 0 };
    void replaceWindow(request, (documents) =>
      around && documents.some((d) => d.id === around)
        ? { kind: 'row', documentId: around, block: 'reveal' }
        : { kind: 'top' },
    )
      .then((applied) => {
        const waiting = pendingReveal.current;
        pendingReveal.current = null;
        if (applied && waiting && waiting !== around) revealRef.current(waiting);
      })
      .catch(() => setListing({ documents: [], start: 0, total: 0 }));
  }, [catalogId, replaceWindow]);

  useEffect(() => {
    if (!catalogId) {
      setInitials([]);
      return;
    }
    let alive = true;
    api
      .knowledgeCatalogDocumentInitials(catalogId, scope)
      .then((r) => {
        if (alive) setInitials(buildLetterIndex(r.initials));
      })
      .catch(() => {
        if (alive) setInitials([]);
      });
    return () => {
      alive = false;
    };
  }, [catalogId, scope]);

  // The open document, whenever it changes or the list comes back into view
  // — not when the scope changes, since picking a topic starts at its top.
  // biome-ignore lint/correctness/useExhaustiveDependencies: revealKey is the trigger, not an input
  useEffect(() => {
    if (selectedDocId) revealRef.current(selectedDocId);
  }, [selectedDocId, revealKey]);

  const loadEdge = useCallback(
    async (edge: Edge) => {
      const { documents, start, total } = listingRef.current;
      if (!catalogId || !documents || inFlight.current.has(edge)) return;
      const end = start + documents.length;
      if (edge === 'after' ? end >= total : start <= 0) return;
      const offset = edge === 'after' ? end : Math.max(0, start - PAGE_SIZE);
      const limit = edge === 'after' ? PAGE_SIZE : start - offset;
      const asked = generation.current;
      inFlight.current.add(edge);
      setLoadingEdges(new Set(inFlight.current));
      try {
        const page = await api.knowledgeCatalogDocuments(catalogId, { ...scope, offset, limit });
        if (asked !== generation.current) return;
        if (edge === 'after') {
          setListing((prev) => ({
            ...prev,
            documents: [...(prev.documents ?? []), ...page.documents],
            total: page.total,
          }));
          return;
        }
        // Rows land above what the person is looking at; keep it still.
        const scroller = scrollerRef.current;
        if (scroller) {
          scrollPlan.current = {
            kind: 'keep',
            scrollHeight: scroller.scrollHeight,
            scrollTop: scroller.scrollTop,
          };
        }
        setListing((prev) => ({
          documents: [...page.documents, ...(prev.documents ?? [])],
          start: offset,
          total: page.total,
        }));
      } catch {
        /* the edge button stays, so a click retries */
      } finally {
        inFlight.current.delete(edge);
        setLoadingEdges(new Set(inFlight.current));
      }
    },
    [catalogId, scope],
  );

  const measureTop = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const rows = scroller.querySelectorAll<HTMLElement>('[data-doc-id]');
    const top = scroller.getBoundingClientRect().top;
    let lo = 0;
    let hi = rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((rows[mid]?.getBoundingClientRect().bottom ?? 0) > top) hi = mid;
      else lo = mid + 1;
    }
    setTopIndex(lo);
  }, []);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const plan = scrollPlan.current;
    if (!scroller || !plan || !listing.documents) return;
    scrollPlan.current = null;
    if (plan.kind === 'top') scroller.scrollTop = 0;
    else if (plan.kind === 'keep') {
      scroller.scrollTop = plan.scrollTop + (scroller.scrollHeight - plan.scrollHeight);
    } else {
      const row = rowFor(scroller, plan.documentId);
      if (row) scrollRow(scroller, row, plan.block);
    }
    measureTop();
  }, [listing, measureTop]);

  // Re-observed on every window change: a fresh observer reports whether an
  // edge is still in reach, which is what chains page after page on a tall
  // screen instead of stopping after one.
  useEffect(() => {
    const root = scrollerRef.current;
    if (!root || !listing.documents || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          void loadEdge(entry.target === beforeRef.current ? 'before' : 'after');
        }
      },
      { root, rootMargin: EDGE_PREFETCH_MARGIN },
    );
    if (beforeRef.current) observer.observe(beforeRef.current);
    if (afterRef.current) observer.observe(afterRef.current);
    return () => observer.disconnect();
  }, [listing, loadEdge]);

  const frame = useRef<number | null>(null);
  const onScroll = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = window.requestAnimationFrame(() => {
      frame.current = null;
      measureTop();
    });
  }, [measureTop]);
  useEffect(
    () => () => {
      if (frame.current !== null) window.cancelAnimationFrame(frame.current);
    },
    [],
  );

  const jumpTo = useCallback(
    (offset: number) => {
      const { documents, start } = listingRef.current;
      const loaded = documents?.[offset - start];
      const scroller = scrollerRef.current;
      if (loaded && scroller) {
        const row = rowFor(scroller, loaded.id);
        if (row) {
          scrollRow(scroller, row, 'start');
          measureTop();
          return;
        }
      }
      void replaceWindow({ offset }, (page) =>
        page[0] ? { kind: 'row', documentId: page[0].id, block: 'start' } : { kind: 'top' },
      ).catch(() => {});
    },
    [replaceWindow, measureTop],
  );

  const { documents, start, total } = listing;
  const end = start + (documents?.length ?? 0);
  const topDocument = documents?.[topIndex];
  const activeKey = topDocument ? letterKeyForDocument(topDocument) : null;
  const indexed = documents !== null && showsLetterIndex(initials, total, PAGE_SIZE);

  return (
    <>
      <div className="knowledge-list-header">{title}</div>
      <div className="knowledge-list-body">
        {indexed && (
          <nav className="knowledge-letter-index" aria-label="Jump to letter">
            {initials.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className="knowledge-letter"
                disabled={entry.offset === null}
                aria-current={entry.key === activeKey ? 'true' : undefined}
                aria-label={entry.key === '#' ? 'Numbers and symbols' : entry.key}
                onClick={() => {
                  if (entry.offset !== null) jumpTo(entry.offset);
                }}
              >
                {entry.key}
              </button>
            ))}
          </nav>
        )}
        <div className="knowledge-list-scroll" ref={scrollerRef} onScroll={onScroll}>
          {documents && start > 0 && (
            <button
              ref={beforeRef}
              type="button"
              className="knowledge-list-more knowledge-list-more--before"
              disabled={loadingEdges.has('before')}
              onClick={() => void loadEdge('before')}
            >
              {loadingEdges.has('before') ? 'Loading…' : `Show earlier (${start})`}
            </button>
          )}
          <ul className="knowledge-doc-list">
            {(documents ?? []).map((d) => (
              <li key={d.id} data-doc-id={d.id}>
                <button
                  type="button"
                  className="knowledge-doc-row"
                  aria-current={d.id === selectedDocId ? 'true' : undefined}
                  onClick={() => onOpen(d.id)}
                >
                  <span className="knowledge-doc-title">{d.title}</span>
                  {d.summary && <span className="knowledge-doc-summary">{d.summary}</span>}
                </button>
              </li>
            ))}
          </ul>
          {documents && end < total && (
            <button
              ref={afterRef}
              type="button"
              className="knowledge-list-more"
              disabled={loadingEdges.has('after')}
              onClick={() => void loadEdge('after')}
            >
              {loadingEdges.has('after') ? 'Loading…' : `Show more (${total - end} left)`}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
