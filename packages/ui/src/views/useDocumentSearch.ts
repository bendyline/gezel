import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { FileEntry } from '../components/FileTree.js';

/**
 * Content search over the shared document library.
 *
 * The tree answers "where did I file it"; this answers "which document says
 * this" — the question a growing library makes hard, and the one the index
 * already exists to serve. Results arrive as `FileEntry` rows so the file
 * browser can render them with its own list, keeping one selection model.
 */

export interface DocumentSearchHit {
  entry: FileEntry;
  snippet: string;
  line: number;
  /**
   * True when the only reason this document surfaced is embedding proximity —
   * it does not contain the query. The snippet cannot show that on its own
   * (the vector arm's excerpt is usually the file's generated summary), so
   * the list has to say it.
   */
  related: boolean;
}

export interface DocumentSearchState {
  query: string;
  setQuery: (next: string) => void;
  /** Null when not searching; an array (possibly empty) once a query ran. */
  hits: DocumentSearchHit[] | null;
  searching: boolean;
  /** Set when the library has no content index yet — worth saying out loud. */
  unavailable: boolean;
  clear: () => void;
}

const MIN_QUERY_CHARS = 2;
const DEBOUNCE_MS = 200;

export function useDocumentSearch(): DocumentSearchState {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<DocumentSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_CHARS) {
      setHits(null);
      setSearching(false);
      setUnavailable(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      api
        .searchDocuments({ q: trimmed })
        .then((res) => {
          if (cancelled) return;
          setUnavailable(res.engine === 'unavailable');
          setHits(
            res.results.map((r) => ({
              entry: {
                name: r.path.split('/').pop() ?? r.path,
                path: r.path,
                isDirectory: false,
              },
              snippet: r.snippet,
              line: r.lineStart,
              related: r.source === 'vector',
            })),
          );
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  return {
    query,
    setQuery,
    hits,
    searching,
    unavailable,
    clear: () => setQuery(''),
  };
}
