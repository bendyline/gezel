import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The visual system's few rules, checked on the stylesheets themselves
// (jsdom computes no cascade): the type scale, the one treatment for a
// selected row, the three status colors and the paper ramp. See docs/ux.md →
// "The size scale" and "What that translates into" → Color.
const SRC = resolve(import.meta.dirname, '..');
const foundation = readFileSync(resolve(import.meta.dirname, 'foundation.css'), 'utf8');
const lightRoot = foundation.match(/^:root \{([\s\S]*?)^\}/m)?.[1] ?? '';

function stylesheets(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return stylesheets(path);
    return name.endsWith('.css') ? [path] : [];
  });
}

interface Rule {
  file: string;
  selector: string;
  body: string;
}

/** Every innermost rule of every stylesheet, comments removed. */
function rules(): Rule[] {
  return stylesheets(SRC).flatMap((path) => {
    const text = readFileSync(path, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const file = relative(SRC, path).replace(/\\/g, '/');
    return [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector = '', body = '']) => ({
      file,
      selector: selector.trim().replace(/\s+/g, ' '),
      body,
    }));
  });
}

function rootToken(name: string): string {
  const value = lightRoot.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1]?.trim();
  if (!value) throw new Error(`--${name} is not declared in :root`);
  return value;
}

/** A token's size in px at the 16px root, following one alias. */
function sizeOf(name: string): number {
  const value = rootToken(name);
  const alias = value.match(/^var\(--([\w-]+)\)$/)?.[1];
  if (alias) return sizeOf(alias);
  const rem = value.match(/^([\d.]+)rem$/)?.[1];
  if (!rem) throw new Error(`--${name} is not a rem size: ${value}`);
  return Number(rem) * 16;
}

const SCALE = ['text-2xs', 'text-xs', 'text-sm', 'text-md', 'text-lg', 'text-xl', 'text-title'];

