import type { MobileSnapshot } from '@bendyline/gezel/schemas';
import { useState } from 'react';
import type { MobileClient } from './runtime/index.js';
import { searchConversations } from './runtime/search.js';

export function Conversations({
  snapshot,
  client,
  busy,
  onSnapshot,
  onSelect,
  onError,
  onBusyChange,
}: {
  snapshot: MobileSnapshot;
  client: MobileClient;
  busy: boolean;
  onSnapshot(snapshot: MobileSnapshot): void;
  onSelect(id?: string): Promise<void>;
  onError(error: unknown): void;
  onBusyChange(busy: boolean): void;
}) {
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const state = snapshot.state;
  const active = state.sessions.find(({ id }) => id === state.activeSessionId)!;
  const results = searchConversations(state, query);
  const disabled = busy || saving;

  async function mutate(action: () => Promise<MobileSnapshot>) {
    if (disabled) return;
    setSaving(true);
    onBusyChange(true);
    try {
      onSnapshot(await action());
      setEditing(null);
      setDeleting(null);
    } catch (error) {
      onError(error);
    } finally {
      setSaving(false);
      onBusyChange(false);
    }
  }
  return (
    <>
      <div className="mobile-sidebar-heading">
        <h2>Your conversations</h2>
        <button
          type="button"
          className="gz-key"
          disabled={disabled}
          onClick={() => void onSelect()}
        >
          New
        </button>
      </div>
      <label className="mobile-model-label">
        Search conversations
        <input
          type="search"
          value={query}
          maxLength={200}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find words or a title"
        />
      </label>
      <nav aria-label="Conversations">
        {results.map((item) => (
          <button
            type="button"
            key={item.id}
            className="mobile-conversation"
            aria-current={item.id === state.activeSessionId ? 'page' : undefined}
            disabled={disabled}
            onClick={() => {
              setEditing(null);
              setDeleting(null);
              void onSelect(item.id);
            }}
          >
            {item.title || 'A new conversation'}
          </button>
        ))}
      </nav>
      {results.length === 0 && <p className="mobile-small">No conversations match these words.</p>}
      <details className="mobile-conversation-options">
        <summary>Manage this conversation</summary>
        <p className="mobile-small">{active.title}</p>
        <div className="mobile-actions">
          <button
            type="button"
            className="gz-key"
            disabled={disabled}
            onClick={() => {
              setTitle(active.title);
              setEditing(active.id);
              setDeleting(null);
            }}
          >
            Rename
          </button>
          <button
            type="button"
            className="gz-key"
            disabled={disabled}
            onClick={() => {
              setDeleting(active.id);
              setEditing(null);
            }}
          >
            Delete conversation
          </button>
        </div>
        {editing && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void mutate(() => client.renameConversation(editing, title));
            }}
          >
            <label className="mobile-model-label">
              Conversation name
              <input
                value={title}
                maxLength={100}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
            <div className="mobile-actions">
              <button type="submit" className="gz-key" disabled={disabled || !title.trim()}>
                Save name
              </button>
              <button
                type="button"
                className="gz-key"
                disabled={disabled}
                onClick={() => setEditing(null)}
              >
                Cancel rename
              </button>
            </div>
          </form>
        )}
        {deleting && (
          <div className="mobile-confirm">
            <p>Delete this conversation and its messages? This cannot be undone.</p>
            <div className="mobile-actions">
              <button
                type="button"
                className="gz-key"
                disabled={disabled}
                onClick={() => void mutate(() => client.deleteConversation(deleting))}
              >
                Delete permanently
              </button>
              <button
                type="button"
                className="gz-key"
                disabled={disabled}
                onClick={() => setDeleting(null)}
              >
                Keep conversation
              </button>
            </div>
          </div>
        )}
      </details>
      <p className="mobile-small">Saved on this device.</p>
    </>
  );
}
