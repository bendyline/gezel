/**
 * Modal for choosing export format + options. Mirrors docblocks's
 * `ExportDialog` — format chip row, conditional theme / page-size /
 * transform / HTML controls. CSS class names use a `gezel-export-`
 * prefix so styles can live alongside the rest of gezel's UI.
 */

import { getThemeSummaries } from '@bendyline/squisq/schemas';
import { getTransformStyleSummaries } from '@bendyline/squisq/transform';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExportFormat, ExportOptions, HtmlBundle, HtmlStyle } from './export-options.js';
import { FORMAT_LABELS, saveExportOptions } from './export-options.js';

export interface ExportDialogProps {
  initial: ExportOptions;
  exporting: boolean;
  onExport: (options: ExportOptions) => void;
  onClose: () => void;
}

const FORMATS: ExportFormat[] = ['pdf', 'docx', 'pptx', 'html', 'md'];

const FORMAT_CHIP_LABELS: Record<ExportFormat, string> = {
  pdf: 'PDF',
  docx: 'Word',
  pptx: 'PowerPoint',
  html: 'HTML',
  md: 'Markdown',
};

const HTML_STYLE_CHIPS: { key: HtmlStyle; label: string; hint: string }[] = [
  {
    key: 'plain',
    label: 'Plain',
    hint: 'A lightweight static HTML document.',
  },
  {
    key: 'rendered',
    label: 'Rendered',
    hint: 'Renders via SquisqPlayer with themes and playback support.',
  },
];

const HTML_BUNDLE_CHIPS: { key: HtmlBundle; label: string; hint: string }[] = [
  {
    key: 'single',
    label: 'Single file',
    hint: 'One .html file with images embedded as base64 data URIs.',
  },
  {
    key: 'zip',
    label: 'ZIP archive',
    hint: 'A .zip with index.html plus separate image (and JS) files.',
  },
];

interface ChipOption<T extends string> {
  key: T;
  label: string;
  title?: string;
}

function ChipRadioGroup<T extends string>({
  name,
  value,
  options,
  onChange,
}: {
  name: string;
  value: T;
  options: ChipOption<T>[];
  onChange: (next: T) => void;
}) {
  return (
    <fieldset className="gezel-export-chips" aria-label={name}>
      {options.map((opt) => {
        const active = opt.key === value;
        return (
          <button
            key={opt.key}
            type="button"
            aria-pressed={active}
            className={`gezel-export-chip${active ? ' gezel-export-chip--active' : ''}`}
            onClick={() => onChange(opt.key)}
            title={opt.title}
          >
            {opt.label}
          </button>
        );
      })}
    </fieldset>
  );
}

export function ExportDialog({ initial, exporting, onExport, onClose }: ExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>(initial.format);
  const [themeId, setThemeId] = useState(initial.themeId);
  const [transformStyle, setTransformStyle] = useState(initial.transformStyle);
  const [pageSize, setPageSize] = useState(initial.pageSize);
  const [htmlStyle, setHtmlStyle] = useState<HtmlStyle>(initial.htmlStyle);
  const [htmlBundle, setHtmlBundle] = useState<HtmlBundle>(initial.htmlBundle);
  const dialogRef = useRef<HTMLDivElement>(null);

  const themes = getThemeSummaries();
  const transforms = getTransformStyleSummaries();

  const showTheme =
    format === 'docx' ||
    format === 'pdf' ||
    format === 'pptx' ||
    (format === 'html' && htmlStyle === 'rendered');
  const showTransform = format === 'pptx';
  const showPageSize = format === 'pdf';
  const showHtmlOptions = format === 'html';

  const handleExport = useCallback(() => {
    const opts: ExportOptions = {
      format,
      themeId,
      transformStyle,
      pageSize,
      htmlStyle,
      htmlBundle,
    };
    saveExportOptions(opts);
    onExport(opts);
  }, [format, themeId, transformStyle, pageSize, htmlStyle, htmlBundle, onExport]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: backdrop is mouse-only; keyboard users close via the existing Escape handler + the Cancel button
    <div className="gezel-dialog-overlay" onClick={handleBackdropClick}>
      <div className="gezel-dialog gezel-export-dialog" ref={dialogRef}>
        <div className="gezel-dialog-header">
          <h2 className="gezel-dialog-title">Export Document</h2>
          <button type="button" className="gezel-dialog-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="gezel-dialog-body">
          <div className="gezel-export-field">
            <span className="gezel-export-label">Format</span>
            <ChipRadioGroup
              name="Format"
              value={format}
              options={FORMATS.map((f) => ({
                key: f,
                label: FORMAT_CHIP_LABELS[f],
                title: FORMAT_LABELS[f],
              }))}
              onChange={setFormat}
            />
          </div>

          {showHtmlOptions && (
            <>
              <div className="gezel-export-field">
                <span className="gezel-export-label">Style</span>
                <ChipRadioGroup
                  name="Style"
                  value={htmlStyle}
                  options={HTML_STYLE_CHIPS}
                  onChange={setHtmlStyle}
                />
                <span className="gezel-export-hint">
                  {HTML_STYLE_CHIPS.find((c) => c.key === htmlStyle)?.hint}
                </span>
              </div>
              <div className="gezel-export-field">
                <span className="gezel-export-label">Bundle</span>
                <ChipRadioGroup
                  name="Bundle"
                  value={htmlBundle}
                  options={HTML_BUNDLE_CHIPS}
                  onChange={setHtmlBundle}
                />
                <span className="gezel-export-hint">
                  {HTML_BUNDLE_CHIPS.find((c) => c.key === htmlBundle)?.hint}
                </span>
              </div>
            </>
          )}

          {showTheme && (
            <div className="gezel-export-field">
              <label className="gezel-export-label" htmlFor="gezel-export-theme">
                Theme
              </label>
              <select
                id="gezel-export-theme"
                className="gezel-export-select"
                value={themeId}
                onChange={(e) => setThemeId(e.target.value)}
              >
                {themes.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <span className="gezel-export-hint">
                {themes.find((t) => t.id === themeId)?.description}
              </span>
            </div>
          )}

          {showTransform && (
            <div className="gezel-export-field">
              <label className="gezel-export-label" htmlFor="gezel-export-transform">
                Transform
              </label>
              <select
                id="gezel-export-transform"
                className="gezel-export-select"
                value={transformStyle}
                onChange={(e) => setTransformStyle(e.target.value)}
              >
                {transforms.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <span className="gezel-export-hint">
                {transforms.find((t) => t.id === transformStyle)?.description}
              </span>
            </div>
          )}

          {showPageSize && (
            <div className="gezel-export-field">
              <label className="gezel-export-label" htmlFor="gezel-export-pagesize">
                Page Size
              </label>
              <select
                id="gezel-export-pagesize"
                className="gezel-export-select"
                value={pageSize}
                onChange={(e) => setPageSize(e.target.value as 'letter' | 'a4')}
              >
                <option value="letter">US Letter</option>
                <option value="a4">A4</option>
              </select>
            </div>
          )}
        </div>

        <div className="gezel-export-footer">
          <button
            type="button"
            className="gezel-export-btn gezel-export-btn--secondary"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className="gezel-export-btn gezel-export-btn--primary"
            onClick={handleExport}
            disabled={exporting}
          >
            {exporting ? 'Exporting…' : 'Export'}
          </button>
        </div>
      </div>
    </div>
  );
}
