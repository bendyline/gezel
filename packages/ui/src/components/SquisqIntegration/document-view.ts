/**
 * The document viewers' View menu, remembered for the whole app.
 *
 * Every viewer that shows a person's file (a project's files and artifacts,
 * the Documents library, a document opened outside-in, a chat reference)
 * spreads `useDocumentViewProps()` onto its `EditorShell`. Turning the
 * outline on in one turns it on in all of them, the ones already open
 * included, and the choice survives a restart. Nothing chosen means the
 * editor's own defaults, so the outline starts hidden. Compact editors (the
 * chat composer, note and about fields) keep their own layout and never read
 * or write this.
 *
 * `config.documentView` is the durable copy. localStorage only lets the first
 * editor paint the choice before the config read lands: the desktop
 * renderer's origin carries the daemon's port, and a moved port hands the
 * window an empty store.
 */

import { type DocumentViewPreferences, DocumentViewPreferencesSchema } from '@bendyline/gezel';
import type { ConfigResponse } from '@bendyline/gezel-client';
import type { EditorShellProps, ViewPreferences } from '@bendyline/squisq-editor-react';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { api } from '../../api.js';
import { useConfig } from '../../data/index.js';

const STORAGE_KEY = 'gezel:document-view:v1';

const NOTHING_CHOSEN: DocumentViewPreferences = Object.freeze({});

let snapshot: DocumentViewPreferences | null = null;
let adopted = false;
/** Counts choices, so a config answer that arrives after one cannot undo it. */
let choices = 0;
const listeners = new Set<() => void>();

/**
 * Only the fields this build understands, each dropped when its value is
 * unknown; squisq's legacy `blockTags` boolean goes, since
 * `blockTagVisibility` says the same thing and wins.
 */
function normalize(value: unknown): DocumentViewPreferences | null {
  const parsed = DocumentViewPreferencesSchema.safeParse(value);
  if (!parsed.success) return null;
  const out: DocumentViewPreferences = {};
  for (const [key, field] of Object.entries(parsed.data)) {
    if (field !== undefined) (out as Record<string, unknown>)[key] = field;
  }
  return out;
}

function samePreferences(a: DocumentViewPreferences, b: DocumentViewPreferences): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) {
      return false;
    }
  }
  return true;
}

function readCache(): DocumentViewPreferences {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return normalize(JSON.parse(raw)) ?? NOTHING_CHOSEN;
  } catch {
    /* unavailable or unreadable: the config read fills it in */
  }
  return NOTHING_CHOSEN;
}

function writeCache(prefs: DocumentViewPreferences): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* unavailable: the config still has it */
  }
}

function getSnapshot(): DocumentViewPreferences {
  if (snapshot === null) snapshot = readCache();
  return snapshot;
}

function publish(next: DocumentViewPreferences): void {
  if (samePreferences(next, getSnapshot())) return;
  snapshot = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** `null` when the config holds no choice; `undefined` means it has not arrived. */
function selectDocumentView(config: ConfigResponse): unknown {
  return config.documentView ?? null;
}

/**
 * Takes the durable choice once per app session, from the first config answer
 * any viewer sees. A config without one (never chosen, or a daemon older than
 * the field) keeps whatever the cache holds, and a choice made before the
 * answer arrived wins over it.
 */
function adoptDurable(value: unknown): void {
  if (adopted || value === undefined) return;
  adopted = true;
  if (choices > 0) return;
  const durable = normalize(value);
  if (!durable) return;
  writeCache(durable);
  publish(durable);
}

/**
 * Records a View menu choice: every open viewer takes it at once, and the
 * config keeps it. Squisq hands over its whole snapshot, so this replaces the
 * stored set rather than merging into it.
 */
export function saveDocumentView(prefs: ViewPreferences): void {
  const next = normalize(prefs);
  if (!next) return;
  choices += 1;
  writeCache(next);
  publish(next);
  void Promise.resolve()
    .then(() => api.updateConfig({ documentView: next }))
    .catch(() => {});
}

export type DocumentViewProps = Pick<
  EditorShellProps,
  'viewPreferences' | 'onViewPreferencesChange'
>;

/**
 * The two `EditorShell` props that make a viewer follow the app-wide View
 * menu choice. The returned object keeps its identity until the choice
 * changes, which is what squisq watches to re-apply it.
 */
export function useDocumentViewProps(): DocumentViewProps {
  const viewPreferences = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const durable = useConfig(selectDocumentView);
  useEffect(() => adoptDurable(durable), [durable]);
  return useMemo(
    () => ({ viewPreferences, onViewPreferencesChange: saveDocumentView }),
    [viewPreferences],
  );
}
