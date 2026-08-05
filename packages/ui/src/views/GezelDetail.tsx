import { EditorShell } from '@bendyline/squisq-editor-react';
import '@bendyline/squisq-editor-react/styles';
import type {
  AccessoryOption,
  DressOption,
  GezelDetail as GezelDetailData,
  GezelIconHistoryResponse,
  GrowthCosmetic,
  HatOption,
  Poppetje as PoppetjeStruct,
  ProviderName,
} from '@bendyline/gezel';
import {
  ACCESSORY_OPTIONS,
  DRESS_OPTIONS,
  GEZEL_CHAT_FONTS,
  GROWTH_COSMETICS,
  HAT_OPTIONS,
} from '@bendyline/gezel';
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { FixedFunctionAboutPanel } from '../components/FixedFunctionAboutPanel.js';
import { GezelActionsMenu } from '../components/GezelActionsMenu.js';
import { GezelChatTab } from '../components/GezelChatTab.js';
import { GezelIcon } from '../components/GezelIcon.js';
import { GezelTemplatePicker } from '../components/GezelTemplatePicker.js';
import { GezelTuningEditor } from '../components/GezelTuningEditor.js';
import { GrowthPanel } from '../components/GrowthPanel.js';
import { LevelBadge } from '../components/LevelBadge.js';
import { MemoriesTree } from '../components/MemoriesTree.js';
import { EffortPicker } from '../components/ModelPicker.js';
import { PromoteToTabButton } from '../components/PromoteToTabButton.js';
import { ProviderModelSelect } from '../components/ProviderModelSelect.js';
import { ToolsetsEditor } from '../components/ToolsetsEditor.js';
import { useGenerationEngineLabel } from '../components/generation-engine-label.js';
import { normalizeMarkdownBaseline } from '../components/markdown-baseline.js';
import { TransformToolbarButton } from '../components/transform/TransformToolbarButton.js';
import { useSerializedAutosave } from '../hooks/useSerializedAutosave.js';
import { type ItemSlot, Poppetje, PoppetjeItem } from '../poppetje/index.js';
import { Dialog, Select, Tabs } from '../primitives/index.js';
import { useEffectiveTheme } from '../theme.js';

type DetailTab = 'about' | 'appearance' | 'growth' | 'chat' | 'toolsets' | 'memories';

interface GezelDetailProps {
  gezelId: string;
  /**
   * True when this detail is itself the active top-level tab (i.e.,
   * rendered by TabContent for a `kind: 'gezel'` tab). Suppresses the
   * "promote to tab" affordance — there's nothing to promote when
   * we're already standing in the destination.
   */
  standalone?: boolean;
  onDeleted?: (gezelId: string) => void;
}

function broadcastUpdate(detail: GezelDetailData) {
  window.dispatchEvent(new CustomEvent('gezel:gezel-updated', { detail }));
}

