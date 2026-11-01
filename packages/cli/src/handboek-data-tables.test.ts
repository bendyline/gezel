import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCORECARD_DATA_ATTRS } from '@bendyline/gezel';
import { markdownToDoc } from '@bendyline/squisq/doc';
import { parseMarkdown } from '@bendyline/squisq/markdown';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DATA_TABLE_ATTR,
  DATA_TABLE_FOLLOW_ATTR,
  DATA_TABLE_JS,
  DATA_TABLE_LOGIC_JS,
  type DataTablePayload,
  dataTableMounts,
  insertDataTables,
  scorecardRowFacets,
  selectColumns,
} from './handboek-data-tables.js';
import { pageScripts } from './handboek-export.js';
import { SCORECARD_FILTER_JS, SCORECARD_VIEW_EVENT } from './handboek-site-scorecard.js';

const CSV = [
  'started_at,model,pass_rate_pct,notes,run_id,platform,model_id,tier',
  '2026-10-30,Gemma,50.0,"a, b",r2,win32,gemma4-12b-q4,medium',
  '2026-10-28,Qwen,76.9,</x>,r1,darwin,qwen3.8-27b-q4,medium',
  '',
].join('\n');

const article = (params: string) =>
  `# Scores\n\n### Every result {[dataTable src=../assets/data/all.csv ${params}]}\n\nOne row per result. [Download every result as CSV](../assets/data/all.csv).\n\n## After\n\nMore prose.\n`;

/** The shipped sorting and filtering rules, run as the page runs them. */
const logic = new Function(
  `${DATA_TABLE_LOGIC_JS}; return { parseFilter, cellMatches, rowMatches, sortRows };`,
)() as {
  parseFilter: (text: string) => { op: string; value: string; num: number | null } | null;
  cellMatches: (cell: string, filter: object) => boolean;
  rowMatches: (cells: string[], filters: (object | null)[]) => boolean;
  sortRows: (
    rows: { cells: string[]; index: number }[],
    col: number,
    dir: number,
  ) => { index: number }[];
};

describe('selectColumns', () => {
  it('keeps the named columns in the order named and reports the rest', () => {
    const { data, missing } = selectColumns(
      { headers: ['a', 'b', 'c'], rows: [['1', '2', '3']], align: ['left', null, 'right'] },
      'c, a, nope',
    );
    expect(data).toEqual({ headers: ['c', 'a'], rows: [['3', '1']], align: ['right', 'left'] });
    expect(missing).toEqual(['nope']);
  });

  it('leaves the table alone without a column list', () => {
    const data = { headers: ['a'], rows: [['1']] };
    expect(selectColumns(data, undefined)).toEqual({ data, missing: [] });
  });
});

describe('scorecardRowFacets', () => {
  it('stamps each row the way the scorecard stamps its rounds', () => {
    expect(
      scorecardRowFacets({
        headers: ['run_id', 'platform', 'model_id', 'tier'],
        rows: [['r1', 'darwin', 'qwen3.8-27b-q4', 'medium']],
      }),
    ).toEqual([['r1', 'mac', 'qwen3.8-27b', 'medium']]);
  });

  it('needs every column it reads', () => {
    expect(scorecardRowFacets({ headers: ['run_id'], rows: [['r1']] })).toBeNull();
  });
});

describe('insertDataTables', () => {
  const mount = { src: '../assets/data/all.csv', title: 'Every result', html: '<div mount></div>' };

  it('mounts right after the paragraph that links the file', () => {
    const body =
      '<h3>Every result</h3>\n<p>Prose. <a href="../assets/data/all.csv">Download</a>.</p>\n<h2>After</h2>';
    expect(insertDataTables(body, [mount])).toBe(
      '<h3>Every result</h3>\n<p>Prose. <a href="../assets/data/all.csv">Download</a>.</p>\n<div mount></div>\n<h2>After</h2>',
    );
  });

  it('falls back to the heading when the link is gone', () => {
    expect(insertDataTables('<h3>Every result</h3>\n<p>Prose.</p>', [mount])).toBe(
      '<h3>Every result</h3>\n<div mount></div>\n<p>Prose.</p>',
    );
  });

  it('wraps a following table’s section, heading through mount, to move as one', () => {
    const body =
      '<p>Before.</p>\n<h3>Every result</h3>\n<p><a href="all.csv">Download</a></p>\n<h2>After</h2>';
    expect(insertDataTables(body, [{ ...mount, follow: 'scorecard' }])).toBe(
      `<p>Before.</p>\n<section class="hb-data-table-section" ${DATA_TABLE_FOLLOW_ATTR}="scorecard"><h3>Every result</h3>\n<p><a href="all.csv">Download</a></p>\n<div mount></div></section>\n<h2>After</h2>`,
    );
  });
});

