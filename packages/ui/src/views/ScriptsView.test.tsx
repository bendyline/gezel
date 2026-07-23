import type { Project, ScriptInputField, ScriptMeta } from '@bendyline/gezel';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

const { ScriptsView } = await import('./ScriptsView.js');
const { api } = await import('../api.js');

const PROJECTS: Project[] = [
  { id: 'pj-alpha', name: 'Alpha' } as Project,
  { id: 'pj-beta', name: 'Beta' } as Project,
];

function makeMeta(name: string, inputs?: Record<string, ScriptInputField>): ScriptMeta {
  return {
    name,
    description: `Description of ${name}`,
    inputs,
  } as ScriptMeta;
}

describe('ScriptsView', () => {
  beforeEach(() => {
    vi.mocked(api.listProjects).mockResolvedValue({ projects: PROJECTS } as never);
    vi.mocked(api.listProjectScripts).mockResolvedValue({
      scripts: [
        { name: 'hello', meta: makeMeta('Hello World') },
        {
          name: 'echo',
          meta: makeMeta('Echo', {
            text: {
              type: 'string',
              description: 'what to echo',
              required: true,
            } as ScriptInputField,
          }),
        },
      ],
    } as never);
    vi.mocked(api.runProjectScript).mockResolvedValue({
      runId: 'run-deadbeef-1234',
      status: 'ok',
      output: { result: 'echo: hello' },
      callsSummary: [],
    } as never);
  });

  it('renders the empty-state when the project has no scripts', async () => {
    vi.mocked(api.listProjectScripts).mockResolvedValue({ scripts: [] } as never);
    render(<ScriptsView />);
    await waitFor(() => {
      expect(screen.getByText(/No scripts yet/)).toBeInTheDocument();
    });
  });

  it('lists each script in the picker and selects one from the dropdown', async () => {
    render(<ScriptsView />);
    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Hello World' })).toBeInTheDocument();
    });
    expect(screen.getByRole('option', { name: 'Echo' })).toBeInTheDocument();

    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Script' }), 'hello');

    // The detail pane should now show the script's name in an <h2>.
    await waitFor(() => {
      const h2s = screen.getAllByRole('heading', { level: 2 });
      expect(h2s.some((h) => h.textContent === 'Hello World')).toBe(true);
    });
  });

  it('selecting a script with inputs renders the input form', async () => {
    render(<ScriptsView />);
    await waitFor(() => {
      expect(screen.getByText('Echo')).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Script' }), 'echo');

    await waitFor(() => {
      expect(screen.getByText(/Inputs/)).toBeInTheDocument();
    });
    expect(screen.getByText(/what to echo/)).toBeInTheDocument();
  });

  it('Run dispatches runProjectScript with the project id and gathered input', async () => {
    render(<ScriptsView />);
    await waitFor(() => {
      expect(screen.getByText('Echo')).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Script' }), 'echo');
    await waitFor(() => {
      expect(screen.getByRole('textbox')).toBeInTheDocument();
    });
    await user.type(screen.getByRole('textbox'), 'hi');

    await user.click(screen.getByRole('button', { name: /^Run$/ }));

    await waitFor(() => {
      expect(api.runProjectScript).toHaveBeenCalledWith('pj-alpha', {
        name: 'echo',
        input: { text: 'hi' },
      });
    });
  });

  it('after a successful run, surfaces the run id and status', async () => {
    render(<ScriptsView />);
    await waitFor(() => {
      expect(screen.getByText('Hello World')).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Script' }), 'hello');
    await user.click(screen.getByRole('button', { name: /^Run$/ }));

    await waitFor(() => {
      expect(screen.getByText(/Run run-dead/)).toBeInTheDocument();
    });
    // Status badge should read "ok".
    expect(screen.getByText(/— ok/)).toBeInTheDocument();
  });

  it('switching the project filter clears the selection and refetches scripts', async () => {
    render(<ScriptsView />);
    await waitFor(() => {
      expect(api.listProjectScripts).toHaveBeenCalledWith('pj-alpha');
    });
    vi.mocked(api.listProjectScripts).mockClear();
    vi.mocked(api.listProjectScripts).mockResolvedValue({
      scripts: [{ name: 'beta-script', meta: makeMeta('Beta only') }],
    } as never);

    fireEvent.change(screen.getByRole('combobox', { name: 'Project' }), {
      target: { value: 'pj-beta' },
    });

    await waitFor(() => {
      expect(api.listProjectScripts).toHaveBeenCalledWith('pj-beta');
    });
    await waitFor(() => {
      expect(screen.getByText('Beta only')).toBeInTheDocument();
    });
  });

  it('runProjectScript error surfaces in the inline error chip', async () => {
    vi.mocked(api.runProjectScript).mockRejectedValue(new Error('script timed out'));
    render(<ScriptsView />);
    await waitFor(() => {
      expect(screen.getByText('Hello World')).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Script' }), 'hello');
    await user.click(screen.getByRole('button', { name: /^Run$/ }));

    await waitFor(() => {
      expect(screen.getByText(/script timed out/)).toBeInTheDocument();
    });
  });

  it('hides the project picker when projectId prop is provided', async () => {
    render(<ScriptsView projectId="pj-beta" />);
    await waitFor(() => {
      expect(api.listProjectScripts).toHaveBeenCalledWith('pj-beta');
    });
    expect(screen.queryByText(/^Project$/)).not.toBeInTheDocument();
  });

  it('Edit code opens the script editor tab for the selected script', async () => {
    render(<ScriptsView projectId="pj-beta" />);
    await waitFor(() => {
      expect(screen.getByText('Hello World')).toBeInTheDocument();
    });

    const user = userEvent.setup();
    await user.selectOptions(screen.getByRole('combobox', { name: 'Script' }), 'hello');

    const openTab = vi.fn();
    window.addEventListener('gezel:open-tab', openTab);
    await user.click(screen.getByRole('button', { name: 'Edit code' }));
    window.removeEventListener('gezel:open-tab', openTab);

    expect(openTab).toHaveBeenCalledTimes(1);
    const detail = (openTab.mock.calls[0]?.[0] as CustomEvent).detail;
    expect(detail).toMatchObject({ kind: 'script', projectId: 'pj-beta', name: 'hello' });
  });

  it('New script opens the creation dialog', async () => {
    render(<ScriptsView projectId="pj-beta" />);
    await waitFor(() => {
      expect(screen.getByText('Hello World')).toBeInTheDocument();
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'New script' }));
    expect(await screen.findByText(/Draft it with AI/)).toBeInTheDocument();
    expect(screen.getByText('Fetch a URL and summarize it')).toBeInTheDocument();
  });
});
