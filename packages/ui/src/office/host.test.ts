import { describe, expect, it } from 'vitest';
import { documentPathFromUrl, documentTitle } from './host.js';

describe('documentPathFromUrl', () => {
  it.each([
    ['C:\\Users\\me\\Documents\\plan.docx', 'C:\\Users\\me\\Documents\\plan.docx'],
    ['/Users/me/Documents/plan.docx', '/Users/me/Documents/plan.docx'],
    ['file:///Users/me/My%20Docs/plan.docx', '/Users/me/My Docs/plan.docx'],
    ['file:///C:/Users/me/plan.docx', 'C:\\Users\\me\\plan.docx'],
    ['file://server/share/team/plan.docx', '\\\\server\\share\\team\\plan.docx'],
    ['\\\\server\\share\\plan.docx', '\\\\server\\share\\plan.docx'],
    ['https://contoso.sharepoint.com/sites/x/plan.docx', null],
    ['', null],
    [null, null],
  ] as const)('%s → %s', (url, expected) => expect(documentPathFromUrl(url)).toBe(expected));
});

describe('documentTitle', () => {
  it('uses the file name', () => {
    expect(documentTitle('C:\\a\\b\\Plan.docx')).toBe('Plan.docx');
    expect(documentTitle('/a/b.xlsx')).toBe('b.xlsx');
    expect(documentTitle(null)).toBe('Untitled document');
  });
});