export function GezelDetail({ gezelId, standalone = false, onDeleted }: GezelDetailProps) {
  const editorTheme = useEffectiveTheme();
  const [selected, setSelected] = useState<GezelDetailData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('');
  const [generatingIcon, setGeneratingIcon] = useState(false);
  const [generatingAbout, setGeneratingAbout] = useState(false);
  const [applyingAbout, setApplyingAbout] = useState(false);
  const [aboutRev, setAboutRev] = useState(0);
  const [detailTab, setDetailTab] = useState<DetailTab>('chat');
  const [showIterate, setShowIterate] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [renaming, setRenaming] = useState(false);
  const isFixedFunction = selected?.fixedFunction !== undefined;
  const activeDetailTab =
    isFixedFunction && (detailTab === 'toolsets' || detailTab === 'memories') ? 'chat' : detailTab;
  const generationEngineLabel = useGenerationEngineLabel(selected?.fixedFunction);

  const selectedRef = useRef<GezelDetailData | null>(null);
  const saveAbout = useCallback(
    (content: string) => api.updateGezelAbout(gezelId, { source: content }),
    [gezelId],
  );
  const aboutAutosave = useSerializedAutosave({
    resourceKey: `gezel:${gezelId}:about`,
    initialValue: '',
    save: saveAbout,
    onLatestSaved: (updated) => {
      const current = selectedRef.current;
      if (!current || current.id !== gezelId) return;
      const merged = { ...current, about: updated.about };
      selectedRef.current = merged;
      setSelected(merged);
      broadcastUpdate(merged);
    },
  });

  useEffect(() => {
    let cancelled = false;
    setSelected(null);
    setError(null);
    setStatus('');
    void (async () => {
      try {
        const detail = await api.getGezel(gezelId);
        if (cancelled) return;
        // about.md feeds a Squisq editor — baseline on its canonical form so
        // opening the tab never reads as an edit (see markdown-baseline.ts).
        const effective = {
          ...detail,
          about: aboutAutosave.hydrate(normalizeMarkdownBaseline(detail.about)),
        };
        selectedRef.current = effective;
        setSelected(effective);
      } catch (err) {
        if (!cancelled) setError((err as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gezelId, aboutAutosave.hydrate]);

  useEffect(() => {
    if (isFixedFunction && detailTab !== activeDetailTab) {
      setDetailTab(activeDetailTab);
    }
  }, [activeDetailTab, detailTab, isFixedFunction]);

  const applyUpdate = useCallback((updated: GezelDetailData) => {
    selectedRef.current = updated;
    setSelected(updated);
    broadcastUpdate(updated);
  }, []);

  const handleChange = useCallback(
    (source: string) => {
      setStatus('');
      aboutAutosave.update(source);
    },
    [aboutAutosave.update],
  );

  const startRename = useCallback(() => {
    if (!selected) return;
    setRenameDraft(selected.name);
    setRenaming(true);
  }, [selected]);

  const commitRename = useCallback(async () => {
    if (!selected || !renameDraft.trim() || renameDraft.trim() === selected.name) {
      setRenaming(false);
      return;
    }
    try {
      await aboutAutosave.flush();
      const renamed = await api.renameGezel(selected.id, { name: renameDraft.trim() });
      selectedRef.current = renamed;
      aboutAutosave.adopt(renamed.about);
      setSelected(renamed);
      broadcastUpdate(renamed);
    } catch (err) {
      setStatus(`rename failed: ${(err as Error).message}`);
    }
    setRenaming(false);
  }, [selected, renameDraft, aboutAutosave.flush, aboutAutosave.adopt]);

  const handleRenameKey = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') void commitRename();
      if (e.key === 'Escape') setRenaming(false);
    },
    [commitRename],
  );

  if (error) {
    return (
      <div className="placeholder">
        <p>Couldn't open this gezel: {error}</p>
      </div>
    );
  }
  if (!selected) {
    return <p className="placeholder">Loading gezel…</p>;
  }

  return (
    <section
      className={`gezel-detail${activeDetailTab === 'chat' ? ' gezel-detail-chat' : ''}`}
      data-testid="gezel-detail"
    >
      <header className="detail-header">
        <span className="level-badge-anchor">
          <GezelIcon
            svg={selected.icon ?? null}
            poppetje={selected.poppetje}
            iconOverride={selected.iconOverride}
            name={selected.name}
            size={80}
            pulsing={generatingIcon && !selected.icon && !selected.poppetje}
            onClick={() => setShowIterate(true)}
            title={
              selected.iconOverride && selected.icon
                ? 'Click to iterate on this icon'
                : 'Click to manage appearance'
            }
          />
          {selected.growth && (
            <LevelBadge level={selected.growth.level} pending={!!selected.growth.pending} overlay />
          )}
        </span>
        <div className="detail-header-text">
          {renaming ? (
            <input
              className="rename-input"
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={handleRenameKey}
            />
          ) : (
            <h3
              className="gezel-name-editable"
              onClick={startRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') startRename();
              }}
              title="Click to rename"
            >
              {selected.name}
            </h3>
          )}
          {selected.role && <span className="gezel-role">{selected.role}</span>}
          {selected.fixedFunction ? (
            // Fixed-function gezels skip the LLM, so the model /
            // effort / sandbox controls don't apply. (The chat-bubble
            // font is set from the Appearance tab, same as any other
            // gezel.)
            <div className="provider-override">
              <span className="gezel-role muted small ff-header-tag" title="Fixed-function gezel">
                Fixed-function · forwards to <code>{selected.fixedFunction.tool}</code>
              </span>
              {generationEngineLabel && (
                <span
                  className="gezel-role muted small ff-header-tag"
                  title="Generation model used by this gezel"
                >
                  {generationEngineLabel}
                </span>
              )}
            </div>
          ) : (
            <ProviderOverride gezel={selected} onUpdated={applyUpdate} />
          )}
        </div>
        <output className="status" aria-live="polite">
          {aboutAutosave.phase === 'error' ? (
            <>
              save failed: {aboutAutosave.error?.message ?? 'unknown error'}{' '}
              <button
                type="button"
                className="link-btn"
                onClick={() => void aboutAutosave.retry().catch(() => {})}
              >
                Retry
              </button>
            </>
          ) : status ? (
            status
          ) : aboutAutosave.phase === 'dirty' ? (
            'unsaved changes'
          ) : aboutAutosave.phase === 'saving' ? (
            'saving…'
          ) : aboutAutosave.phase === 'saved' ? (
            'saved'
          ) : null}
        </output>
        <GezelActionsMenu gezel={selected} onDeleted={onDeleted} />
      </header>
      <IterateIconDialog
        open={showIterate}
        gezel={selected}
        isGenerating={generatingIcon}
        onClose={() => setShowIterate(false)}
        onUpdated={applyUpdate}
        setGenerating={setGeneratingIcon}
      />
      <div className="entity-tabs-row">
        <Tabs.Root value={activeDetailTab} onValueChange={(v) => setDetailTab(v as DetailTab)}>
          <Tabs.List>
            <Tabs.Trigger value="chat">Chat</Tabs.Trigger>
            <Tabs.Trigger value="about">About</Tabs.Trigger>
            <Tabs.Trigger value="appearance">Appearance</Tabs.Trigger>
            <Tabs.Trigger value="growth">
              Growth
              {selected.growth?.pending && (
                <span
                  className="growth-tab-dot"
                  title="A level-up is waiting for your choice"
                  aria-label="Level-up pending"
                />
              )}
            </Tabs.Trigger>
            {!isFixedFunction && <Tabs.Trigger value="toolsets">Toolsets</Tabs.Trigger>}
            {!isFixedFunction && <Tabs.Trigger value="memories">Memories</Tabs.Trigger>}
          </Tabs.List>
        </Tabs.Root>
        {!standalone && <PromoteToTabButton target={{ kind: 'gezel', id: selected.id }} />}
      </div>
      {activeDetailTab === 'appearance' && (
        <AppearancePanel gezel={selected} onUpdated={applyUpdate} />
      )}
      {activeDetailTab === 'growth' && (
        <GrowthPanel
          gezel={selected}
          onUpdated={() => {
            // Accepting a trait/tuning/cosmetic changed the gezel record
            // server-side — pull the fresh detail so the header badge,
            // tuning editor, and poppetje reflect it. (The hook already
            // broadcast `gezel:gezel-updated` for the other surfaces.)
            void (async () => {
              try {
                const detail = await api.getGezel(selected.id);
                selectedRef.current = detail;
                setSelected(detail);
              } catch {
                /* keep showing the current record */
              }
            })();
          }}
        />
      )}
      {!isFixedFunction && activeDetailTab === 'toolsets' && (
        <ToolsetsEditor scope={{ kind: 'gezel', gezelId: selected.id }} subject={selected.name} />
      )}
      {activeDetailTab === 'about' && selected.fixedFunction && (
        <FixedFunctionAboutPanel gezel={selected} onUpdated={applyUpdate} />
      )}
      {activeDetailTab === 'about' && !selected.fixedFunction && (
        <div className="editor-wrap">
          {generatingAbout && (
            <div className="about-generating-banner">
              Drafting <code>about.md</code> from the role…
            </div>
          )}
          <EditorShell
            key={`${selected.id}:${aboutRev}`}
            initialMarkdown={selected.about}
            onChange={handleChange}
            height="calc(100vh - 220px)"
            colorScheme={editorTheme}
            showPlayTab={false}
            fullWidth
            readOnly={generatingAbout || applyingAbout}
            toolbarSlotAfterActions={
              <>
                <TransformToolbarButton context="about" />
                <GezelTemplatePicker
                  {...(selected.role ? { gezelRole: selected.role } : {})}
                  {...(selected.templateId ? { gezelTemplateId: selected.templateId } : {})}
                  onApply={async (_templateId, about) => {
                    setApplyingAbout(true);
                    try {
                      const updated = await aboutAutosave.saveNow(about);
                      if (!updated) return;
                      setAboutRev((r) => r + 1);
                      setStatus('applied template');
                    } catch (err) {
                      setStatus(`template apply failed: ${(err as Error).message}`);
                    } finally {
                      setApplyingAbout(false);
                    }
                  }}
                />
                <button
                  type="button"
                  className="link-btn"
                  disabled={generatingAbout || !selected.role}
                  title={
                    selected.role
                      ? 'Re-draft about.md from the role'
                      : 'Set a role first to enable about generation'
                  }
                  onClick={async () => {
                    if (!selected.role) return;
                    setGeneratingAbout(true);
                    try {
                      // Generation is a different endpoint, so drain the
                      // about.md lane first. With the editor read-only while
                      // this runs, no older autosave can land after the
                      // generated replacement.
                      await aboutAutosave.flush();
                      const updated = await api.generateGezelAbout(selected.id, {
                        role: selected.role,
                      });
                      aboutAutosave.adopt(updated.about);
                      selectedRef.current = updated;
                      setAboutRev((r) => r + 1);
                      applyUpdate(updated);
                    } catch (err) {
                      setStatus(`about generation failed: ${(err as Error).message}`);
                    } finally {
                      setGeneratingAbout(false);
                    }
                  }}
                >
                  {generatingAbout ? 'Drafting…' : 'Draft from role'}
                </button>
              </>
            }
          />
        </div>
      )}
      {activeDetailTab === 'chat' && (
        <GezelChatTab gezel={selected} engineLabel={generationEngineLabel} />
      )}
      {!isFixedFunction && activeDetailTab === 'memories' && (
        <MemoriesTree gezelId={selected.id} gezelName={selected.name} />
      )}
    </section>
  );
}

function AppearancePanel({
  gezel,
  onUpdated,
}: {
  gezel: GezelDetailData;
  onUpdated: (detail: GezelDetailData) => void;
}) {
  const [rerolling, setRerolling] = useState(false);
  const [savingOverride, setSavingOverride] = useState(false);
  const [savingFont, setSavingFont] = useState(false);
  const [showAccessories, setShowAccessories] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const poppetje = gezel.poppetje;

  const handleReroll = async () => {
    setError(null);
    setRerolling(true);
    try {
      const res = await api.rerollGezelPoppetje(gezel.id, {});
      // Refresh the full detail so other surfaces (sidebar, chat) update too.
      const updated = await api.getGezel(gezel.id);
      onUpdated({ ...updated, poppetje: res.poppetje });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRerolling(false);
    }
  };

  const handleToggleOverride = async (next: boolean) => {
    setError(null);
    setSavingOverride(true);
    try {
      const updated = await api.updateGezelSettings(gezel.id, {
        iconOverride: next ? true : null,
      });
      onUpdated(updated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingOverride(false);
    }
  };

  const handleFontChange = async (value: string) => {
    setError(null);
    setSavingFont(true);
    try {
      const updated = await api.updateGezelSettings(gezel.id, {
        font: value ? value : null,
      });
      onUpdated(updated);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingFont(false);
    }
  };

  return (
    <>
      <section className="gezel-appearance" aria-label="Appearance">
        <div className="gezel-appearance-hero" aria-label={`${gezel.name} portrait`}>
          {poppetje ? (
            <Poppetje poppetje={poppetje} variant="full" size={160} grainStyle="wavy" />
          ) : (
            <span className="muted small">Generating…</span>
          )}
        </div>
        <div className="gezel-appearance-actions">
          <strong>{gezel.name}'s appearance</strong>
          <div className="gezel-appearance-buttons">
            <button type="button" onClick={handleReroll} disabled={rerolling || !poppetje}>
              {rerolling ? 'Rerolling…' : 'Reroll appearance'}
            </button>
            <button
              type="button"
              className="link-btn"
              onClick={() => setShowAccessories(true)}
              disabled={!poppetje}
              title="Add or remove worn items (hat, garment, accessory)"
            >
              Accessories…
            </button>
          </div>
          <span className="muted small">
            Reroll redraws everything (body, face, hair). Accessories let you toggle just the worn
            items.
          </span>
          {gezel.icon && (
            <label className="gezel-appearance-toggle">
              <input
                type="checkbox"
                checked={!!gezel.iconOverride}
                disabled={savingOverride}
                onChange={(e) => void handleToggleOverride(e.target.checked)}
              />
              Show abstract icon instead of the poppetje
            </label>
          )}
          {error && <p className="error small">{error}</p>}
        </div>
        <AccessoriesDialog
          open={showAccessories}
          gezel={gezel}
          onClose={() => setShowAccessories(false)}
          onUpdated={onUpdated}
        />
      </section>
      <section className="gezel-font-section" aria-label="Chat font">
        <strong>Chat font</strong>
        <GezelFontPicker
          value={gezel.font}
          onChange={(v) => void handleFontChange(v)}
          disabled={savingFont}
        />
        <span className="muted small">
          The typeface used for {gezel.name}'s chat bubbles. Inherits the app default unless
          overridden.
        </span>
      </section>
    </>
  );
}

const HAT_LABELS: Record<HatOption, string> = {
  cap: 'Cap',
  beanie: 'Beanie',
  kerchief: 'Kerchief',
  straw: 'Straw hat',
  newsboy: 'Newsboy cap',
  hood: 'Hoodie',
};
const DRESS_LABELS: Record<DressOption, string> = {
  scarf: 'Scarf',
  apron: 'Apron',
  collar: 'Collar',
  turtleneck: 'Turtleneck',
};
// Earring sides are named from the viewer's perspective — they match what
// the preview shows, not the wearer's left/right.
const ACCESSORY_LABELS: Record<AccessoryOption, string> = {
  glasses: 'Glasses',
  sunglasses: 'Sunglasses',
  cateye: 'Cat-eye glasses',
  readers: 'Reading glasses',
  monocle: 'Monocle',
  eyepatch: 'Eye patch',
  earrings: 'Earrings',
  'earring-left': 'Left earring',
  'earring-right': 'Right earring',
  flower: 'Flower',
  hairclip: 'Hair clip',
  headband: 'Headband',
  bowtie: 'Bow tie',
  necklace: 'Necklace',
  brooch: 'Brooch',
  facemask: 'Face mask',
  goggles: 'Goggles',
  'safety-glasses': 'Safety glasses',
  'pince-nez': 'Pince-nez',
  headphones: 'Headphones',
  'hearing-aid': 'Hearing aid',
  'nose-ring': 'Nose ring',
  'hoop-earrings': 'Hoop earrings',
  'drop-earrings': 'Drop earrings',
  'pearl-earrings': 'Pearl earrings',
  bandage: 'Bandage',
  feather: 'Feather',
  pencil: 'Pencil',
  ribbon: 'Ribbon',
  necktie: 'Necktie',
  cravat: 'Cravat',
  'bolo-tie': 'Bolo tie',
  lanyard: 'Lanyard',
  medal: 'Medal',
  'pocket-square': 'Pocket square',
  'tool-pendant': 'Tool pendant',
};

/** One selectable item tile — its art (or a "none" glyph) plus a label. */
function AccessoryTile({
  slot,
  option,
  label,
  selected,
  disabled,
  lockText,
  onSelect,
}: {
  /** Omitted for the "None" tile, which clears the slot. */
  slot?: ItemSlot;
  option?: string;
  label: string;
  selected: boolean;
  disabled?: boolean;
  /** "unlocks at level N" — renders a lock badge and disables the tile. */
  lockText?: string;
  onSelect: () => void;
}) {
  const lockLevel = lockText?.match(/\d+/)?.[0];
  return (
    <button
      type="button"
      // biome-ignore lint/a11y/useSemanticElements: WAI-ARIA radiogroup of tile buttons; a native <input type="radio"> can't host the art + label layout.
      role="radio"
      aria-checked={selected}
      className={`accessory-tile${selected ? ' selected' : ''}${lockText ? ' locked' : ''}`}
      disabled={disabled}
      onClick={onSelect}
      title={lockText ? `${label} — ${lockText}` : label}
    >
      <span className="accessory-tile-art">
        {slot && option ? (
          <PoppetjeItem slot={slot} option={option} size={52} />
        ) : (
          <svg width={28} height={28} viewBox="0 0 24 24" aria-hidden="true">
            <circle cx={12} cy={12} r={9} fill="none" stroke="currentColor" strokeWidth={1.6} />
            <line x1={6} y1={18} x2={18} y2={6} stroke="currentColor" strokeWidth={1.6} />
          </svg>
        )}
      </span>
      <span className="accessory-tile-label">{label}</span>
      {lockLevel && (
        <span className="accessory-tile-lock" aria-hidden="true">
          Lv {lockLevel}
        </span>
      )}
    </button>
  );
}

/**
 * A scrollable grid of item tiles for one wearable slot. Replaces the old
 * dropdown: every option is shown as its isolated art so the whole catalog
 * is browsable at a glance. A leading "None" tile clears the slot; growth-
 * locked options render dimmed with a level badge and can't be picked.
 */
function SlotTiles<T extends string>({
  slot,
  label,
  value,
  options,
  labels,
  locked,
  onChange,
  disabled,
}: {
  slot: ItemSlot;
  label: string;
  value: T | null;
  options: readonly T[];
  labels: Record<T, string>;
  /** Option → "unlocks at level N" text. Locked options render disabled. */
  locked?: Partial<Record<T, string>>;
  onChange: (value: T | null) => void;
  disabled?: boolean;
}) {
  return (
    <div className="accessory-section">
      <h4 className="accessory-section-title">{label}</h4>
      <div className="accessory-tiles" role="radiogroup" aria-label={label}>
        <AccessoryTile
          label="None"
          selected={value === null}
          disabled={disabled}
          onSelect={() => onChange(null)}
        />
        {options.map((opt) => {
          const lockText = locked?.[opt];
          return (
            <AccessoryTile
              key={opt}
              slot={slot}
              option={opt}
              label={labels[opt]}
              selected={value === opt}
              disabled={disabled || !!lockText}
              lockText={lockText}
              onSelect={() => onChange(opt)}
            />
          );
        })}
      </div>
    </div>
  );
}

/**
 * Growth-gated wearables for one slot: locked while the gezel's level is
 * below the catalog entry's, EXCEPT a currently-worn item (grandfathered
 * — gating only blocks newly selecting). Levels are the only key needed:
 * cosmetic level-up payouts always propose entries at/below the new
 * level, so an explicit unlock never outruns this check.
 */
function lockedForSlot<T extends string>(
  slot: GrowthCosmetic['slot'],
  level: number,
  worn: T | null,
): Partial<Record<T, string>> {
  const out: Partial<Record<T, string>> = {};
  for (const cosmetic of GROWTH_COSMETICS) {
    if (cosmetic.slot !== slot) continue;
    if (cosmetic.level <= level) continue;
    if (worn === (cosmetic.option as T)) continue;
    out[cosmetic.option as T] = `unlocks at level ${cosmetic.level}`;
  }
  return out;
}

/**
 * Toggle a gezel's worn items — hat, garment, and face accessory — without
 * touching physical features. Each change persists immediately via the
 * poppetje PUT route and the live preview (plus the detail hero) updates
 * because we propagate the new struct up through `onUpdated`. Physical
 * attributes (body, skin, hair, facial hair, marks) are deliberately
 * absent here; the only way to change those is a reroll.
 */
function AccessoriesDialog({
  open,
  gezel,
  onClose,
  onUpdated,
}: {
  open: boolean;
  gezel: GezelDetailData;
  onClose: () => void;
  onUpdated: (detail: GezelDetailData) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const poppetje = gezel.poppetje;
  const growthLevel = gezel.growth?.level ?? 1;

  const applyPatch = async (patch: Partial<PoppetjeStruct>) => {
    if (!poppetje) return;
    setError(null);
    setSaving(true);
    try {
      const next: PoppetjeStruct = { ...poppetje, ...patch };
      const res = await api.setGezelPoppetje(gezel.id, { poppetje: next });
      onUpdated({ ...gezel, poppetje: res.poppetje });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className="accessories-dialog">
          <Dialog.Title asChild>
            <h3>{gezel.name}'s accessories</h3>
          </Dialog.Title>
          <Dialog.Description className="muted small">
            Add or remove worn items. Physical features — face, hair, skin, body — only change when
            you reroll.
          </Dialog.Description>
          <div className="accessories-body">
            <div className="accessories-preview" aria-label={`${gezel.name} preview`}>
              {poppetje ? (
                <Poppetje poppetje={poppetje} variant="full" size={150} grainStyle="wavy" />
              ) : (
                <span className="muted small">Generating…</span>
              )}
            </div>
            <div className="accessories-controls">
              <SlotTiles<HatOption>
                slot="hat"
                label="Hat"
                value={poppetje?.hat ?? null}
                options={HAT_OPTIONS}
                labels={HAT_LABELS}
                locked={lockedForSlot('hat', growthLevel, poppetje?.hat ?? null)}
                onChange={(v) => void applyPatch({ hat: v })}
                disabled={saving || !poppetje}
              />
              <SlotTiles<DressOption>
                slot="dress"
                label="Garment"
                value={poppetje?.dress ?? null}
                options={DRESS_OPTIONS}
                labels={DRESS_LABELS}
                locked={lockedForSlot('dress', growthLevel, poppetje?.dress ?? null)}
                onChange={(v) => void applyPatch({ dress: v })}
                disabled={saving || !poppetje}
              />
              <SlotTiles<AccessoryOption>
                slot="accessory"
                label="Accessory"
                value={poppetje?.accessory ?? null}
                options={ACCESSORY_OPTIONS}
                labels={ACCESSORY_LABELS}
                locked={lockedForSlot('accessory', growthLevel, poppetje?.accessory ?? null)}
                onChange={(v) => void applyPatch({ accessory: v })}
                disabled={saving || !poppetje}
              />
            </div>
          </div>
          {error && <p className="gz-dialog-error">{error}</p>}
          <Dialog.Actions>
            <button type="button" className="primary" onClick={onClose}>
              Done
            </button>
          </Dialog.Actions>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function IterateIconDialog({
  open,
  gezel,
  isGenerating,
  onClose,
  onUpdated,
  setGenerating,
}: {
  open: boolean;
  gezel: GezelDetailData;
  isGenerating: boolean;
  onClose: () => void;
  onUpdated: (detail: GezelDetailData) => void;
  setGenerating: (on: boolean) => void;
}) {
  const [instruction, setInstruction] = useState('');
  const [history, setHistory] = useState<GezelIconHistoryResponse['history']>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    try {
      const res = await api.listGezelIconHistory(gezel.id);
      setHistory(res.history);
    } catch (err) {
      setLocalError((err as Error).message);
    }
  }, [gezel.id]);

  useEffect(() => {
    if (historyOpen) void loadHistory();
  }, [historyOpen, loadHistory]);

  const handleRegenerate = async () => {
    setLocalError(null);
    setGenerating(true);
    try {
      const updated = await api.generateGezelIcon(
        gezel.id,
        instruction.trim() ? { instruction: instruction.trim() } : {},
      );
      onUpdated(updated);
      setInstruction('');
      if (historyOpen) await loadHistory();
    } catch (err) {
      setLocalError((err as Error).message);
    } finally {
      setGenerating(false);
    }
  };

  const handleRevert = async (timestamp: string) => {
    setLocalError(null);
    try {
      const updated = await api.revertGezelIcon(gezel.id, { timestamp });
      onUpdated(updated);
      await loadHistory();
    } catch (err) {
      setLocalError((err as Error).message);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className="iterate-dialog">
          <Dialog.Title asChild>
            <h3>Iterate on {gezel.name}'s icon</h3>
          </Dialog.Title>
          <div className="iterate-preview">
            <GezelIcon
              svg={gezel.icon ?? null}
              poppetje={gezel.poppetje}
              iconOverride={gezel.iconOverride}
              name={gezel.name}
              size={120}
              pulsing={isGenerating}
            />
          </div>
          <label>
            What should change?
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="e.g. make the colors warmer, try a cat shape, more geometric"
              rows={3}
            />
          </label>
          {localError && <p className="error">{localError}</p>}
          <Dialog.Actions>
            <button type="button" className="link-btn" onClick={() => setHistoryOpen((v) => !v)}>
              {historyOpen ? 'Hide history' : 'Show history'}
            </button>
            <span style={{ flex: 1 }} />
            <button type="button" onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              className="primary"
              onClick={handleRegenerate}
              disabled={isGenerating}
            >
              {isGenerating ? 'Generating…' : 'Regenerate'}
            </button>
          </Dialog.Actions>
          {historyOpen && (
            <div className="icon-history-row">
              {history.length === 0 && <p className="muted">No previous variants yet.</p>}
              {history.map((entry) => (
                <button
                  key={entry.timestamp}
                  type="button"
                  className="icon-history-item"
                  onClick={() => void handleRevert(entry.timestamp)}
                  title={`Revert to ${entry.timestamp}`}
                >
                  {/* History entries show the historical icon as-is. */}
                  <GezelIcon svg={entry.svg} iconOverride name={gezel.name} size={56} />
                </button>
              ))}
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ProviderOverride({
  gezel,
  onUpdated,
}: {
  gezel: GezelDetailData;
  onUpdated: (detail: GezelDetailData) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [globalProvider, setGlobalProvider] = useState<ProviderName>('copilot');

  useEffect(() => {
    api
      .getConfig()
      .then((cfg) => setGlobalProvider(cfg.provider))
      .catch(() => {});
  }, []);

  const setProviderAndModel = useCallback(
    async (nextProvider: ProviderName | null, nextModel: string | undefined) => {
      // One PUT, both fields. The previous chip-row UI updated
      // provider and model via separate calls — that briefly left
      // the gezel in an inconsistent state ("OpenAI provider, Ollama
      // model") between the two writes, surfaced as a "model not in
      // the new provider's list, falling back to default" warning
      // in the bridge log. Atomic update kills that race.
      //
      // Reasoning-effort is provider-keyed too, so clear it whenever
      // the provider changes — the same effort name on a different
      // provider doesn't necessarily map (Copilot's `low/med/high`
      // vs OpenAI's `minimal/low/medium/high`).
      const providerChanged = (gezel.provider ?? null) !== (nextProvider ?? null);
      setSaving(true);
      try {
        const updated = await api.updateGezelSettings(gezel.id, {
          provider: nextProvider ?? null,
          model: nextModel ?? null,
          ...(providerChanged || !nextModel ? { reasoningEffort: null } : {}),
        });
        onUpdated(updated);
      } finally {
        setSaving(false);
      }
    },
    [gezel.id, gezel.provider, onUpdated],
  );

  const saveEffort = useCallback(
    async (value: string | undefined) => {
      setSaving(true);
      try {
        const updated = await api.updateGezelSettings(gezel.id, {
          reasoningEffort: value ?? null,
        });
        onUpdated(updated);
      } finally {
        setSaving(false);
      }
    },
    [gezel.id, onUpdated],
  );

  const saveSandbox = useCallback(
    async (value: 'default' | 'on' | 'off') => {
      setSaving(true);
      try {
        const updated = await api.updateGezelSettings(gezel.id, {
          sandboxCopilot: value === 'default' ? null : value === 'on',
        });
        onUpdated(updated);
      } finally {
        setSaving(false);
      }
    },
    [gezel.id, onUpdated],
  );

  const effectiveProvider = gezel.provider ?? globalProvider;
  const sandboxCurrent: 'default' | 'on' | 'off' =
    gezel.sandboxCopilot === undefined ? 'default' : gezel.sandboxCopilot ? 'on' : 'off';

  return (
    <div className="provider-override">
      <span className="muted small">Model:</span>
      <ProviderModelSelect
        provider={gezel.provider ?? null}
        model={gezel.model}
        onChange={(p, m) => void setProviderAndModel(p, m)}
        globalProvider={globalProvider}
        disabled={saving}
      />
      <EffortPicker
        provider={effectiveProvider}
        model={gezel.model}
        value={gezel.reasoningEffort}
        onChange={(v) => void saveEffort(v)}
      />
      {effectiveProvider === 'copilot' && (
        <>
          <span
            className="muted small"
            style={{ marginLeft: '0.75rem' }}
            title="Deny the Copilot CLI's built-in tools (bash, web_fetch, file edit, grep) and force this gezel through our MCP tools."
          >
            Sandbox:
          </span>
          {(['default', 'on', 'off'] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={`provider-chip${sandboxCurrent === value ? ' provider-chip-active' : ''}`}
              onClick={() => void saveSandbox(value)}
              disabled={saving}
            >
              {value === 'default' ? 'Inherit' : value === 'on' ? 'On' : 'Off'}
            </button>
          ))}
        </>
      )}
      <AdvancedTuningDisclosure
        gezel={gezel}
        effectiveProvider={effectiveProvider}
        onUpdated={onUpdated}
      />
    </div>
  );
}

/**
 * `<details>` wrapper around `GezelTuningEditor`. Defaults closed so
 * the header stays compact; opening it loads the catalog tuning defaults
 * for the resolved model id, then renders the Squisq form.
 */
function AdvancedTuningDisclosure({
  gezel,
  effectiveProvider,
  onUpdated,
}: {
  gezel: GezelDetailData;
  effectiveProvider: ProviderName;
  onUpdated: (detail: GezelDetailData) => void;
}) {
  // The "inherited" stack the gezel layers on top of: catalog defaults
  // merged with the install-wide modelTuning override for the same
  // model id. Loaded lazily when the disclosure opens.
  const [inherited, setInherited] = useState<
    import('@bendyline/gezel').ChatModelTuning | undefined
  >(undefined);

  const fetchInherited = useCallback(async () => {
    if (inherited !== undefined || !gezel.model) return;
    try {
      const [detail, config] = await Promise.all([
        api.getCatalogItem('chat-model', gezel.model).catch(() => null),
        api.getConfig().catch(() => null),
      ]);
      const catalogTuning =
        detail && detail.manifest.kind === 'chat-model' ? detail.manifest.tuning : undefined;
      const installTuning = config?.modelTuning?.[gezel.model];
      const merged = mergeTuning(catalogTuning, installTuning);
      if (merged) setInherited(merged);
    } catch {
      /* best-effort */
    }
  }, [inherited, gezel.model]);

  return (
    <details
      className="gezel-tuning-disclosure"
      style={{ flexBasis: '100%', marginTop: '0.5rem' }}
      onToggle={(e) => {
        if ((e.target as HTMLDetailsElement).open) void fetchInherited();
      }}
    >
      <summary className="muted small" style={{ cursor: 'pointer' }}>
        Advanced tuning
      </summary>
      <div style={{ marginTop: '0.5rem' }}>
        <GezelTuningEditor
          gezel={gezel}
          {...(inherited ? { inherited } : {})}
          effectiveProvider={effectiveProvider}
          onUpdated={onUpdated}
        />
      </div>
    </details>
  );
}

/**
 * Deep-merge two sparse tunings (install on top of catalog). Returns
 * undefined when both are empty.
 */
function mergeTuning(
  base: import('@bendyline/gezel').ChatModelTuning | undefined,
  top: import('@bendyline/gezel').ChatModelTuning | undefined,
): import('@bendyline/gezel').ChatModelTuning | undefined {
  if (!base && !top) return undefined;
  if (!base) return top;
  if (!top) return base;
  return mergeObj(base, top) as import('@bendyline/gezel').ChatModelTuning;
}

function mergeObj(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (value === undefined) continue;
    const existing = out[key];
    if (
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    ) {
      out[key] = mergeObj(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function GezelFontPicker({
  value,
  onChange,
  disabled,
}: {
  value: string | undefined;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  // Sentinel value for the "inherit default" option — Radix's Select
  // refuses empty-string values, so we map "" ↔ "__default" at the
  // boundary and store the empty string upstream as before.
  const DEFAULT_VALUE = '__default';
  const selected = value && value.length > 0 ? value : DEFAULT_VALUE;
  const selectedLabel =
    selected === DEFAULT_VALUE
      ? 'Inherit default'
      : (GEZEL_CHAT_FONTS.find((f) => f.id === selected)?.label ?? 'Inherit default');
  const preview = GEZEL_CHAT_FONTS.find((f) => f.id === selected)?.family;
  return (
    <Select.Root
      value={selected}
      onValueChange={(v) => onChange(v === DEFAULT_VALUE ? '' : v)}
      disabled={disabled}
    >
      <Select.Trigger
        className="gezel-font-picker"
        title="Font used for this gezel's chat bubbles"
        style={preview ? { fontFamily: preview } : undefined}
        aria-label="Chat bubble font"
      >
        <Select.Value>{selectedLabel}</Select.Value>
      </Select.Trigger>
      <Select.Content>
        <Select.Item value={DEFAULT_VALUE}>Inherit default</Select.Item>
        {GEZEL_CHAT_FONTS.map((f) => (
          <Select.Item key={f.id} value={f.id} style={{ fontFamily: f.family }}>
            {f.label}
          </Select.Item>
        ))}
      </Select.Content>
    </Select.Root>
  );
}
