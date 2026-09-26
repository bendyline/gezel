import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { buildOfficeManifest, escapeXml, officeVersionString } from './manifest.js';

const ORIGIN = 'https://localhost:31234';
const ID = '6f1c2f7e-2a7b-4c1e-9f5e-0a1b2c3d4e5f';

function parse(xml: string) {
  const errors: string[] = [];
  const doc = new DOMParser({
    onError: (level: string, msg: string) => {
      if (level !== 'warning') errors.push(msg);
    },
  }).parseFromString(xml, 'text/xml');
  return { doc, errors };
}

describe('buildOfficeManifest', () => {
  it.each([
    ['word', 'Document', 'WordApi'],
    ['excel', 'Workbook', 'ExcelApi'],
    ['powerpoint', 'Presentation', 'PowerPointApi'],
  ] as const)('%s manifest names its host, pane URL and requirement set', (app, host, set) => {
    const xml = buildOfficeManifest({ app, origin: ORIGIN, id: ID, version: '1.26244.61' });
    const { doc, errors } = parse(xml);
    expect(errors).toEqual([]);
    const root = doc.documentElement!;
    expect(root.getAttribute('xsi:type')).toBe('TaskPaneApp');
    expect(xml).toContain(`<Id>${ID}</Id>`);
    expect(xml).toContain('<Version>1.26244.61.0</Version>');
    expect(xml).toContain(`<Host Name="${host}"/>`);
    expect(xml).toContain(`<Host xsi:type="${host}">`);
    expect(xml).toContain(`<Set Name="${set}" MinVersion="1.1"/>`);
    expect(xml).toContain(`<SourceLocation DefaultValue="${ORIGIN}/office/${app}/taskpane.html"/>`);
    expect(xml).toContain(`DefaultValue="${ORIGIN}/office/commands.html"`);
    expect(xml).toContain('<Permissions>ReadWriteDocument</Permissions>');
    expect(xml).not.toContain('AppDomains');
  });

  it('keeps top-level elements in schema order', () => {
    const { doc } = parse(
      buildOfficeManifest({ app: 'word', origin: ORIGIN, id: ID, version: '1.0.0' }),
    );
    const names: string[] = [];
    for (let n = doc.documentElement!.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1) names.push((n as unknown as { localName: string }).localName);
    }
    expect(names).toEqual([
      'Id',
      'Version',
      'ProviderName',
      'DefaultLocale',
      'DisplayName',
      'Description',
      'IconUrl',
      'HighResolutionIconUrl',
      'SupportUrl',
      'Hosts',
      'Requirements',
      'DefaultSettings',
      'Permissions',
      'VersionOverrides',
    ]);
  });

  it('escapes the display name', () => {
    const xml = buildOfficeManifest({
      app: 'excel',
      origin: `${ORIGIN}/`,
      id: ID,
      version: '1.0.0',
      displayName: 'Gezel & "Friends"',
    });
    expect(parse(xml).errors).toEqual([]);
    expect(xml).toContain('Gezel &amp; &quot;Friends&quot;');
    expect(xml).toContain(`${ORIGIN}/office/excel/taskpane.html`);
  });
});

describe('officeVersionString', () => {
  it.each([
    ['1.26244.61', '1.26244.61.0'],
    ['2.0.0-beta.3', '2.0.0.0'],
    ['1', '1.0.0.0'],
    ['1.2.3.4.5', '1.2.3.4'],
  ])('%s → %s', (input, expected) => expect(officeVersionString(input)).toBe(expected));
});

describe('escapeXml', () => {
  it('escapes all five', () => expect(escapeXml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&apos;'));
});