describe('dataTableMounts', () => {
  let contentDir: string;
  beforeAll(async () => {
    contentDir = await mkdtemp(join(tmpdir(), 'gezel-data-table-'));
    await mkdir(join(contentDir, 'assets', 'data'), { recursive: true });
    await writeFile(join(contentDir, 'assets', 'data', 'all.csv'), CSV);
  });
  afterAll(async () => {
    await rm(contentDir, { recursive: true, force: true });
  });

  const mountsFor = async (params: string) => {
    const warnings: string[] = [];
    const doc = markdownToDoc(parseMarkdown(article(params)), { articleId: 'scores' });
    const mounts = await dataTableMounts(doc, contentDir, (note) => warnings.push(note));
    return { mounts, warnings };
  };
  const payloadOf = (html: string): DataTablePayload =>
    JSON.parse(
      html.slice(html.indexOf('>', html.indexOf('<script')) + 1, html.indexOf('</script>')),
    );

  it('resolves the file into a doc that holds only the table', async () => {
    const { mounts, warnings } = await mountsFor('columns=model,pass_rate_pct,notes');
    expect(warnings).toEqual([]);
    expect(mounts).toHaveLength(1);
    const [mount] = mounts;
    expect(mount?.html).toContain(DATA_TABLE_ATTR);
    expect(mount?.follow).toBeUndefined();
    // A literal `</x>` from the data must not be able to close the script.
    expect(mount?.html).not.toContain('</x>');
    const { doc, facets } = payloadOf(mount?.html ?? '');
    expect(facets).toBeUndefined();
    expect(doc.startBlock).toBeUndefined();
    expect(doc.blocks).toHaveLength(1);
    const [table] = doc.blocks as unknown as {
      contents: unknown[];
      templateData: { headers: string[]; rows: string[][] };
    }[];
    expect(table?.contents).toEqual([]);
    expect(table?.templateData.headers).toEqual(['model', 'pass_rate_pct', 'notes']);
    expect(table?.templateData.rows).toEqual([
      ['Gemma', '50.0', 'a, b'],
      ['Qwen', '76.9', '</x>'],
    ]);
  });

  it('carries scorecard facets from columns the page does not show', async () => {
    const { mounts, warnings } = await mountsFor('follow=scorecard columns=model,pass_rate_pct');
    expect(warnings).toEqual([]);
    expect(mounts[0]?.follow).toBe('scorecard');
    expect(payloadOf(mounts[0]?.html ?? '').facets).toEqual([
      ['r2', 'windows', 'gemma4-12b', 'medium'],
      ['r1', 'mac', 'qwen3.8-27b', 'medium'],
    ]);
  });

  it('carries each row’s group, from a column the page need not show', async () => {
    const { mounts, warnings } = await mountsFor('group=run_id columns=model');
    expect(warnings).toEqual([]);
    expect(payloadOf(mounts[0]?.html ?? '').groups).toEqual(['r2', 'r1']);
  });

  it('says so when the file, a column, or a follow target is missing', async () => {
    expect((await mountsFor('columns=model,score')).warnings).toEqual([
      'data table ../assets/data/all.csv: no column named score',
    ]);
    expect((await mountsFor('group=round')).warnings).toEqual([
      'data table ../assets/data/all.csv: no column named round',
    ]);
    expect((await mountsFor('follow=leaderboard')).warnings).toEqual([
      'data table ../assets/data/all.csv: nothing to follow called "leaderboard"',
    ]);
    const doc = markdownToDoc(
      parseMarkdown(
        '## Gone {[dataTable src=../assets/data/gone.csv]}\n\n[csv](../assets/data/gone.csv)\n',
      ),
      { articleId: 'gone' },
    );
    const notes: string[] = [];
    expect(await dataTableMounts(doc, contentDir, (note) => notes.push(note))).toEqual([]);
    expect(notes).toEqual(['data table "Gone": no published file at ../assets/data/gone.csv']);
  });
});

