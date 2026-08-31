import type { CatalogItemSummary, CraftbookTemplateManifest, ToolCallCard } from '@bendyline/gezel';
import { resolveSecurityPolicy } from '@bendyline/gezel';
import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { requestSettingsSection } from '../settings-nav.js';
import { ProjectGlyph } from '../views/projects/new-project-meta.js';
import { craftbookGlyph } from '../views/tasks/new-task-meta.js';
import { CatalogArtwork } from './CatalogArtwork.js';
import { StepTracker } from './StepTracker.js';
import { navigateToTab } from './nav-actions.js';

/**
 * ─ ToolCraftbookCard ─────────────────────────────────────────────────
 *
 * The rich inline card rendered under an `invoke_craftbook` /
 * `advance_task_step` tool row — the transcript's receipt that a
 * craftbook run started or moved a step. Everything it shows is the
 * snapshot the service stamped at event time (`ToolCallCard`); it makes
 * no claim to be live, and the task chip opens the live view (the chat
 * rail's Task pane where available, the full task tab otherwise).
 *
 * The one live element is the External-services nudge on start cards:
 * it reflects the CURRENT security policy (hidden once the capability is
 * on), because nudging toward a switch that is already flipped would be
 * the card lying about the present, not recording the past.
 */

interface CraftbookCatalogArt {
  item: CatalogItemSummary;
  manifest: CraftbookTemplateManifest;
}

/**
 * One in-flight/settled listing per project for the whole transcript — a
 * long session can hold many cards for the same project, and each needs
 * only a logo lookup.
 */
const projectCraftbooksCache = new Map<
  string,
  Promise<Awaited<ReturnType<typeof api.listProjectCraftbooks>>>
>();

function useCraftbookCatalogArt(
  projectId: string,
  craftbookId: string,
): CraftbookCatalogArt | null {
  const [art, setArt] = useState<CraftbookCatalogArt | null>(null);
  useEffect(() => {
    let cancelled = false;
    let listing = projectCraftbooksCache.get(projectId);
    if (!listing) {
      listing = api.listProjectCraftbooks(projectId);
      projectCraftbooksCache.set(projectId, listing);
      // A failed fetch must not poison the cache for every later card.
      listing.catch(() => projectCraftbooksCache.delete(projectId));
    }
    listing
      .then((res) => {
        if (cancelled) return;
        for (const item of res.items ?? []) {
          if (item.manifest.kind === 'craftbook-template' && item.manifest.id === craftbookId) {
            setArt({ item, manifest: item.manifest });
            return;
          }
        }
        setArt(null);
      })
      .catch(() => {
        if (!cancelled) setArt(null);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, craftbookId]);
  return art;
}

/**
 * `false` only when the resolved policy explicitly disables External
 * services — `null` (not yet known / fetch failed) hides the nudge
 * rather than flashing one that may be wrong.
 */
function useExternalServicesAllowed(enabled: boolean): boolean | null {
  const [allowed, setAllowed] = useState<boolean | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const refresh = () => {
      api
        .getConfig()
        .then((cfg) => {
          if (cancelled) return;
          setAllowed(
            resolveSecurityPolicy({ securityPolicy: cfg.securityPolicy }).allowExternalServices,
          );
        })
        .catch(() => {
          if (!cancelled) setAllowed(null);
        });
    };
    refresh();
    const onConfigUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ securityPolicy?: unknown }>).detail;
      if (!detail || !Object.prototype.hasOwnProperty.call(detail, 'securityPolicy')) return;
      refresh();
    };
    window.addEventListener('gezel:config-updated', onConfigUpdated);
    return () => {
      cancelled = true;
      window.removeEventListener('gezel:config-updated', onConfigUpdated);
    };
  }, [enabled]);
  return enabled ? allowed : null;
}

function openSecuritySettings(): void {
  requestSettingsSection('securityCompliance');
  window.dispatchEvent(
    new CustomEvent('gezel:navigate', {
      detail: { view: 'settings', section: 'securityCompliance' },
    }),
  );
}

function cardEyebrow(card: ToolCallCard): string {
  if (card.kind === 'craftbook-start') {
    return card.reused ? 'Craftbook already running' : 'Craftbook started';
  }
  return 'Step complete';
}

function cardHeadline(card: ToolCallCard): string {
  if (card.kind === 'craftbook-start') {
    const n = card.steps.length;
    return `${card.craftbookName} is underway — ${n} step${n === 1 ? '' : 's'}.`;
  }
  const completed = card.completedStepName ?? card.completedStepId;
  if (card.status === 'complete') return `Completed “${completed}” — task complete.`;
  if (card.status === 'canceled') return `Completed “${completed}” — task was canceled.`;
  const active = card.activeStepName ?? card.activeStepId;
  return active ? `Completed “${completed}” — now on “${active}”.` : `Completed “${completed}”.`;
}

export function ToolCraftbookCard({
  card,
  onFocusTask,
}: {
  card: ToolCallCard;
  /** Opens the task beside the chat (rail Task pane). Absent → full task tab. */
  onFocusTask?: (ref: string) => void;
}) {
  const art = useCraftbookCatalogArt(card.projectId, card.craftbookId);
  const recommendation =
    card.kind === 'craftbook-start' ? card.recommendsExternalServices : undefined;
  const externalAllowed = useExternalServicesAllowed(recommendation !== undefined);
  const openTask = () => {
    if (onFocusTask) onFocusTask(card.taskRef);
    else navigateToTab({ kind: 'task', ref: card.taskRef });
  };
  const activeStepId = card.activeStepId ?? null;
  const compact = card.kind === 'task-step-advance';
  return (
    <div className={`msg-tool-card${compact ? ' msg-tool-card-compact' : ''}`}>
      <div className="msg-tool-card-art" aria-hidden="true">
        <CatalogArtwork
          {...(art?.item.iconSvg ? { iconSvg: art.item.iconSvg } : {})}
          {...(art?.item.logoUrl ? { logoUrl: art.item.logoUrl } : {})}
          imageClassName="msg-tool-card-art-img"
          fallback={
            <ProjectGlyph
              glyph={art ? craftbookGlyph(art.manifest) : 'sheet'}
              size={compact ? 18 : 26}
            />
          }
        />
      </div>
      <div className="msg-tool-card-body">
        <div className="msg-tool-card-head">
          <span className="msg-tool-card-kind">{cardEyebrow(card)}</span>
        </div>
        <p className="msg-tool-card-headline">{cardHeadline(card)}</p>
        {card.steps.length > 0 && (
          <div className="msg-tool-card-track">
            <StepTracker
              steps={card.steps}
              statusOf={(s) => s.status}
              selectedStepId={activeStepId}
              centerStepId={activeStepId}
              scroll
              stepRole="button"
              onSelect={openTask}
              ariaLabel={card.kind === 'craftbook-start' ? 'Craftbook roadmap' : 'Task progress'}
            />
          </div>
        )}
        <div className="msg-tool-card-actions">
          <button type="button" className="msg-ref-chip" onClick={openTask} title="Open this task">
            Task {card.taskRef}
          </button>
        </div>
        {recommendation && externalAllowed === false && (
          <div className="msg-tool-card-nudge">
            <p className="msg-tool-card-nudge-text">
              Works better with <strong>External services</strong>
              {recommendation.reason ? ` — ${recommendation.reason}` : ''}. It still runs without
              it.
            </p>
            <button
              type="button"
              className="msg-tool-card-nudge-cta"
              onClick={openSecuritySettings}
            >
              Review in Settings
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
