import type { CatalogItemSummary } from '@bendyline/gezel';
import { render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);

const { ProjectAddGezelDialog } = await import('./ProjectAddGezelDialog.js');
const { api } = await import('../api.js');

function roleTemplate(id: string, name: string, description: string): CatalogItemSummary {
  return {
    sourceId: 'gilde',
    kind: 'gezel-template',
    manifest: {
      schemaVersion: 1,
      kind: 'gezel-template',
      id,
      name,
      description,
      tags: [],
      maintainer: { name: 'Gezel' },
      version: '1.0.0',
      releasedAt: '2026-08-01',
      role: name,
      about: 'about.md',
      suggestedTools: [],
      meesterCandidate: false,
      availableVersions: [],
    },
  };
}

describe('ProjectAddGezelDialog project-type suggestions', () => {
  beforeEach(() => {
    vi.mocked(api.listCatalogItems).mockResolvedValue({
      items: [
        roleTemplate('builder', 'Builder', 'Builds and ships the product.'),
        roleTemplate(
          'veiligheidsmeester',
          'Veiligheidsmeester',
          'Reviews the project as its Chief Security Officer.',
        ),
        roleTemplate('copywriter', 'Copywriter', 'Writes clear product copy.'),
      ],
    });
  });

  it('promotes matching workshop gezels and uncreated roles ahead of the full lists', async () => {
    render(
      <ProjectAddGezelDialog
        open
        project={
          {
            id: 'web',
            name: 'Web product',
            projectTypeId: 'web-app',
            gezelIds: ['meester'],
          } as never
        }
        gezels={[
          {
            id: 'meester',
            name: 'Mara',
            role: 'Meester',
            updatedAt: '2026-08-01T00:00:00.000Z',
          },
          {
            id: 'security',
            name: 'Lin',
            role: 'Chief Security Officer',
            templateId: 'veiligheidsmeester',
            updatedAt: '2026-08-01T00:00:00.000Z',
          },
        ]}
        roleBasedNameOnlyMode={false}
        onClose={() => undefined}
        onAddExisting={vi.fn()}
        onCreateTemplate={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.listCatalogItems).toHaveBeenCalledWith('gezel-template'));

    const suggested = await screen.findByRole('region', {
      name: 'Suggested for this project type',
    });
    expect(
      within(suggested).getByText('Web App projects often benefit from these roles.'),
    ).toBeInTheDocument();
    expect(within(suggested).getByText('Builder')).toBeInTheDocument();
    expect(within(suggested).getByText('Lin')).toBeInTheDocument();
    expect(within(suggested).getByText('Core role')).toBeInTheDocument();
    expect(within(suggested).getByText('Suggested')).toBeInTheDocument();

    const workshop = screen.getByRole('region', { name: 'From your workshop' });
    expect(within(workshop).queryByText('Lin')).not.toBeInTheDocument();

    const otherRoles = screen.getByRole('region', { name: 'Add a new gezel for a role' });
    expect(within(otherRoles).getByText('Copywriter')).toBeInTheDocument();
    expect(within(otherRoles).queryByText('Builder')).not.toBeInTheDocument();
  });
});
