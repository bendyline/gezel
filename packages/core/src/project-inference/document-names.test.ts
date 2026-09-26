import { describe, expect, it } from 'vitest';
import {
  isContainerFolderName,
  isDocumentFileName,
  isStrongProjectMarker,
  projectMarkerWeight,
} from './document-names.js';

describe('isDocumentFileName', () => {
  it.each([
    'report.docx',
    'Budget.XLSX',
    'deck.pptx',
    'notes.md',
    'scan.pdf',
    'plan.odt',
    'data.csv',
  ])('accepts %s', (name) => expect(isDocumentFileName(name)).toBe(true));
  it.each([
    '~$report.docx',
    '.~lock.plan.odt#',
    '.DS_Store',
    'photo.jpg',
    'README',
    '.hidden.md',
    'x.',
  ])('rejects %s', (name) => expect(isDocumentFileName(name)).toBe(false));
});

describe('projectMarkerWeight', () => {
  it('weights strong and weak markers', () => {
    expect(projectMarkerWeight('.git')).toBe(3);
    expect(projectMarkerWeight('.gezel')).toBe(3);
    expect(isStrongProjectMarker('.svn')).toBe(true);
    expect(projectMarkerWeight('README.md')).toBe(1);
    expect(projectMarkerWeight('readme')).toBe(1);
    expect(projectMarkerWeight('package.json')).toBe(1);
    expect(projectMarkerWeight('App.sln')).toBe(1);
    expect(projectMarkerWeight('team.code-workspace')).toBe(1);
    expect(projectMarkerWeight('report.docx')).toBe(0);
  });
});

describe('isContainerFolderName', () => {
  it.each(['Projects', 'work', 'Clients', 'Archive', '2024', '2024-03'])('flags %s', (name) =>
    expect(isContainerFolderName(name)).toBe(true),
  );
  it.each(['engineeringdocs', 'alpha', 'Q3 plan', '20245'])('does not flag %s', (name) =>
    expect(isContainerFolderName(name)).toBe(false),
  );
});
