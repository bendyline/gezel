/**
 * DocBlocks-style Export control for Squisq's EditorShell toolbar.
 *
 * Gezel owns host concerns (durable quick-export preferences, local document
 * storage, and native MP4/GIF routing). Squisq owns document conversion and
 * the daemon-side rendered-media pipeline.
 */

import type { DocumentMediaExportSource } from '@bendyline/gezel';
import { useEditorContext } from '@bendyline/squisq-editor-react';
import { getThemeSummaries } from '@bendyline/squisq/schemas';
import type { ContentContainer } from '@bendyline/squisq/storage';
import { getTransformStyleSummaries } from '@bendyline/squisq/transform';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { Dialog, DropdownMenu } from '../../primitives/index.js';
import { ExportDialog } from './ExportDialog.js';
import { downloadBlob } from './download-blob.js';
import type { ExportOptions } from './export-options.js';
import {
  DEFAULT_OPTIONS,
  FORMAT_EXTENSIONS,
  loadLastExportOptions,
  saveExportOptions,
  syncLastExportOptions,
} from './export-options.js';

export interface ExportToolbarControlsProps {
  /** Path of the currently-open file — drives the document download filename. */
  selectedFile: string | null;
  /** Container for local images, media, and narration timing sidecars. */
  mediaContainer?: ContentContainer | null;
  /** Store scope the daemon uses to resolve MP4/GIF media sidecars. */
  mediaSource?: DocumentMediaExportSource;
}

function exportErrorMessage(caught: unknown): string {
  const detail = caught instanceof Error ? caught.message.trim() : '';
  return detail ? `Export failed: ${detail}` : 'Export failed. The document was not exported.';
}

function quickLabel(opts: ExportOptions): string {
  const baseExt = FORMAT_EXTENSIONS[opts.format].toUpperCase().replace('.', '');
  const ext = opts.format === 'html' && opts.htmlBundle === 'zip' ? 'ZIP' : baseExt;
  const parts: string[] = [];
  if (opts.format === 'html' && opts.htmlStyle === 'rendered') {
    parts.push('rendered');
  }
  if (opts.themeId !== 'standard' && (opts.format !== 'html' || opts.htmlStyle === 'rendered')) {
    const theme = getThemeSummaries().find((candidate) => candidate.id === opts.themeId);
    if (theme) parts.push(theme.name);
  }
  if (opts.format === 'pptx' && opts.transformStyle) {
    const transform = getTransformStyleSummaries().find(
      (candidate) => candidate.id === opts.transformStyle,
    );
    if (transform) parts.push(transform.name);
  }
  return parts.length > 0 ? `Export ${ext} with ${parts.join(' + ')}` : `Export ${ext}`;
}

