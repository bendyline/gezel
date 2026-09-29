import type { CatalogItemSummary } from '@bendyline/gezel';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CatalogBrowser } from './CatalogBrowser.js';
import { COMMUNITY_CATALOG_NOTICE, reviewedBeforeCommunity } from './catalog-provenance.js';

function toolset(id: string, name: string, sourceId: string, maintainer = 'Bendyline') {
  return {
    sourceId,
    kind: 'toolset',
    manifest: {
      schemaVersion: 1,
      kind: 'toolset',
      id,
      name,
      description: `${name} description`,
      tags: [],
      maintainer: { name: maintainer },
      yankedVersions: [],
      version: '1.0.0',
      releasedAt: '2026-09-01T00:00:00Z',
      runtime: { kind: 'http-mcp', url: 'https://example.invalid/mcp' },
      tools: [],
      config: [],
      category: 'search',
    },
  } as unknown as CatalogItemSummary;
}

const renderBrowser = (items: CatalogItemSummary[]) =>
  render(
    <CatalogBrowser
      kind="toolset"
      initialItems={items}
      action={(item) => <button type="button">Install {item.manifest.name}</button>}
    />,
  );

describe('CatalogBrowser community tier', () => {
  it('labels an unreviewed community entry and names who shared it', () => {
    renderBrowser([
      toolset('docblocks', 'DocBlocks Documents', 'bundled'),
      toolset('someone-search', 'Someone Search', 'community', 'someone'),
    ]);
    const items = screen.getAllByRole('listitem');
    expect(within(items[1]!).getByText('Community')).toBeInTheDocument();
    expect(within(items[1]!).getByText('someone')).toBeInTheDocument();
    expect(within(items[0]!).queryByText('Community')).not.toBeInTheDocument();
    expect(screen.getByText(COMMUNITY_CATALOG_NOTICE)).toBeInTheDocument();
  });

  it('ranks reviewed entries ahead of community ones whatever order they arrive in', () => {
    renderBrowser([
      toolset('aa-community', 'Aardvark Tools', 'community'),
      toolset('github', 'GitHub', 'bundled'),
      toolset('builtin.web', 'Web', 'builtin'),
    ]);
    const names = screen
      .getAllByRole('listitem')
      .map((item) => within(item).getByRole('button').textContent);
    expect(names).toEqual(['Install GitHub', 'Install Web', 'Install Aardvark Tools']);
  });

  it('keeps community entries searchable', () => {
    renderBrowser([toolset('aa-community', 'Aardvark Tools', 'community')]);
    expect(screen.getByText('Aardvark Tools')).toBeInTheDocument();
  });

  it('says nothing about the community tier when none is on screen', () => {
    renderBrowser([toolset('github', 'GitHub', 'bundled')]);
    expect(screen.queryByText(COMMUNITY_CATALOG_NOTICE)).not.toBeInTheDocument();
  });
});

describe('reviewedBeforeCommunity', () => {
  it('is a stable partition', () => {
    const order = reviewedBeforeCommunity([
      { id: 'c1', sourceId: 'community' },
      { id: 'b1', sourceId: 'bundled' },
      { id: 'c2', sourceId: 'community' },
      { id: 'b2', sourceId: 'builtin' },
      { id: 'x' },
    ]).map((item) => item.id);
    expect(order).toEqual(['b1', 'b2', 'x', 'c1', 'c2']);
  });
});
