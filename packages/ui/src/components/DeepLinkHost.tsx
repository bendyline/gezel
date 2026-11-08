import { type GezelDeepLink, isGezelDeepLink } from '@bendyline/gezel';
import { Suspense, lazy, useEffect, useState } from 'react';
import { runtimeCapabilities } from '../runtime-capabilities.js';
import type { DeepLinkDialogTarget } from './DeepLinkDialogs.js';
import { openHandboekArticleActions, runNavActions } from './nav-actions.js';

// Loaded only when a link arrives: the dialogs and their data would otherwise
// join the startup graph and break its resource budget.
const DeepLinkDialogs = lazy(() =>
  import('./DeepLinkDialogs.js').then((module) => ({ default: module.DeepLinkDialogs })),
);

/**
 * Opens what a `gezel://` link from gezel.com asks for: an app's New Project
 * form, a craftbook's launch form, or a Handboek article. The forms are the
 * ones Home's Make something opens, so nothing starts until the person submits
 * one. Contract in docs/deep-links.md.
 */
export function DeepLinkHost({ onHome }: { onHome: () => void }) {
  const [target, setTarget] = useState<DeepLinkDialogTarget | null>(null);

  useEffect(() => {
    let opened = 0;
    const open = (link: GezelDeepLink) => {
      const caps = runtimeCapabilities();
      if (link.kind === 'docs' && caps.knowledge) {
        runNavActions(openHandboekArticleActions(link.id));
        return;
      }
      const offersApps = caps.projects && (caps.catalog || caps.projectTypes === true);
      if ((link.kind === 'app' && offersApps) || (link.kind === 'craftbook' && caps.tasks)) {
        opened += 1;
        setTarget({ kind: link.kind, id: link.id, key: opened });
        return;
      }
      onHome();
    };
    let waiting: (() => void) | null = null;
    const unsubscribe = window.__GEZEL__?.onDeepLink?.((link) => {
      if (!isGezelDeepLink(link)) return;
      // A link that launched the app arrives while the startup reader still
      // covers it, and the handoff then moves focus and restores the view.
      // Open the target once that is done, so the handoff cannot undo it.
      if (!window.__GEZEL_STARTUP__) {
        open(link);
        return;
      }
      if (waiting) window.removeEventListener('gezel:startup-finished', waiting);
      const run = () => {
        waiting = null;
        open(link);
      };
      waiting = run;
      window.addEventListener('gezel:startup-finished', run, { once: true });
    });
    return () => {
      if (waiting) window.removeEventListener('gezel:startup-finished', waiting);
      unsubscribe?.();
    };
  }, [onHome]);

  if (!target) return null;
  return (
    <Suspense fallback={null}>
      <DeepLinkDialogs
        key={target.key}
        target={target}
        onClose={() => setTarget(null)}
        onUnavailable={() => {
          setTarget(null);
          onHome();
        }}
      />
    </Suspense>
  );
}
