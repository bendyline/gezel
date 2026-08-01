import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));
vi.mock('../primitives/index.js', () => primitivesMock);

const { TabErrorBoundary } = await import('./TabErrorBoundary.js');

function Boom(): never {
  const err = new Error("Cannot read properties of null (reading 'id')");
  err.stack = [
    "TypeError: Cannot read properties of null (reading 'id')",
    '    at ProjectOverview (/Users/mike/gh/gezel/packages/ui/src/views/ProjectOverviewView.tsx:118:22)',
    '    at renderWithHooks (/Users/mike/gh/gezel/node_modules/react-dom/cjs/react-dom.js:1:1)',
  ].join('\n');
  throw err;
}

let consoleError: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // React logs every boundary catch; silence it so the run stays readable.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('open', vi.fn());
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

afterEach(() => {
  consoleError.mockRestore();
});

describe('TabErrorBoundary', () => {
  it('contains the crash and offers a retry plus a report link', () => {
    render(
      <TabErrorBoundary resetKey="tab-1">
        <Boom />
      </TabErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('This tab hit an error.');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /report error on github/i })).toBeInTheDocument();
  });

  it('reports the stack without leaking the paths in it', async () => {
    // Dev stacks are the worst offender for home paths — every frame of
    // this one names the developer's directory.
    const user = userEvent.setup();
    render(
      <TabErrorBoundary resetKey="tab-1">
        <Boom />
      </TabErrorBoundary>,
    );

    await user.click(screen.getByRole('button', { name: /report error on github/i }));
    const area = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    await waitFor(() => expect(area.value).toContain('### Stack'));

    expect(area.value).toContain('ProjectOverviewView.tsx');
    expect(area.value).not.toContain('/Users/');
    expect(area.value).not.toContain('mike');
  });

  it('clears the crash on retry', async () => {
    const user = userEvent.setup();
    function Flaky({ explode }: { explode: boolean }) {
      if (explode) return <Boom />;
      return <p>recovered</p>;
    }
    const { rerender } = render(
      <TabErrorBoundary resetKey="tab-1">
        <Flaky explode />
      </TabErrorBoundary>,
    );
    rerender(
      <TabErrorBoundary resetKey="tab-1">
        <Flaky explode={false} />
      </TabErrorBoundary>,
    );

    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(screen.getByText('recovered')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
