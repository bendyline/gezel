/**
 * DocBlocks-style Export control for Squisq's EditorShell toolbar.
 *
 * Gezel owns host concerns (durable quick-export preferences, local document
 * storage, theme, and the same-origin ffmpeg runtime). Squisq owns document
 * conversion plus the MP4/GIF configuration and encoding UI.
 */

import { useEditorContext } from '@bendyline/squisq-editor-react';
import { PLAYER_BUNDLE } from '@bendyline/squisq-react/standalone-source';
import { VideoExportModal } from '@bendyline/squisq-video-react';
import { markdownToDoc, resolveAudioMapping } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { getThemeSummaries } from '@bendyline/squisq/schemas';
import type { ContentContainer } from '@bendyline/squisq/storage';
import { getTransformStyleSummaries } from '@bendyline/squisq/transform';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DropdownMenu } from '../../primitives/index.js';
import { ExportDialog } from './ExportDialog.js';
import { createContainerMediaProvider } from './container-media-provider.js';
import type { ExportOptions } from './export-options.js';
import {
  DEFAULT_OPTIONS,
  FORMAT_EXTENSIONS,
  loadLastExportOptions,
  saveExportOptions,
  syncLastExportOptions,
} from './export-options.js';
import { GEZEL_FFMPEG_WASM_CONFIG } from './ffmpeg-wasm-config.js';
import { runExport } from './run-export.js';

export interface ExportToolbarControlsProps {
  /** Path of the currently-open file — drives the document download filename. */
  selectedFile: string | null;
  /** Container for local images, media, and narration timing sidecars. */
  mediaContainer?: ContentContainer | null;
  /** Hide MP4/GIF entries on hosts where media export is unavailable. */
  hideVideo?: boolean;
  /** Resolved Gezel theme for Squisq's portaled media-export dialog. */
  colorScheme?: 'light' | 'dark';
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
  hideVideo = false,
  colorScheme = 'light',
}: ExportToolbarControlsProps) {
  const { markdownSource } = useEditorContext();
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [videoModalOpen, setVideoModalOpen] = useState(false);
  const [videoOutputFormat, setVideoOutputFormat] = useState<'mp4' | 'gif'>('mp4');
  const [videoDoc, setVideoDoc] = useState<ReturnType<typeof markdownToDoc> | null>(null);
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoLoadError, setVideoLoadError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [lastOptions, setLastOptions] = useState<ExportOptions | null>(() =>
    loadLastExportOptions(),
  );
  const videoRequestRef = useRef(0);

  const mediaProvider = useMemo(
    () => (mediaContainer ? createContainerMediaProvider(mediaContainer) : null),
    [mediaContainer],
  );

  useEffect(() => {
    return () => mediaProvider?.dispose();
  }, [mediaProvider]);

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

  const handleOpenVideoModal = useCallback(
    async (outputFormat: 'mp4' | 'gif') => {
      const requestId = videoRequestRef.current + 1;
      videoRequestRef.current = requestId;
      setMenuOpen(false);
      setVideoOutputFormat(outputFormat);
      setVideoModalOpen(true);
      setVideoDoc(null);
      setVideoLoadError(null);
      setVideoLoading(true);

      try {
        let nextDoc = markdownToDoc(parseMarkdown(markdownSource));
        if (mediaContainer) {
          nextDoc = await resolveAudioMapping(nextDoc, mediaContainer);
        }
        if (videoRequestRef.current === requestId) setVideoDoc(nextDoc);
      } catch (caught: unknown) {
        if (videoRequestRef.current === requestId) {
          setVideoLoadError(
            caught instanceof Error && caught.message
              ? `Media export could not be prepared: ${caught.message}`
              : 'Media export could not be prepared.',
          );
        }
      } finally {
        if (videoRequestRef.current === requestId) setVideoLoading(false);
      }
    },
    [markdownSource, mediaContainer],
  );

  const handleCloseVideoModal = useCallback(() => {
    videoRequestRef.current += 1;
    setVideoModalOpen(false);
    setVideoDoc(null);
    setVideoLoadError(null);
    setVideoLoading(false);
  }, []);

  const handleExport = useCallback(
    async (options: ExportOptions) => {
      setExporting(true);
      setExportError(null);
      setLastOptions(options);
      try {
        await saveExportOptions(options);
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
            {!hideVideo && (
              <>
                <div className="gezel-export-menu-divider" role="separator" tabIndex={-1} />
                <DropdownMenu.Item
                  className="app-nav-menu-item"
                  onSelect={() => void handleOpenVideoModal('mp4')}
                >
                  Export video…
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="app-nav-menu-item"
                  onSelect={() => void handleOpenVideoModal('gif')}
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

      {videoModalOpen && (videoLoading || videoLoadError) && (
        <Dialog.Root open onOpenChange={(open) => !open && handleCloseVideoModal()}>
          <Dialog.Portal>
            <Dialog.Overlay />
            <Dialog.Content className="gezel-export-loading-dialog">
              <Dialog.Title>
                {videoOutputFormat === 'gif' ? 'Export animated GIF' : 'Export video'}
              </Dialog.Title>
              <p
                className={videoLoadError ? 'error' : 'muted'}
                role={videoLoadError ? 'alert' : undefined}
              >
                {videoLoadError ?? 'Preparing document media…'}
              </p>
              <Dialog.Actions>
                <button type="button" onClick={handleCloseVideoModal}>
                  {videoLoadError ? 'Close' : 'Cancel'}
                </button>
              </Dialog.Actions>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
      )}

      {videoModalOpen && videoDoc && !videoLoading && !videoLoadError && (
        <VideoExportModal
          doc={videoDoc}
          playerScript={PLAYER_BUNDLE}
          {...(mediaProvider ? { mediaProvider } : {})}
          colorScheme={colorScheme}
          defaultConfig={{
            outputFormat: videoOutputFormat,
            audioPolicy: 'best-effort',
            ffmpegWasm: GEZEL_FFMPEG_WASM_CONFIG,
          }}
          onClose={handleCloseVideoModal}
        />
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
