import type { FindSimilarImagesResponse } from '@bendyline/gezel';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * "Find similar" for an image open in the project file viewer (lane A of
 * image search). One quiet action under the preview; results arrive as a
 * strip of thumbnails ranked by visual similarity. Degrades honestly: the
 * vector index fills in the background, so an empty answer says the index
 * is still building rather than pretending the image is unique.
 */

/** Small authed thumbnail — <img src> can't carry the bearer token. */
export function BlobThumb({
  path,
  fetchBlob,
  alt,
}: {
  path: string;
  fetchBlob: (path: string) => Promise<Blob>;
  alt: string;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    let currentUrl: string | null = null;
    void (async () => {
      try {
        const blob = await fetchBlob(path);
        if (cancelled) return;
        currentUrl = URL.createObjectURL(blob);
        setUrl(currentUrl);
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
      if (currentUrl) URL.revokeObjectURL(currentUrl);
    };
  }, [fetchBlob, path]);
  if (failed || !url) {
    // Never the browser's broken-image placeholder — an initial stands in.
    return <span className="similar-thumb-fallback">{alt.slice(0, 1).toUpperCase()}</span>;
  }
  return <img src={url} alt={alt} />;
}

export function FindSimilarImages({
  projectId,
  path,
  fetchBlob,
  onOpen,
}: {
  projectId: string;
  path: string;
  fetchBlob: (path: string) => Promise<Blob>;
  onOpen?: (path: string) => void;
}) {
  // Callers key this component by file path, so a new image remounts it and
  // the strip resets — results for the previous file would lie.
  const [state, setState] = useState<'idle' | 'searching' | 'done' | 'failed'>('idle');
  const [result, setResult] = useState<FindSimilarImagesResponse | null>(null);

  const search = useCallback(async () => {
    setState('searching');
    try {
      const res = await api.toolFindSimilarImages(projectId, { path, maxResults: 8 });
      setResult(res);
      setState('done');
    } catch {
      setState('failed');
    }
  }, [projectId, path]);

  return (
    <div className="similar-images">
      {state === 'idle' && (
        <button type="button" className="gz-key" onClick={() => void search()}>
          Find similar images
        </button>
      )}
      {state === 'searching' && <p className="muted small">Looking for similar images…</p>}
      {state === 'failed' && <p className="error small">The similarity lookup failed.</p>}
      {state === 'done' && result && result.engine !== 'vector' && (
        <p className="muted small">
          No visual index for this image yet — it builds in the background as images are indexed.
        </p>
      )}
      {state === 'done' && result && result.engine === 'vector' && result.results.length === 0 && (
        <p className="muted small">No visually similar images in this project.</p>
      )}
      {state === 'done' && result && result.engine === 'vector' && result.results.length > 0 && (
        <ul className="similar-images-strip" aria-label={`Images similar to ${path}`}>
          {result.results.map((r) => (
            <li key={r.path}>
              <button
                type="button"
                className="similar-thumb"
                title={`${r.path} · ${(r.score * 100).toFixed(0)}% similar`}
                onClick={() => onOpen?.(r.path)}
              >
                <BlobThumb
                  path={r.path}
                  fetchBlob={fetchBlob}
                  alt={r.path.split('/').pop() ?? r.path}
                />
                <span className="similar-thumb-name">{r.path.split('/').pop()}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
