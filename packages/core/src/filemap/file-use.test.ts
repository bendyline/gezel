import { describe, expect, it } from 'vitest';
import { fileUseOf } from './file-use.js';

describe('fileUseOf', () => {
  it('calls project machinery config, whatever its format', () => {
    for (const p of [
      'package.json',
      'packages/core/package.json',
      'tsconfig.json',
      'tsconfig.build.json',
      'packages/ui/vite.config.ts',
      'vitest.config.mts',
      'tsup.config.ts',
      'biome.json',
      '.eslintrc.cjs',
      '.prettierrc',
      '.npmrc',
      'pnpm-workspace.yaml',
      '.github/workflows/quality.yml',
      '.vscode/settings.json',
      'Dockerfile',
      'docker-compose.dev.yml',
      'pyproject.toml',
      'Cargo.toml',
      'playwright.config.ts',
    ]) {
      expect(fileUseOf(p), p).toBe('config');
    }
  });

  it('calls content in data formats data', () => {
    for (const p of [
      'data/models.json',
      'fixtures/sample.geojson',
      'gilde/data/chat-models/qwen.yaml',
      'evals/results.csv',
      'src/i18n/en.json',
      'docs/table.tsv',
    ]) {
      expect(fileUseOf(p), p).toBe('data');
    }
    expect(fileUseOf('weird/file', 'json')).toBe('data');
  });

  it('calls stylesheets style', () => {
    for (const p of ['src/styles.css', 'ui/theme.scss', 'a/b.less', 'x.styl']) {
      expect(fileUseOf(p), p).toBe('style');
    }
    expect(fileUseOf('x/y', 'css')).toBe('style');
  });

  it('leaves ordinary source as code, including scripts under .github', () => {
    for (const p of [
      'src/index.ts',
      'packages/service/src/chat/manager.ts',
      'scripts/build.mjs',
      'app/models/user.py',
      '.github/scripts/release.mjs',
      'README.md',
    ]) {
      expect(fileUseOf(p), p).toBe('code');
    }
  });
});
