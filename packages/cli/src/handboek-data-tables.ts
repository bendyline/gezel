import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import {
  SCORECARD_DATA_ATTRS,
  type ScorecardDevice,
  scorecardHardwareKey,
  scorecardModelFamilyId,
} from '@bendyline/gezel';
import { defaultDataReaders } from '@bendyline/squisq-formats/data';
import { isDataFilePath, resolveDataReferences } from '@bendyline/squisq/doc';
import type { Block, Doc } from '@bendyline/squisq/schemas';
import { MemoryContentContainer } from '@bendyline/squisq/storage';
import { SCORECARD_TABLE_EVENT, SCORECARD_VIEW_EVENT } from './handboek-site-scorecard.js';

/**
 * Sidecar data tables on the static Handboek site.
 *
 * An article references a data file the way any squisq document does — a
 * heading annotation plus a plain link, which is all the app, the plain
 * renderer, and a reader without scripts ever see:
 *
 *   ### Every result {[dataTable src=../assets/scorecards/all-results.csv previewRows=5000]}
 *
 *   [Download every result as CSV](../assets/scorecards/all-results.csv)
 *
 * On the site the export resolves the file at build time, and the page draws
 * it with the squisq player — the bundle the watch pages already run — in
 * static mode, so it needs no CSV parser and shows the same bytes as the
 * download. The player's table is static by design; once it is drawn,
 * `data-table.js` takes a copy it owns (React would otherwise reconcile its
 * sorted rows back on the next render), unmounts the player, and adds
 * sorting and per-column filters.
 *
 * Three annotation parameters are Handboek extensions rather than squisq
 * ones (squisq keeps unknown parameters on the annotation and ignores them):
 *
 * - `columns=a,b,c` — the download keeps every column; the page shows the
 *   ones named, in that order.
 * - `group=column` — consecutive rows sharing that column's value sit under
 *   one heading row while the table is in the file's own order; sorting by a
 *   column interleaves them, so the headings step aside until it is undone.
 *   The column need not be one the page shows.
 * - `follow=scorecard` — the section moves under the model scorecard's
 *   pickers and narrows with them, so the table always shows the rounds,
 *   hardware, model, and class the reader picked. Needs `run_id`,
 *   `platform`, `model_id`, and `tier` among the file's columns.
 */

export const DATA_TABLE_SCRIPT = 'data-table.js';
export const DATA_TABLE_ATTR = 'data-hb-data-table';
/** On the section that wraps a table following the scorecard's pickers. */
export const DATA_TABLE_FOLLOW_ATTR = 'data-hb-data-table-follow';

export interface DataTableMount {
  src: string;
  title: string;
  /** `scorecard` when the section should sit under the scorecard pickers. */
  follow?: string;
  html: string;
}

interface TableData {
  headers?: string[];
  rows?: string[][];
  align?: ('left' | 'center' | 'right' | null)[];
}

/** What a mount's JSON carries to the page. */
export interface DataTablePayload {
  /** A doc holding only the table, for the player to draw. */
  doc: Doc;
  /** Per row: round id, hardware key, model family, tier. */
  facets?: string[][];
  /** Per row: the value of the `group` column. */
  groups?: string[];
}

function annotationParams(block: Block): Record<string, string> | undefined {
  const heading = (
    block as { sourceHeading?: { templateAnnotation?: { params?: Record<string, string> } } }
  ).sourceHeading;
  return heading?.templateAnnotation?.params;
}

function dataTableBlocks(blocks: readonly Block[] | undefined, found: Block[] = []): Block[] {
  for (const block of blocks ?? []) {
    const src = annotationParams(block)?.src;
    if (block.template === 'dataTable' && src && isDataFilePath(src)) found.push(block);
    dataTableBlocks(block.children, found);
  }
  return found;
}

/**
 * The same rule `rewriteSiteLinks` applies to the link beside it: leading
 * `./` and `../` fall away and the rest names a file under the content
 * root's `assets/`. Anything else is not a file this export publishes.
 */
function assetFile(contentDir: string, src: string): string | null {
  const candidate = src.replace(/^(\.\.?\/)+/, '');
  if (!candidate.startsWith('assets/')) return null;
  const root = resolve(contentDir, 'assets');
  const file = resolve(contentDir, candidate);
  return file.startsWith(root + sep) ? file : null;
}

