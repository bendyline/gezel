import { BundledSource, CatalogService } from '@bendyline/gezel-catalog';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { parseScriptMeta } from '../scripts/meta.js';
import { type NormalizeSpec, applyNormalize } from './normalize.js';

describe('github-issues shipped connector', () => {
  it('ships a parseable inline fetch script with anonymous fallback', async () => {
    const catalog = new CatalogService([new BundledSource({ noIndex: true })]);
    const detail = await catalog.get('connector-type', 'github-issues');
    expect(detail?.manifest.kind).toBe('connector-type');
    if (!detail || detail.manifest.kind !== 'connector-type') throw new Error('unreachable');

    const manifest = detail.manifest;
    expect(manifest.driver).toBe('script');
    expect(manifest.completeness).toBe('window');
    expect((manifest.secretShape as { required?: boolean }).required).toBe(false);
    const inline = (manifest.source as { inlineFetch?: unknown }).inlineFetch;
    expect(typeof inline).toBe('string');
    expect(String(inline)).toContain('gezel.http.request');
    expect(String(inline)).toContain('CREDENTIAL_MISSING');
    const expanded = String(inline).replaceAll(
      '$credential',
      'connector-github-issues.github-issues:deadbeef',
    );
    const meta = parseScriptMeta(expanded, '<connector>/github-issues-fetch.ts');
    expect(meta.requires).toEqual([
      'network',
      'credential:connector-github-issues.github-issues:deadbeef',
    ]);
    const compiled = ts.transpileModule(expanded, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    });
    const syntaxErrors = (compiled.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );
    expect(syntaxErrors).toEqual([]);
  });

  it('normalizes an issue body and searchable metadata into a canonical record', async () => {
    const catalog = new CatalogService([new BundledSource({ noIndex: true })]);
    const detail = await catalog.get('connector-type', 'github-issues');
    if (!detail || detail.manifest.kind !== 'connector-type') throw new Error('unreachable');
    const raw = {
      id: 123456,
      number: 42,
      title: 'Reconnect after sleep',
      body: 'The desktop should reconnect after the machine wakes.',
      state: 'open',
      state_reason: null,
      user: { login: 'octocat' },
      gezel_assignees: ['hubot'],
      gezel_labels: ['bug', 'desktop'],
      gezel_repository: 'octocat/Hello-World',
      milestone: { title: '1.0' },
      comments: 3,
      html_url: 'https://github.com/octocat/Hello-World/issues/42',
      created_at: '2026-07-10T09:00:00Z',
      updated_at: '2026-07-13T12:00:00Z',
      closed_at: null,
      locked: false,
    };

    const record = await applyNormalize(detail.manifest.normalize as NormalizeSpec, raw, {
      namespace: detail.manifest.id,
    });

    expect(record).toEqual({
      recordId: '123456',
      dirSegments: ['octocat-hello-world'],
      fileStem: 'reconnect-after-sleep',
      frontmatter: {
        direction: 'inbound',
        title: 'Reconnect after sleep',
        date: '2026-07-13T12:00:00Z',
        number: '42',
        state: 'open',
        author: 'octocat',
        assignees: '["hubot"]',
        labels: '["bug","desktop"]',
        milestone: '1.0',
        comments: '3',
        url: 'https://github.com/octocat/Hello-World/issues/42',
        createdAt: '2026-07-10T09:00:00Z',
        locked: 'false',
      },
      bodyMarkdown: 'The desktop should reconnect after the machine wakes.',
      scanOrigin: 'github-issues',
      quarantineNamespace: 'github-issues',
      quarantineLabel: 'Reconnect after sleep',
    });
  });
});
