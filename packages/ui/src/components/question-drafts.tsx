import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

type Drafts = { values: Map<string, Map<string, unknown>>; listeners: Set<() => void> };
const Context = createContext<Drafts | null>(null);

/** Kept in memory for this app visit, never in localStorage or sent before Submit. */
export function QuestionDraftProvider({ children }: { children: ReactNode }) {
  const drafts = useRef<Drafts>({ values: new Map(), listeners: new Set() });
  return <Context.Provider value={drafts.current}>{children}</Context.Provider>;
}

export function useQuestionDraft<T>(
  id: string,
  field: string,
  initial: () => T,
): [T, Dispatch<SetStateAction<T>>] {
  const drafts = useContext(Context);
  const [local, setLocal] = useState<T>(initial);
  const current = useRef(local);
  const read = useCallback(
    () =>
      drafts?.values.get(id)?.has(field)
        ? (drafts.values.get(id)!.get(field) as T)
        : current.current,
    [drafts, id, field],
  );
  const subscribe = useCallback(
    (listener: () => void) => {
      drafts?.listeners.add(listener);
      return () => {
        drafts?.listeners.delete(listener);
      };
    },
    [drafts],
  );
  const value = useSyncExternalStore(subscribe, read, read);
  const update = useCallback<Dispatch<SetStateAction<T>>>(
    (next) => {
      const resolved = typeof next === 'function' ? (next as (previous: T) => T)(read()) : next;
      current.current = resolved;
      if (drafts) {
        const entry = drafts.values.get(id) ?? new Map<string, unknown>();
        entry.set(field, resolved);
        drafts.values.set(id, entry);
        for (const listener of drafts.listeners) listener();
      } else setLocal(resolved);
    },
    [drafts, id, field, read],
  );
  return [value, update];
}