describe('the type scale', () => {
  // The scale once ran 11.5 / 12.8 / 13.6 / 14.4px: four sizes inside three
  // pixels, and three quarters of the text on Home, Tasks and Settings was
  // under 14px.
  it('has six sizes, none under 13px, with body and controls one size of 15px or more', () => {
    const sizes = SCALE.map(sizeOf);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(13);
    expect(new Set(sizes).size).toBe(6);
    expect(sizeOf('text-md')).toBeGreaterThanOrEqual(15);
    expect(sizeOf('text-sm')).toBe(sizeOf('text-md'));
    expect([...sizes].sort((a, b) => a - b)).toEqual(sizes);
  });

  it('gives a bare control and a bare heading a size from the scale', () => {
    expect(foundation).toMatch(
      /:where\(button, input, textarea, select\) \{\s*font-size: var\(--text-md\);/,
    );
    expect(foundation).toMatch(/:where\(h1\) \{\s*font-size: var\(--text-title\);/);
    expect(foundation).toMatch(/:where\(h3\) \{\s*font-size: var\(--text-lg\);/);
  });

  // Glyphs are drawings and the phone header's corner counts are marks, so
  // both are sized on their own; everything else that sets a literal size
  // under the floor is chrome text someone has to read.
  it('sets no literal chrome text size under the 13px floor', () => {
    const glyphOrMark =
      /(-close\b|-caret\b|-toggle\b|-expand\b|-arrow\b|-sigil\b|-lock\b|-badge\b|-count\b|tree-icon|icon-fallback|narration-control small)/;
    const small = rules()
      .filter((rule) => !/(^|\/)ResponsiveAppShell\.mobile\.css$/.test(rule.file))
      .filter((rule) => !glyphOrMark.test(rule.selector))
      .flatMap((rule) => {
        const value = /font-size:\s*([\d.]+)(px|rem)\b/.exec(rule.body);
        if (!value) return [];
        const px = Number(value[1]) * (value[2] === 'rem' ? 16 : 1);
        return px < 13 ? [`${rule.file}: ${rule.selector} (${value[1]}${value[2]})`] : [];
      });
    expect(small).toEqual([]);
  });
});

describe('the one treatment for a selected row', () => {
  // A selected row was sage in Tasks, History and Plans, tan in Crew and the
  // rail, blue in the chat rail, gray in the GitHub lists and cyan in the
  // terminal's folder tree.
  const LIST_ROWS = [
    '.task-row-selected',
    '.history-row-selected',
    '.tree-row-selected',
    '.gezel-row.active',
    '.settings-nav-item-active',
    '.chat-rail-ref-active',
    '.memories-tree-leaf-active',
    '.dp-list-item-active',
    '.gh-changes-list li.is-selected',
    '.gh-timeline-item.is-selected',
    '.knowledge-doc-row[aria-current="true"]',
    '.handboek-toc-entry-active',
    '.codebase-guide-file[aria-current="true"]',
    '.reports-list-item[aria-current="true"]',
    '.folder-tree-node.active',
    '.new-craftbook-picker-row.active',
    '.gz-npd-rail-item.active',
  ];

  it('paints every list row from the selection token', () => {
    const all = rules();
    const offenders = LIST_ROWS.flatMap((needle) => {
      // The navigation rail's active row is a tab bridged into the content
      // beside it, a different pattern with its own face.
      const painted = all.filter(
        (rule) =>
          rule.selector.includes(needle) &&
          !rule.selector.includes('.app-sidebar-') &&
          /background(-color)?:/.test(rule.body),
      );
      if (painted.length === 0) return [`${needle}: no rule paints it`];
      return painted
        .filter((rule) => !/background(-color)?:\s*var\(--selected-bg(-hover)?\)/.test(rule.body))
        .map((rule) => `${rule.file}: ${rule.selector}`);
    });
    expect(offenders).toEqual([]);
  });

  it('keeps cool blue out of the chrome', () => {
    const blue = rules()
      .filter((rule) => /rgba\(79, 125, 255/.test(rule.body))
      .map((rule) => `${rule.file}: ${rule.selector}`);
    expect(blue).toEqual([]);
  });
});

describe('the three status colors', () => {
  it('names needs-you, working and ready once, from the palette', () => {
    expect(rootToken('status-attention')).toBe('var(--warning)');
    expect(rootToken('status-working')).toBe('var(--accent)');
    expect(rootToken('status-ready')).toBe('var(--gezel-sage-lit)');
    expect(rootToken('warning')).toBe('var(--gezel-ochre)');
  });

  // The panel carried nine colors of its own: blush, honey and sage, each
  // with a wash and an edge, authored again for dark.
  it('leaves the Activity panel no palette of its own', () => {
    const activity = readFileSync(resolve(import.meta.dirname, 'activity.css'), 'utf8');
    expect(activity).toMatch(/\[data-tone="attention"\] \{\s*--tone: var\(--status-attention\);/);
    expect(activity).toMatch(/\[data-tone="active"\] \{\s*--tone: var\(--status-working\);/);
    expect(activity).toMatch(/\[data-tone="done"\] \{\s*--tone: var\(--status-ready\);/);
    expect(activity).not.toMatch(/--activity-(attention|active|done)/);
  });

  // A zone held bordered cards that held inset strips, three boxes deep, and
  // the engine's rows had a shape of their own beside the panel's.
  it('makes the Activity zone the only box, with one row shape inside it', () => {
    const activity = readFileSync(resolve(import.meta.dirname, 'activity.css'), 'utf8');
    const card = activity.slice(activity.indexOf('.activity-question .pending-question {'));
    expect(card.slice(0, card.indexOf('}'))).toMatch(/border: 0;[\s\S]*background: transparent;/);
    expect(activity).toMatch(
      /\.activity-row,\s*\.activity-queue \.queue-meter-panel-item \{[^}]*grid-template-columns:/,
    );
  });

  it("draws a task's dot from the same three", () => {
    const tasks = readFileSync(resolve(import.meta.dirname, 'tasks.css'), 'utf8');
    expect(tasks).toMatch(
      /\.task-status-dot\.task-status-active \{\s*background: var\(--status-working\);/,
    );
    expect(tasks).toMatch(
      /\.task-status-dot\.task-status-complete \{\s*background: var\(--status-ready\);/,
    );
    expect(tasks).not.toMatch(/\.task-status-dot[^{]*\{[^}]*#[0-9a-f]{6}/i);
  });
});

describe('the title bar: one key and one well', () => {
  const shell = readFileSync(resolve(import.meta.dirname, 'app-shell.css'), 'utf8');
  const activity = readFileSync(resolve(import.meta.dirname, 'activity.css'), 'utf8');

  function bodyOf(stylesheet: string, selector: string): string {
    const start = stylesheet.indexOf(`${selector} {`);
    if (start < 0) throw new Error(`no rule for ${selector}`);
    return stylesheet.slice(start, stylesheet.indexOf('}', start));
  }

  // The bar showed five styles across seven controls: a tray of small flat
  // keys, a borderless brand tile, a well with a keycap in it, raised pills
  // and a tray holding one key.
  it('draws no tray, tile or keycap of its own on the bar', () => {
    for (const selector of ['.app-header-tray', '.app-header-history', '.app-header-brand']) {
      expect(bodyOf(shell, selector), selector).not.toMatch(/background|box-shadow|border:/);
    }
    expect(bodyOf(shell, '.titlebar-search-shortcut')).not.toMatch(/background|border/);
    // The brand takes its face from the shared key recipe.
    expect(shell).toMatch(/\.app-header\s+:is\(\s+\.app-header-brand,\s+\.activity-control,/);
  });

  // Sized to their words, Activity and the engine key resized on every
  // phase, progress bar and tick of the clock, and shoved each other about.
  it('gives the two status keys one fixed width', () => {
    expect(rootToken('titlebar-status-w')).toMatch(/^[\d.]+rem$/);
    expect(bodyOf(shell, '.app-header .engine-pill')).toMatch(
      /width:\s*var\(--titlebar-status-w\)/,
    );
    expect(bodyOf(activity, '.activity-control[data-density="full"]')).toMatch(
      /width:\s*var\(--titlebar-status-w\)/,
    );
  });
});

describe('one paper, in steps of lightness', () => {
  /** OKLCH hue and chroma of a hex color. */
  function hueAndChroma(hex: string): { hue: number; chroma: number } {
    const [r = 0, g = 0, b = 0] = [1, 3, 5].map((start) => {
      const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    return { hue: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360, chroma: Math.hypot(a, bb) };
  }

  // The reading, workshop and control papers leaned rose (hue 55-70) beside
  // the yellow chrome (hue 88), so a chat bubble read pink next to the rail.
  it('keeps every light paper on the parchment hue', () => {
    const papers = [
      'canvas',
      'workshop',
      'panel',
      'reading',
      'reading-inset',
      'handoff',
      'control',
      'control-deep',
      'inset',
    ];
    for (const name of papers) {
      const { hue, chroma } = hueAndChroma(rootToken(`gezel-paper-${name}`));
      expect(hue, `--gezel-paper-${name} hue`).toBeGreaterThan(80);
      expect(hue, `--gezel-paper-${name} hue`).toBeLessThan(96);
      expect(chroma, `--gezel-paper-${name} chroma`).toBeLessThan(0.035);
    }
  });
});