describe('column filters', () => {
  const matches = (cell: string, filter: string) => {
    const parsed = logic.parseFilter(filter);
    return parsed ? logic.cellMatches(cell, parsed) : true;
  };

  it('matches bare text anywhere, ignoring case', () => {
    expect(matches('Gemma 4 (12B, Q4)', 'gemma')).toBe(true);
    expect(matches('Qwen 3.8', 'gemma')).toBe(false);
    expect(logic.parseFilter('   ')).toBeNull();
  });

  it('compares numbers as numbers', () => {
    expect(matches('76.9', '>50')).toBe(true);
    expect(matches('9.5', '>50')).toBe(false);
    expect(matches('50.0', '>= 50')).toBe(true);
    expect(matches('50.0', '=50')).toBe(true);
    expect(matches('', '<10')).toBe(false);
  });

  it('speaks the rest of squisq’s filter grammar', () => {
    expect(matches('engine-log median', '^~engine')).toBe(true);
    expect(matches('engine-log median', '$~median')).toBe(true);
    expect(matches('probe mean', '!~engine')).toBe(true);
    expect(matches('suite', '!=subset')).toBe(true);
    expect(matches('', '=')).toBe(true);
    expect(matches('7.40', '=')).toBe(false);
    expect(matches('7.40', '!=')).toBe(true);
  });

  it('keeps a row only when every column filter agrees', () => {
    const filters = [logic.parseFilter('qwen'), null, logic.parseFilter('>70')];
    expect(logic.rowMatches(['Qwen', 'core', '76.9'], filters)).toBe(true);
    expect(logic.rowMatches(['Qwen', 'core', '40.0'], filters)).toBe(false);
  });
});

describe('column sorting', () => {
  const rows = ['9.5', '', '76.9', '50.0', '100.0'].map((value, index) => ({
    cells: [value],
    index,
  }));
  const order = (dir: number) => logic.sortRows(rows, 0, dir).map((row) => row.index);

  it('sorts numbers by value with empty cells last, either way', () => {
    expect(order(1)).toEqual([0, 3, 2, 4, 1]);
    expect(order(-1)).toEqual([4, 2, 3, 0, 1]);
  });

  it('sorts text naturally and keeps ties in their original order', () => {
    const text = ['core', 'Core', 'developer', 'complex-work'].map((value, index) => ({
      cells: [value],
      index,
    }));
    expect(logic.sortRows(text, 0, 1).map((row) => row.index)).toEqual([3, 0, 1, 2]);
  });
});

describe('page scripts', () => {
  it('load the player before the mount script', () => {
    expect(pageScripts(`<div class="hb-data-table" ${DATA_TABLE_ATTR}></div>`)).toEqual([
      'squisq-player.js',
      'data-table.js',
    ]);
  });

  it('are valid JavaScript with nothing left to interpolate', () => {
    for (const script of [DATA_TABLE_JS, SCORECARD_FILTER_JS]) {
      expect(script).not.toContain('${');
      expect(() => new Function(script)).not.toThrow();
    }
  });

  it('agree on the scorecard view they share', () => {
    expect(SCORECARD_FILTER_JS).toContain(`"${SCORECARD_VIEW_EVENT}"`);
    expect(DATA_TABLE_JS).toContain(`"${SCORECARD_VIEW_EVENT}"`);
    expect(DATA_TABLE_JS).toContain(`"${SCORECARD_DATA_ATTRS.root}"`);
    expect(DATA_TABLE_JS).toContain(`"${SCORECARD_DATA_ATTRS.controls}"`);
  });
});