/** Keep the named columns, in the order named; report names the file lacks. */
export function selectColumns(
  data: TableData,
  columns: string | undefined,
): { data: TableData; missing: string[] } {
  if (!columns || !data.headers || !data.rows) return { data, missing: [] };
  const headers = data.headers;
  const wanted = columns
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const missing = wanted.filter((name) => !headers.includes(name));
  const picks = wanted
    .filter((name) => headers.includes(name))
    .map((name) => headers.indexOf(name));
  return {
    data: {
      ...data,
      headers: picks.map((i) => headers[i] ?? ''),
      rows: data.rows.map((row) => picks.map((i) => row[i] ?? '')),
      ...(data.align ? { align: picks.map((i) => data.align?.[i] ?? null) } : {}),
    },
    missing,
  };
}

/**
 * Each row's scorecard picker values — round, hardware, model family, tier —
 * computed with the same helpers that stamp the round cards, so a picker
 * narrows the table exactly as it narrows the cards. Null when the file lacks
 * a column they come from.
 */
export function scorecardRowFacets(data: TableData): string[][] | null {
  const headers = data.headers ?? [];
  const round = headers.indexOf('run_id');
  const platform = headers.indexOf('platform');
  const model = headers.indexOf('model_id');
  const tier = headers.indexOf('tier');
  if (!data.rows || [round, platform, model, tier].some((index) => index < 0)) return null;
  return data.rows.map((row) => [
    row[round] ?? '',
    // The hardware key reads only the platform.
    scorecardHardwareKey({ platform: row[platform] ?? '' } as ScorecardDevice),
    scorecardModelFamilyId(row[model] ?? ''),
    row[tier] ?? '',
  ]);
}

/** JSON inside a `<script>` element may not contain a literal `</script`. */
const scriptJson = (value: unknown): string => JSON.stringify(value).replace(/</g, '\\u003c');

/**
 * One mount per data table in the article. Each carries a doc holding only
 * its table: no start block (the player would make it a cover hero) and no
 * body prose (the article already renders both, in place).
 */