export function ExportToolbarControls({
  selectedFile,
  mediaContainer,
  mediaSource,
}: ExportToolbarControlsProps) {
  const { markdownSource } = useEditorContext();
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [mediaExporting, setMediaExporting] = useState<'mp4' | 'gif' | null>(null);
  const [mediaExportError, setMediaExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [lastOptions, setLastOptions] = useState<ExportOptions | null>(() =>
    loadLastExportOptions(),
  );
  const mediaAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => mediaAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void syncLastExportOptions().then((options) => {
      if (!cancelled) setLastOptions(options);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleOpenDialog = useCallback(() => {
    setMenuOpen(false);
    setExportError(null);
    setDialogOpen(true);
  }, []);

  const handleCloseDialog = useCallback(() => {
    if (exporting) return;
    setDialogOpen(false);
    setExportError(null);
  }, [exporting]);

  const handleMediaExport = useCallback(
    async (outputFormat: 'mp4' | 'gif') => {
      if (!selectedFile || !mediaSource) return;
      const controller = new AbortController();
      mediaAbortRef.current?.abort();
      mediaAbortRef.current = controller;
      setMenuOpen(false);
      setMediaExporting(outputFormat);
      setMediaExportError(null);

      try {
        const blob = await api.exportDocumentMedia(
          {
            markdown: markdownSource,
            selectedFile,
            format: outputFormat,
            source: mediaSource,
          },
          controller.signal,
        );
        if (controller.signal.aborted) return;
        const tail = selectedFile.split('/').pop() ?? selectedFile;
        const stem = tail.replace(/\.[^.]+$/, '') || 'document';
        downloadBlob(blob, `${stem}.${outputFormat}`);
        setMediaExporting(null);
      } catch (caught: unknown) {
        if (controller.signal.aborted) return;
        setMediaExportError(exportErrorMessage(caught));
      } finally {
        if (mediaAbortRef.current === controller) mediaAbortRef.current = null;
      }
    },
    [markdownSource, mediaSource, selectedFile],
  );

  const handleCloseMediaExport = useCallback(() => {
    mediaAbortRef.current?.abort();
    mediaAbortRef.current = null;
    setMediaExporting(null);
    setMediaExportError(null);
  }, []);

  const handleExport = useCallback(
    async (options: ExportOptions) => {
      setExporting(true);
      setExportError(null);
      setLastOptions(options);
      try {
        await saveExportOptions(options);
        const { runExport } = await import('./run-export.js');
        await runExport(markdownSource, selectedFile, options, mediaContainer);
        setDialogOpen(false);
      } catch (caught: unknown) {
        setExportError(exportErrorMessage(caught));
      } finally {
        setExporting(false);
      }
    },
    [markdownSource, selectedFile, mediaContainer],
  );

  const handleQuickExport = useCallback(async () => {
    if (!lastOptions) return;
    setMenuOpen(false);
    setExporting(true);
    setExportError(null);
    try {
      const { runExport } = await import('./run-export.js');
      await runExport(markdownSource, selectedFile, lastOptions, mediaContainer);
    } catch (caught: unknown) {
      setExportError(exportErrorMessage(caught));
      setDialogOpen(true);
    } finally {
      setExporting(false);
    }
  }, [lastOptions, markdownSource, selectedFile, mediaContainer]);

  return (
    <>
      <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="squisq-toolbar-button gezel-export-trigger"
            aria-label="Export document"
            title="Export document"
            disabled={exporting}
          >
            <ShareGlyph />
            <span>Export</span>
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            className="app-nav-menu gezel-export-menu"
            sideOffset={4}
            align="end"
          >
            {lastOptions && (
              <DropdownMenu.Item
                className="app-nav-menu-item"
                onSelect={() => void handleQuickExport()}
                disabled={exporting}
              >
                {quickLabel(lastOptions)}
              </DropdownMenu.Item>
            )}
            <DropdownMenu.Item className="app-nav-menu-item" onSelect={handleOpenDialog}>
              Export…
            </DropdownMenu.Item>
            {selectedFile && mediaSource && (
              <>
                <div className="gezel-export-menu-divider" role="separator" tabIndex={-1} />
                <DropdownMenu.Item
                  className="app-nav-menu-item"
                  onSelect={() => void handleMediaExport('mp4')}
                >
                  Export video…
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="app-nav-menu-item"
                  onSelect={() => void handleMediaExport('gif')}
                >
                  Export animated GIF…
                </DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {dialogOpen && (
        <ExportDialog
          initial={lastOptions ?? DEFAULT_OPTIONS}
          exporting={exporting}
          error={exportError}
          onExport={(options) => void handleExport(options)}
          onClose={handleCloseDialog}
        />
      )}

      {(mediaExporting || mediaExportError) && (
        <Dialog.Root open onOpenChange={(open) => !open && handleCloseMediaExport()}>
          <Dialog.Portal>
            <Dialog.Overlay />
            <Dialog.Content className="gezel-export-loading-dialog">
              <Dialog.Title>
                {mediaExporting === 'gif' ? 'Exporting animated GIF' : 'Exporting video'}
              </Dialog.Title>
              <p
                className={mediaExportError ? 'error' : 'muted'}
                role={mediaExportError ? 'alert' : 'status'}
              >
                {mediaExportError ??
                  'Rendering with the ffmpeg installed on this computer. This can take a while…'}
              </p>
              <Dialog.Actions>
                <button type="button" onClick={handleCloseMediaExport}>
                  {mediaExportError ? 'Close' : 'Cancel'}
                </button>
              </Dialog.Actions>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}
    </>
  );
}

function ShareGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 10.5V1.75" />
      <path d="M5.25 4.5 8 1.75l2.75 2.75" />
      <path d="M4.25 6.75h-1a1.5 1.5 0 0 0-1.5 1.5v4.5a1.5 1.5 0 0 0 1.5 1.5h9.5a1.5 1.5 0 0 0 1.5-1.5v-4.5a1.5 1.5 0 0 0-1.5-1.5h-1" />
    </svg>
  );
}
