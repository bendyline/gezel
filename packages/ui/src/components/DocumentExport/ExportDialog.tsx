/**
 * Modal for choosing export format + options. The conditional fields mirror
 * DocBlocks while the dialog and choice controls use Gezel's shared Radix and
 * keys-in-trays primitives.
 */

import { getThemeSummaries } from '@bendyline/squisq/schemas';
import { getTransformStyleSummaries } from '@bendyline/squisq/transform';
import { type FormEvent, useCallback, useState } from 'react';
import { Dialog } from '../../primitives/index.js';
import type { ExportFormat, ExportOptions, HtmlBundle, HtmlStyle } from './export-options.js';
import { FORMAT_LABELS } from './export-options.js';

export interface ExportDialogProps {
  initial: ExportOptions;
  exporting: boolean;
  error?: string | null;
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
    <fieldset className="gezel-export-choice-tray gz-tray" aria-label={name}>
      {options.map((opt) => {
        const active = opt.key === value;
        return (
          <label
            key={opt.key}
            className={`gz-key${active ? ' gz-key-active' : ''}`}
            title={opt.title}
          >
            <input
              type="radio"
              className="gezel-export-choice-radio"
              name={name}
              value={opt.key}
              checked={active}
              onChange={() => onChange(opt.key)}
            />
            {opt.label}
          </label>
        );
      })}
    </fieldset>
  );
}

export function ExportDialog({
  initial,
  exporting,
  error = null,
  onExport,
  onClose,
}: ExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>(initial.format);
  const [themeId, setThemeId] = useState(initial.themeId);
  const [transformStyle, setTransformStyle] = useState(initial.transformStyle);
  const [pageSize, setPageSize] = useState(initial.pageSize);
  const [htmlStyle, setHtmlStyle] = useState<HtmlStyle>(initial.htmlStyle);
  const [htmlBundle, setHtmlBundle] = useState<HtmlBundle>(initial.htmlBundle);

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

  const handleExport = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const opts: ExportOptions = {
        format,
        themeId,
        transformStyle,
        pageSize,
        htmlStyle,
        htmlBundle,
      };
      onExport(opts);
    },
    [format, themeId, transformStyle, pageSize, htmlStyle, htmlBundle, onExport],
  );

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content className="gezel-export-dialog">
          <form onSubmit={handleExport}>
            <div className="gezel-export-dialog-header">
              <Dialog.Title>Export document</Dialog.Title>
              <Dialog.Close asChild>
                <button type="button" className="gezel-export-dialog-close" aria-label="Close">
                  &times;
                </button>
              </Dialog.Close>
            </div>

            <div className="gezel-export-dialog-body">
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
                    Page size
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

              {error && (
                <p className="error small" role="alert">
                  {error}
                </p>
              )}
            </div>

            <Dialog.Actions>
              <Dialog.Close asChild>
                <button type="button" disabled={exporting}>
                  Cancel
                </button>
              </Dialog.Close>
              <button type="submit" className="primary" disabled={exporting}>
                {exporting ? 'Exporting…' : 'Export'}
              </button>
            </Dialog.Actions>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
