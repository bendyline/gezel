import { useState } from 'react';
import { formatBytes } from '../data.js';
import type { Artifact } from '../types.js';
import { MarkdownView } from './Markdown.js';

interface Props {
  artifacts: Artifact[];
}

export function ArtifactGallery({ artifacts }: Props) {
  const html = artifacts.filter((a) => a.kind === 'html');
  const images = artifacts.filter((a) => a.kind === 'image');
  const plans = artifacts.filter((a) => a.kind === 'plan');

  const [activeHtml, setActiveHtml] = useState<string | null>(html[0]?.url ?? null);
  const [activePlan, setActivePlan] = useState<string | null>(plans[0]?.url ?? null);

  if (artifacts.length === 0) {
    return <div className="empty">No artifacts captured.</div>;
  }

  return (
    <div className="gallery">
      {html.length > 0 && (
        <div className="gallery-section">
          <h3>HTML ({html.length})</h3>
          <div className="gallery-tabs">
            {html.map((a) => (
              <button
                type="button"
                key={a.url}
                className={`gallery-tab ${activeHtml === a.url ? 'active' : ''}`}
                onClick={() => setActiveHtml(a.url)}
                title={`${a.relPath} (${formatBytes(a.bytes)})`}
              >
                {a.relPath.split('/').pop()}
              </button>
            ))}
          </div>
          {activeHtml && (
            <div className="iframe-wrap">
              <iframe
                src={activeHtml}
                sandbox="allow-scripts"
                title="artifact preview"
                className="artifact-iframe"
              />
              <div className="iframe-meta">
                <a href={activeHtml} target="_blank" rel="noreferrer">
                  open raw
                </a>
                <span>{html.find((a) => a.url === activeHtml)?.relPath}</span>
              </div>
            </div>
          )}
        </div>
      )}

      {images.length > 0 && (
        <div className="gallery-section">
          <h3>Images ({images.length})</h3>
          <div className="image-grid">
            {images.map((a) => (
              <a
                key={a.url}
                href={a.url}
                target="_blank"
                rel="noreferrer"
                className="image-tile"
                title={`${a.relPath} (${formatBytes(a.bytes)})`}
              >
                <img src={a.url} alt={a.relPath} loading="lazy" />
                <span className="image-caption">{formatBytes(a.bytes)}</span>
              </a>
            ))}
          </div>
        </div>
      )}

      {plans.length > 0 && (
        <div className="gallery-section">
          <h3>Plans ({plans.length})</h3>
          <div className="gallery-tabs">
            {plans.map((a) => (
              <button
                type="button"
                key={a.url}
                className={`gallery-tab ${activePlan === a.url ? 'active' : ''}`}
                onClick={() => setActivePlan(a.url)}
              >
                {a.relPath.split('/').pop()}
              </button>
            ))}
          </div>
          {activePlan && (
            <div className="plan-wrap">
              <MarkdownView url={activePlan} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
