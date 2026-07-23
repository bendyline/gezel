/**
 * Toolbar-right slot content for `EditorShell`.
 *
 * Renders a "…" overflow menu containing:
 *   - Quick-export action (only when a previous export's options are
 *     persisted) — reruns the last format without showing the dialog.
 *   - Export… — opens {@link ExportDialog} for format + options.
 *   - Export Video… — opens squisq's {@link VideoExportModal}.
 *
 * Must be rendered inside `<EditorProvider>` so `useEditorContext()`
 * can read the live markdown source. Mirrors docblocks's
 * `ExportToolbarControls` 1:1.
 */

import { useEditorContext } from '@bendyline/squisq-editor-react';
import { PLAYER_BUNDLE } from '@bendyline/squisq-react/standalone-source';
import { VideoExportModal } from '@bendyline/squisq-video-react';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { getThemeSummaries } from '@bendyline/squisq/schemas';
import type { ContentContainer } from '@bendyline/squisq/storage';
import { getTransformStyleSummaries } from '@bendyline/squisq/transform';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ExportDialog } from './ExportDialog.js';
import type { ExportOptions } from './export-options.js';
import {
  DEFAULT_OPTIONS,
  FORMAT_EXTENSIONS,
  loadLastExportOptions,
  saveExportOptions,
} from './export-options.js';
import { runExport } from './run-export.js';

export interface ExportToolbarControlsProps {
  /** Path of the currently-open file — drives the download filename. */
  selectedFile: string | null;
  /** Container for resolving local image references during export. */
  mediaContainer?: ContentContainer | null;
  /** Hide the Video export entry. Set when the player-bundle path can't reach video infra. */
  hideVideo?: boolean;
}

function quickLabel(opts: ExportOptions): string {
  const baseExt = FORMAT_EXTENSIONS[opts.format].toUpperCase().replace('.', '');
  const ext = opts.format === 'html' && opts.htmlBundle === 'zip' ? 'ZIP' : baseExt;
  const parts: string[] = [];
  if (opts.format === 'html' && opts.htmlStyle === 'rendered') {
    parts.push('rendered');
  }
  if (opts.themeId !== 'standard' && (opts.format !== 'html' || opts.htmlStyle === 'rendered')) {
    const theme = getThemeSummaries().find((t) => t.id === opts.themeId);
    if (theme) parts.push(theme.name);
  }
  if (opts.format === 'pptx' && opts.transformStyle) {
    const transform = getTransformStyleSummaries().find((t) => t.id === opts.transformStyle);
    if (transform) parts.push(transform.name);
  }
  if (parts.length > 0) {
    return `Export ${ext} with ${parts.join(' + ')}`;
  }
  return `Export ${ext}`;
}

export function ExportToolbarControls({
  selectedFile,
  mediaContainer,
  hideVideo = false,
}: ExportToolbarControlsProps) {
  const { markdownSource } = useEditorContext();
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [videoModalOpen, setVideoModalOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const lastOptions = loadLastExportOptions();

  const doc = useMemo(() => {
    if (!videoModalOpen) return null;
    const mdDoc = parseMarkdown(markdownSource);
    return markdownToDoc(mdDoc);
  }, [videoModalOpen, markdownSource]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen]);

  const handleToggleMenu = useCallback(() => setMenuOpen((p) => !p), []);
  const handleOpenDialog = useCallback(() => {
    setMenuOpen(false);
    setDialogOpen(true);
  }, []);
  const handleCloseDialog = useCallback(() => setDialogOpen(false), []);
  const handleOpenVideoModal = useCallback(() => {
    setMenuOpen(false);
    setVideoModalOpen(true);
  }, []);
  const handleCloseVideoModal = useCallback(() => setVideoModalOpen(false), []);

  const handleExport = useCallback(
    async (opts: ExportOptions) => {
      setExporting(true);
      try {
        await runExport(markdownSource, selectedFile, opts, mediaContainer);
      } finally {
        setExporting(false);
        setDialogOpen(false);
      }
    },
    [markdownSource, selectedFile, mediaContainer],
  );

  const handleQuickExport = useCallback(async () => {
    if (!lastOptions) return;
    setMenuOpen(false);
    setExporting(true);
    try {
      saveExportOptions(lastOptions);
      await runExport(markdownSource, selectedFile, lastOptions, mediaContainer);
    } finally {
      setExporting(false);
    }
  }, [lastOptions, markdownSource, selectedFile, mediaContainer]);

  return (
    <>
      <div className="gezel-toolbar-menu" ref={menuRef}>
        <button
          type="button"
          className="gezel-toolbar-menu-trigger"
          onClick={handleToggleMenu}
          aria-label="More actions"
          title="More actions"
        >
          &middot;&middot;&middot;
        </button>

        {menuOpen && (
          <div className="gezel-toolbar-menu-dropdown">
            {lastOptions && (
              <button
                type="button"
                className="gezel-toolbar-menu-item"
                onClick={handleQuickExport}
                disabled={exporting}
              >
                {quickLabel(lastOptions)}
              </button>
            )}
            <button type="button" className="gezel-toolbar-menu-item" onClick={handleOpenDialog}>
              Export…
            </button>
            {!hideVideo && (
              <>
                <div className="gezel-toolbar-menu-divider" />
                <button
                  type="button"
                  className="gezel-toolbar-menu-item"
                  onClick={handleOpenVideoModal}
                >
                  Export Video…
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {dialogOpen && (
        <ExportDialog
          initial={lastOptions ?? DEFAULT_OPTIONS}
          exporting={exporting}
          onExport={handleExport}
          onClose={handleCloseDialog}
        />
      )}

      {videoModalOpen && doc && (
        <VideoExportModal doc={doc} playerScript={PLAYER_BUNDLE} onClose={handleCloseVideoModal} />
      )}
    </>
  );
}
