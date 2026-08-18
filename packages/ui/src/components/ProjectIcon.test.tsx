import type { Project } from '@bendyline/gezel';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ProjectIcon } from './ProjectIcon.js';

describe('ProjectIcon', () => {
  it('renders the applied type mark by default', () => {
    render(
      <ProjectIcon
        project={
          {
            id: 'api',
            name: 'API',
            projectType: {
              id: 'custom-api',
              version: '1.0.0',
              source: 'bundled',
              icon: 'server',
              appliedAt: '2026-08-16T00:00:00.000Z',
            },
          } as Project
        }
      />,
    );

    expect(document.querySelector('[data-project-icon="server"]')).toBeInTheDocument();
    expect(document.querySelector('[data-project-glyph="server"]')).toBeInTheDocument();
  });

  it('lets an instance override its inherited mark', () => {
    render(
      <ProjectIcon
        project={
          {
            id: 'notes',
            name: 'Notes',
            icon: 'heart',
            projectTypeId: 'content-writing',
          } as Project
        }
      />,
    );

    expect(document.querySelector('[data-project-icon="heart"]')).toBeInTheDocument();
  });
});
