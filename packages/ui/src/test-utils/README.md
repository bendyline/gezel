# UI test utilities

Shared infrastructure for testing the UI package. Three pieces:

| File | Purpose |
|---|---|
| [`setup.ts`](./setup.ts) | Loaded by `vitest.config.ts` as a `setupFiles` entry. Wires up `@testing-library/jest-dom` matchers, registers a per-test `cleanup()` hook, and seeds `window.__GEZEL__` with stable defaults. |
| [`mockApi.ts`](./mockApi.ts) | `createMockApi()` — Proxy-backed `Partial<GezelClient>` factory. Every accessed method auto-creates a `vi.fn()` returning a sensible default (`{ gezels: [] }`, `{ projects: [] }`, etc.). Tests override per-call with `vi.mocked(api.x).mockResolvedValue(...)`. |
| [`primitivesMock.tsx`](./primitivesMock.tsx) | Native-HTML stand-ins for the Radix primitives in `../primitives/`. Avoids fighting jsdom over portals, positioning, and pointer events. |

## Patterns to follow

### 1. Mock the api module up front

`api.ts` exports a singleton `GezelClient` constructed from `window.__GEZEL__`.
Replace it with a fresh proxy at the top of the test file:

```tsx
import { vi } from 'vitest';
import { createMockApi } from '../test-utils/mockApi.js';

vi.mock('../api.js', () => ({ api: createMockApi() }));

// Top-level await to import the module-under-test AFTER the mock
// is registered. (Vitest hoists vi.mock(), but this pattern stays
// readable and works even with re-exports.)
const { HistoryView } = await import('./HistoryView.js');
const { api } = await import('../api.js');
```

Inside the suite, configure responses per-test in `beforeEach` so each
test starts from a known state:

```tsx
beforeEach(() => {
  vi.mocked(api.listGezels).mockResolvedValue({ gezels: [] });
  vi.mocked(api.listProjects).mockResolvedValue({ projects: [] });
  vi.mocked(api.listHistory).mockResolvedValue({ entries: [] });
});
```

The Proxy-backed mock means you don't have to enumerate every method
the view might call — unconfigured calls resolve to `{}` (or the
default in `DEFAULT_RESPONSES`) instead of `undefined`.

### 2. Mock the Radix primitives via primitivesMock

Views that use `<Select.Root>`, `<Dialog.Root>`, `<Tabs.Root>`, etc.
should mock the whole module:

```tsx
import { primitivesMock } from '../test-utils/primitivesMock.js';

vi.mock('../primitives/index.js', () => primitivesMock);
```

The mock renders Selects as native `<select>` elements and Dialogs
as plain `<div role="dialog">`, so `fireEvent.change`, `getByRole`,
and `findByText` all behave intuitively. Add new primitives to the
mock as views need them — keep it simple, prefer accessibility-
matching markup over visual fidelity.

### 3. Mock heavy child components

When a view delegates to a complex child (e.g. `EditorShell` from
squisq, `FileTree`, `TaskDetail`, `ConfirmDialog`), mock the child
to a minimal stand-in that exposes the props you want to assert on:

```tsx
vi.mock('./TaskDetail.js', () => ({
  TaskDetail: (props: { task: Task; standalone?: boolean }) => (
    <div data-testid="task-detail">
      <span data-testid="task-ref">{props.task.ref}</span>
      <span data-testid="standalone">{String(props.standalone ?? false)}</span>
    </div>
  ),
}));
```

This keeps each view's tests focused on its own responsibility:
"did I fetch the right things, surface the right loading/error
states, and pass the right props down?"

### 4. Use `userEvent` for real interactions, `fireEvent` for direct events

```tsx
const user = userEvent.setup();
await user.type(screen.getByPlaceholderText('Search…'), 'maya');
await user.click(screen.getByRole('button', { name: /refresh/i }));
```

`fireEvent.change(select, { target: { value: 'session' } })` is
fine for the mocked Select primitive (which is a real `<select>`).

### 5. Test list

A solid view test typically covers:

- Empty / loading / error states
- The view's main success path (renders the API response)
- Each user-driven action (filter change, button click, form submit)
- Side effects: localStorage writes, `window.dispatchEvent`, etc.
- Prop-driven branches (`projectId` filter, `standalone` mode)

See [`HistoryView.test.tsx`](../views/HistoryView.test.tsx),
[`TaskTabContent.test.tsx`](../views/TaskTabContent.test.tsx), and
[`DocumentsView.test.tsx`](../views/DocumentsView.test.tsx) for
complete examples covering different shapes of view.

## Adding a new view test

1. Identify the api methods the view calls and the child components
   it depends on.
2. `vi.mock` the api singleton, the primitives module, and any
   heavy children.
3. Set up sensible defaults in `beforeEach`.
4. Write tests that exercise loading → success → error → user
   interactions in that order — easier to read than scrambled.
5. Run: `pnpm --filter @bendyline/gezel-ui exec vitest run src/views/MyView.test.tsx`
