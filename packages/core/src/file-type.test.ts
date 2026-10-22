import { describe, expect, it } from 'vitest';
import { isTestFile, ruleFileType } from './file-type.js';

const t = (
  path: string,
  kind: string,
  modality: string,
  lang: string | null = null,
  extra: { photo?: boolean; screenshot?: boolean; use?: string } = {},
) => {
  const type = ruleFileType({ path, kind, modality, lang, ...extra }, extra.use);
  return `${type.id} ${type.label}/${type.plural} ${type.family}`;
};

describe('ruleFileType', () => {
  it('tells photos from screenshots, drawings and other images', () => {
    expect(t('a.jpg', 'image', 'image', null, { photo: true })).toBe('photo Photo/Photos photos');
    expect(t('a.HEIC', 'image', 'image')).toBe('photo Photo/Photos photos');
    expect(t('a.png', 'image', 'image', null, { screenshot: true })).toBe(
      'screenshot Screenshot/Screenshots photos',
    );
    expect(t('logo.svg', 'image', 'image')).toBe('drawing Drawing/Drawings photos');
    expect(t('banner.png', 'image', 'image')).toBe('image Image/Images photos');
  });

  it('names documents by what a person opens them as', () => {
    expect(t('a.pdf', 'doc', 'doc')).toBe('pdf PDF/PDFs documents');
    expect(t('a.pptx', 'doc', 'doc')).toBe('slides Slides/Slides documents');
    expect(t('a.xlsx', 'doc', 'doc')).toBe('spreadsheet Spreadsheet/Spreadsheets data');
    expect(t('a.docx', 'doc', 'doc')).toBe('document Document/Documents documents');
    expect(t('a.md', 'markdown', 'text', 'markdown')).toBe('note Note/Notes documents');
    expect(t('a.csv', 'data', 'text', 'csv')).toBe('table Table/Tables data');
    expect(t('a.m4a', 'audio', 'audio')).toBe('recording Recording/Recordings media');
  });

  it('names code by language, and keeps tests, styles and settings apart', () => {
    expect(t('src/a.ts', 'code', 'code', 'typescript')).toBe(
      'code:typescript TypeScript/TypeScript code',
    );
    expect(t('src/a.tsx', 'code', 'code', 'tsx')).toBe(
      'code:typescript TypeScript/TypeScript code',
    );
    expect(t('run.sh', 'code', 'code', 'bash')).toBe('code:bash Shell script/Shell scripts code');
    expect(t('src/a.test.ts', 'code', 'code', 'typescript')).toBe('test Test/Tests code');
    expect(t('a.css', 'code', 'code', 'css')).toBe('style Stylesheet/Stylesheets code');
    expect(t('vite.config.ts', 'code', 'code', 'typescript', { use: 'config' })).toBe(
      'config Settings/Settings code',
    );
    expect(t('package.json', 'config', 'text', 'json', { use: 'config' })).toBe(
      'config Settings/Settings code',
    );
    expect(t('data/cities.json', 'config', 'text', 'json', { use: 'data' })).toBe(
      'data Data/Data data',
    );
  });
});

describe('isTestFile', () => {
  it('takes test names and test folders', () => {
    expect(isTestFile('src/a.test.ts')).toBe(true);
    expect(isTestFile('src/__tests__/a.ts')).toBe(true);
    expect(isTestFile('tests/fixtures/a.json')).toBe(true);
    expect(isTestFile('src/contest.ts')).toBe(false);
  });
});