export async function dataTableMounts(
  doc: Doc,
  contentDir: string,
  warn: (message: string) => void = () => {},
): Promise<DataTableMount[]> {
  const mounts: DataTableMount[] = [];
  const { startBlock: _cover, ...frame } = doc;
  for (const block of dataTableBlocks(doc.blocks)) {
    const params = annotationParams(block) ?? {};
    const src = params.src ?? '';
    const file = assetFile(contentDir, src);
    const bytes = file ? await readFile(file).catch(() => null) : null;
    if (!bytes) {
      warn(`data table "${block.title ?? block.id}": no published file at ${src}`);
      continue;
    }
    const container = new MemoryContentContainer();
    await container.writeFile(src, bytes);
    const { doc: resolved, diagnostics } = await resolveDataReferences(
      { ...frame, blocks: [{ ...block, contents: [] }] } as Doc,
      container,
      { readers: defaultDataReaders() },
    );
    for (const issue of diagnostics) warn(`data table ${src}: ${issue.message}`);
    const table = resolved.blocks[0];
    const data = table?.templateData as TableData | undefined;
    if (!table || !data?.rows) continue;

    let facets: string[][] | undefined;
    if (params.follow === 'scorecard') {
      facets = scorecardRowFacets(data) ?? undefined;
      if (!facets) {
        warn(`data table ${src}: follow=scorecard needs run_id, platform, model_id, and tier`);
      }
    } else if (params.follow) {
      warn(`data table ${src}: nothing to follow called "${params.follow}"`);
    }
    const groupAt = params.group ? (data.headers ?? []).indexOf(params.group) : -1;
    const groups = groupAt >= 0 ? data.rows.map((row) => row[groupAt] ?? '') : undefined;
    if (params.group && !groups) warn(`data table ${src}: no column named ${params.group}`);
    const { data: shown, missing } = selectColumns(data, params.columns);
    if (missing.length > 0) warn(`data table ${src}: no column named ${missing.join(', ')}`);

    const payload: DataTablePayload = {
      doc: { ...resolved, blocks: [{ ...table, templateData: { ...data, ...shown } }] },
      ...(facets ? { facets } : {}),
      ...(groups ? { groups } : {}),
    };
    mounts.push({
      src,
      title: block.title ?? '',
      ...(facets ? { follow: 'scorecard' } : {}),
      html: `<div class="hb-data-table" ${DATA_TABLE_ATTR}><script type="application/json">${scriptJson(payload)}</script></div>`,
    });
  }
  return mounts;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const escapeHtml = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Place each mount right after the paragraph that links its file — the link
 * stays as the download — or after its heading when the link is missing.
 * A following table's section, heading through mount, is wrapped so the
 * page script can move it under the pickers in one piece.
 */
export function insertDataTables(body: string, mounts: readonly DataTableMount[]): string {
  let html = body;
  for (const mount of mounts) {
    const file = escapeRegExp(mount.src.split('/').pop() ?? mount.src);
    const link = new RegExp(`<p>(?:(?!</p>)[\\s\\S])*?href="[^"]*${file}"[\\s\\S]*?</p>`).exec(
      html,
    );
    const heading = new RegExp(`<h[23][^>]*>${escapeRegExp(escapeHtml(mount.title))}</h[23]>`).exec(
      html,
    );
    const anchor = link ?? heading;
    const at = anchor ? anchor.index + anchor[0].length : html.length;
    const end = at + 1 + mount.html.length;
    html = `${html.slice(0, at)}\n${mount.html}${html.slice(at)}`;
    if (mount.follow && heading && heading.index < at) {
      html = `${html.slice(0, heading.index)}<section class="hb-data-table-section" ${DATA_TABLE_FOLLOW_ATTR}="${mount.follow}">${html.slice(heading.index, end)}</section>${html.slice(end)}`;
    }
  }
  return html;
}

/**
 * The sorting and filtering rules, kept apart from the DOM so the tests can
 * run exactly what ships. Filters use squisq's table view grammar
 * (`@bendyline/squisq/table`): bare text matches anywhere; `=` `!=` `~` `!~`
 * `^~` `$~` match text, case-insensitively; `>` `<` `>=` `<=` compare
 * numbers; `=` or `!=` with nothing after them match empty or filled cells.
 * Sorting compares numbers as numbers and keeps empty cells last.
 */
export const DATA_TABLE_LOGIC_JS = `
  var OPERATOR = /^(>=|<=|!=|!~|\\^~|\\$~|>|<|=|~)\\s*([\\s\\S]*)$/;

  function numeric(text) {
    var value = String(text).trim();
    return /^-?(?:\\d+\\.?\\d*|\\.\\d+)$/.test(value) ? parseFloat(value) : null;
  }

  function parseFilter(text) {
    var raw = String(text || '').trim();
    if (!raw) return null;
    var match = OPERATOR.exec(raw);
    var value = (match ? match[2] : raw).trim();
    return { op: match ? match[1] : '~', value: value.toLowerCase(), num: numeric(value) };
  }

  function cellMatches(cell, filter) {
    var text = String(cell).trim().toLowerCase();
    var num = numeric(text);
    var value = filter.value;
    var both = num !== null && filter.num !== null;
    switch (filter.op) {
      case '>': return both && num > filter.num;
      case '<': return both && num < filter.num;
      case '>=': return both && num >= filter.num;
      case '<=': return both && num <= filter.num;
      case '=': return value === '' ? text === '' : both ? num === filter.num : text === value;
      case '!=': return value === '' ? text !== '' : !(both ? num === filter.num : text === value);
      case '!~': return text.indexOf(value) === -1;
      case '^~': return text.slice(0, value.length) === value;
      case '$~': return value === '' || text.slice(-value.length) === value;
      default: return text.indexOf(value) !== -1;
    }
  }

  function rowMatches(cells, filters) {
    for (var i = 0; i < filters.length; i++) {
      if (filters[i] && !cellMatches(cells[i] === undefined ? '' : cells[i], filters[i])) return false;
    }
    return true;
  }

  /* rows: [{ cells, index }]; dir: 1 ascending, -1 descending. */
  function sortRows(rows, col, dir) {
    return rows.slice().sort(function (a, b) {
      var x = String(a.cells[col] === undefined ? '' : a.cells[col]).trim();
      var y = String(b.cells[col] === undefined ? '' : b.cells[col]).trim();
      if (x === '' || y === '') {
        return x === y ? a.index - b.index : x === '' ? 1 : -1;
      }
      var nx = numeric(x);
      var ny = numeric(y);
      var order = nx !== null && ny !== null
        ? nx - ny
        : x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' });
      return dir * order || a.index - b.index;
    });
  }
`;

/**
 * `<out>/assets/data-table.js`, linked after the player bundle on pages that
 * carry a data table. Plain ES5-flavored JavaScript, served with no build
 * step. Without it the page still has its heading, prose, and download link.
 */
export const DATA_TABLE_JS = `(function () {
  'use strict';

  var ATTR = ${JSON.stringify(DATA_TABLE_ATTR)};
  var FOLLOW = ${JSON.stringify(DATA_TABLE_FOLLOW_ATTR)};
  var SCORECARD_ROOT = ${JSON.stringify(SCORECARD_DATA_ATTRS.root)};
  var SCORECARD_CONTROLS = ${JSON.stringify(SCORECARD_DATA_ATTRS.controls)};
  var VIEW_EVENT = ${JSON.stringify(SCORECARD_VIEW_EVENT)};
  var TABLE_EVENT = ${JSON.stringify(SCORECARD_TABLE_EVENT)};
  var HINT = 'Type to match text anywhere. Start with > < >= or <= to compare numbers, = or != for an exact value (alone: empty cells), !~ to leave a word out.';
${DATA_TABLE_LOGIC_JS}
  /* A following table's section moves under its scorecard's pickers. */
  function place(host) {
    var section = host.closest ? host.closest('[' + FOLLOW + ']') : null;
    var root = section ? document.querySelector('[' + SCORECARD_ROOT + ']') : null;
    var controls = root ? root.querySelector('[' + SCORECARD_CONTROLS + ']') : null;
    if (!controls) return null;
    controls.parentNode.insertBefore(section, controls.nextSibling);
    return root;
  }

  function whenTable(stage, done) {
    var found = stage.querySelector('table');
    if (found) return done(found);
    var finished = false;
    function finish(table) {
      if (finished) return;
      finished = true;
      observer.disconnect();
      done(table);
    }
    var observer = new MutationObserver(function () {
      var table = stage.querySelector('table');
      if (table) finish(table);
    });
    observer.observe(stage, { childList: true, subtree: true });
    setTimeout(function () {
      finish(stage.querySelector('table'));
    }, 10000);
  }

  function setup(host) {
    var json = host.querySelector('script[type="application/json"]');
    if (!json || host.getAttribute(ATTR + '-ready') || typeof SquisqPlayer === 'undefined') return;
    host.setAttribute(ATTR + '-ready', '1');
    var payload = JSON.parse(json.textContent);
    var root = place(host);
    var stage = document.createElement('div');
    stage.className = 'hb-data-table-stage';
    host.appendChild(stage);
    SquisqPlayer.mount(stage, payload.doc, {
      mode: 'static',
      autoPlay: false,
      showCodeCopyButton: false
    });
    whenTable(stage, function (table) {
      if (!table) {
        // Never drawn in time: let whatever the player shows stand.
        stage.className = '';
        return;
      }
      var owned = table.cloneNode(true);
      SquisqPlayer.unmount(stage);
      host.removeChild(stage);
      enhance(host, owned, payload, root);
    });
  }

  function enhance(host, table, payload, root) {
    var body = table.tBodies[0];
    var heads = table.tHead ? table.tHead.rows[0].cells : [];
    var facets = payload.facets || null;
    var groups = payload.groups || null;
    var rows = [];
    for (var r = 0; body && r < body.rows.length; r++) {
      var tr = body.rows[r];
      var cells = [];
      for (var c = 0; c < tr.cells.length; c++) cells.push(tr.cells[c].textContent);
      rows.push({
        el: tr,
        cells: cells,
        index: r,
        facets: facets ? facets[r] : null,
        group: groups ? groups[r] : null
      });
    }
    var headings = {};
    var state = { col: -1, dir: 1, filters: [], view: root ? root.hbScorecardView || null : null };

    var bar = document.createElement('div');
    bar.className = 'hb-data-table-bar';
    var status = document.createElement('p');
    status.className = 'hb-data-table-status';
    status.setAttribute('role', 'status');
    var clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'hb-data-table-clear';
    clear.textContent = 'Clear column filters';
    bar.appendChild(status);
    bar.appendChild(clear);
    var scroll = document.createElement('div');
    scroll.className = 'hb-data-table-scroll';
    scroll.appendChild(table);
    host.appendChild(bar);
    host.appendChild(scroll);

    var inputs = [];
    for (var h = 0; h < heads.length; h++) header(h, heads[h]);

    function header(col, th) {
      var name = th.textContent;
      th.textContent = '';
      var sort = document.createElement('button');
      sort.type = 'button';
      sort.className = 'hb-data-table-sort';
      sort.textContent = name;
      sort.title = 'Sort by ' + name;
      var input = document.createElement('input');
      input.type = 'search';
      input.className = 'hb-data-table-filter';
      input.placeholder = 'Filter';
      input.title = HINT;
      input.setAttribute('aria-label', 'Filter ' + name);
      input.setAttribute('autocomplete', 'off');
      input.spellcheck = false;
      th.appendChild(sort);
      th.appendChild(input);
      inputs.push(input);
      sort.addEventListener('click', function () {
        if (state.col !== col) {
          state.col = col;
          state.dir = 1;
        } else if (state.dir === 1) {
          state.dir = -1;
        } else {
          state.col = -1;
        }
        render();
      });
      input.addEventListener('input', function () {
        state.filters[col] = parseFilter(input.value);
        render();
      });
    }

    clear.addEventListener('click', function () {
      for (var i = 0; i < inputs.length; i++) inputs[i].value = '';
      state.filters = [];
      render();
    });
    if (root) {
      root.addEventListener(VIEW_EVENT, function (event) {
        state.view = event.detail;
        render();
      });
    }

    function inView(row) {
      var view = state.view;
      var f = row.facets;
      if (!view || !f) return true;
      return (
        view.rounds.indexOf(f[0]) !== -1 &&
        (!view.hardware || f[1] === view.hardware) &&
        (!view.model || f[2] === view.model) &&
        (!view.modelClass || f[3] === view.modelClass)
      );
    }

    /* One heading row per group, made the first time the group shows. */
    function heading(group) {
      if (!headings[group]) {
        var tr = document.createElement('tr');
        tr.className = 'hb-data-table-group';
        var th = document.createElement('th');
        th.scope = 'rowgroup';
        th.colSpan = heads.length || 1;
        var label = document.createElement('span');
        label.className = 'hb-data-table-group-label';
        th.appendChild(label);
        tr.appendChild(th);
        headings[group] = { el: tr, label: label };
      }
      return headings[group];
    }

    function render() {
      var order = state.col < 0 ? rows : sortRows(rows, state.col, state.dir);
      var grouped = !!groups && state.col < 0;
      var counts = {};
      var picked = 0;
      var shown = 0;
      for (var i = 0; i < order.length; i++) {
        var row = order[i];
        row.keep = inView(row);
        if (row.keep) picked++;
        row.keep = row.keep && rowMatches(row.cells, state.filters);
        if (row.keep) {
          shown++;
          counts[row.group] = (counts[row.group] || 0) + 1;
        }
      }
      for (var key in headings) {
        if (headings[key].el.parentNode) body.removeChild(headings[key].el);
      }
      var current = null;
      for (var j = 0; j < order.length; j++) {
        var next = order[j];
        if (grouped && next.keep && next.group !== current) {
          current = next.group;
          var head = heading(current);
          head.label.textContent = current + ' \\u00b7 ' + counts[current] +
            (counts[current] === 1 ? ' result' : ' results');
          body.appendChild(head.el);
        }
        next.el.hidden = !next.keep;
        body.appendChild(next.el);
      }
      for (var h = 0; h < heads.length; h++) {
        if (h === state.col) heads[h].setAttribute('aria-sort', state.dir === 1 ? 'ascending' : 'descending');
        else heads[h].removeAttribute('aria-sort');
      }
      var filtering = false;
      for (var f = 0; f < state.filters.length; f++) if (state.filters[f]) filtering = true;
      clear.hidden = !filtering;
      status.textContent = shown === 0
        ? 'No results match these filters.'
        : 'Showing ' + shown + ' of ' + picked + (picked === 1 ? ' result' : ' results') +
          (picked < rows.length ? ' in the rounds picked above (' + rows.length + ' in all).' : '.');

      // Tell the scorecard which rounds the visible rows belong to, so its
      // round list names exactly the rounds behind what is on screen.
      if (root) {
        var seen = {};
        var reached = [];
        for (var v = 0; v < rows.length; v++) {
          var round = rows[v].facets ? rows[v].facets[0] : rows[v].group;
          if (rows[v].keep && round && !seen[round]) {
            seen[round] = true;
            reached.push(round);
          }
        }
        root.dispatchEvent(new CustomEvent(TABLE_EVENT, {
          detail: { rounds: reached, filtering: filtering }
        }));
      }
    }

    render();
  }

  function start() {
    var hosts = document.querySelectorAll('[' + ATTR + ']');
    for (var i = 0; i < hosts.length; i++) setup(hosts[i]);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
`;
