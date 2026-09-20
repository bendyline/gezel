import type { MobileProvider, MobileProviderId, MobileSnapshot } from '@bendyline/gezel/schemas';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { AppBrand } from '../../ui/src/components/AppBrand.js';
import { ProjectSectionTabs } from '../../ui/src/components/ProjectSectionTabs.js';
import { ResponsiveAppShell } from '../../ui/src/components/ResponsiveAppShell.js';
import { useResponsiveLayout } from '../../ui/src/hooks/useResponsiveLayout.js';
import { Poppetje } from '../../ui/src/poppetje/Poppetje.js';
import { Conversations } from './Conversations.js';
import { MobileNavigation } from './MobileNavigation.js';
import { ProviderPanel } from './ProviderPanel.js';
import type { MobileHost, ModelInventory } from './native.js';
import type { MobileClient } from './runtime/index.js';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function App({ client, host }: { client: MobileClient; host: MobileHost }) {
  const { compact, preview, exitPreview } = useResponsiveLayout();
  const [navigationOpen, setNavigationOpen] = useState(compact);
  const [view, setView] = useState<'project' | 'settings'>('project');
  const [snapshot, setSnapshot] = useState<MobileSnapshot | null>(null);
  const [inventory, setInventory] = useState<ModelInventory>({ models: [] });
  const [providers, setProviders] = useState<MobileProvider[]>([]);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const [navigationBusy, setNavigationBusy] = useState(false);
  const [showConversations, setShowConversations] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const refreshId = useRef(0);
  const showError = useCallback((error: unknown) => setError(errorText(error)), []);
  const refresh = useCallback(async () => {
    const id = ++refreshId.current;
    const [nextProviders, nextInventory] = await Promise.allSettled([
      client.providers(),
      host.listModels(),
    ]);
    if (id !== refreshId.current) return;
    setProviders(nextProviders.status === 'fulfilled' ? nextProviders.value : []);
    setInventory(nextInventory.status === 'fulfilled' ? nextInventory.value : { models: [] });
    if (nextProviders.status === 'rejected') throw nextProviders.reason;
    if (nextInventory.status === 'rejected') throw nextInventory.reason;
  }, [client, host]);

  useEffect(() => {
    const unsubscribe = client.subscribe(setSnapshot);
    void client
      .snapshot()
      .then(setSnapshot)
      .catch((e) => setError(errorText(e)));
    void refresh().catch(showError);
    const checkpoint = () => {
      if (document.hidden) void client.cancel().catch(() => {});
      else void refresh().catch(showError);
    };
    document.addEventListener('visibilitychange', checkpoint);
    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', checkpoint);
    };
  }, [client, refresh, showError]);

  const state = snapshot?.state;
  const session = state?.sessions.find((item) => item.id === state.activeSessionId);
  const turnBusy = pending || Boolean(snapshot?.activeRequestId);
  const busy = turnBusy || navigationBusy;
  const selectedProvider = providers.find((item) => item.id === state?.selectedProviderId);
  const available = selectedProvider?.availability === 'available';
  useEffect(() => {
    if (session?.messages.length) bottom.current?.scrollIntoView({ block: 'end' });
  }, [session]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || busy || modelBusy || !available) return;
    setPending(true);
    setDraft('');
    setError('');
    try {
      setSnapshot(await client.send(text));
    } catch (e) {
      setError(errorText(e));
      // A failed final save retains a durable user record; resending would duplicate it.
      const latest = await client.snapshot().catch(() => null);
      const messages = latest?.state.sessions.find(
        (item) => item.id === state?.activeSessionId,
      )?.messages;
      const recorded = messages && session && messages.length > session.messages.length;
      if (!recorded) setDraft((current) => current || text);
    } finally {
      setPending(false);
      void refresh().catch(showError);
    }
  }

  async function changeConversation(id?: string) {
    if (busy || modelBusy) return;
    setNavigationBusy(true);
    setError('');
    try {
      setSnapshot(await (id ? client.selectConversation(id) : client.newConversation()));
      setShowConversations(false);
      setView('project');
      setNavigationOpen(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setNavigationBusy(false);
    }
  }

  async function changeProvider(id: MobileProviderId) {
    setError('');
    setSnapshot(await client.setProvider(id));
  }

  function openView(next: 'project' | 'settings') {
    setView(next);
    setNavigationOpen(false);
  }

  if (!state)
    return (
      <main className="mobile-opening">
        <h1>Gezel</h1>
        {error ? <p role="alert">{error}</p> : <output>Opening your workshop…</output>}
        {error && <p>Your saved conversations have been kept. Reopen the app to try again.</p>}
      </main>
    );

  return (
    <div
      className={`app mobile-app${compact ? ' app-compact' : ''}${preview ? ' app-mobile-preview' : ''}`}
    >
      <header className="app-header mobile-header">
        <AppBrand active={view === 'project'} onClick={() => openView('project')} />
        <span className="mobile-small">{host.native ? 'This device' : 'Browser preview'}</span>
      </header>
      {compact && (
        <div className="app-compact-navigation">
          <button
            type="button"
            className="gz-key"
            aria-expanded={navigationOpen}
            onClick={() => setNavigationOpen(!navigationOpen)}
          >
            {navigationOpen ? 'Return to view' : 'Navigation'}
          </button>
          <span className="app-compact-navigation-title">
            {navigationOpen
              ? 'Your workshop'
              : view === 'settings'
                ? 'Settings'
                : state.project.name}
          </span>
          {preview && (
            <button type="button" className="gz-key" onClick={exitPreview}>
              Exit preview
            </button>
          )}
        </div>
      )}
      {(error || snapshot.persistenceError || snapshot.cancellationError) && (
        <div className="mobile-error" role="alert">
          <p>{snapshot.cancellationError || snapshot.persistenceError || error}</p>
          {snapshot.persistenceError && !snapshot.cancellationError && (
            <button
              type="button"
              className="gz-key"
              onClick={() => {
                setError('');
                void client.retrySave().then(setSnapshot).catch(showError);
              }}
            >
              {snapshot.activeRequestId ? 'Retry save' : 'Check storage'}
            </button>
          )}
          {snapshot.persistenceError && !snapshot.activeRequestId && (
            <p>Your change was not saved. Check storage, then try the change again.</p>
          )}
        </div>
      )}
      <ResponsiveAppShell
        compact={compact}
        navigationOpen={navigationOpen}
        mainClassName="mobile-main"
        navigation={<MobileNavigation state={state} view={view} onOpen={openView} />}
      >
        <section className="mobile-settings" hidden={view !== 'settings'} aria-label="Settings">
          <h1>Settings</h1>
          <h2>Models</h2>
          <ProviderPanel
            host={host}
            providers={providers}
            selectedProviderId={state.selectedProviderId}
            inventory={inventory}
            busy={busy}
            onProvider={changeProvider}
            refresh={refresh}
            onError={showError}
            onBusyChange={setModelBusy}
          />
        </section>
        <section
          className="mobile-project"
          hidden={view !== 'project'}
          aria-label={`Project: ${state.project.name}`}
        >
          <header className="mobile-project-heading">
            <h1>{state.project.name}</h1>
            <button
              type="button"
              className="gz-key"
              aria-expanded={showConversations}
              onClick={() => setShowConversations(!showConversations)}
            >
              {showConversations ? 'Back to chat' : 'Conversations'}
            </button>
          </header>
          <ProjectSectionTabs
            items={[{ value: 'chat', label: 'Chat' }]}
            value="chat"
            compact={compact}
            onValueChange={() => setShowConversations(false)}
          />
          <div className="mobile-conversations" hidden={!showConversations}>
            <Conversations
              snapshot={snapshot}
              client={client}
              busy={busy || modelBusy}
              onSnapshot={setSnapshot}
              onSelect={changeConversation}
              onError={showError}
              onBusyChange={setNavigationBusy}
            />
          </div>
          <section
            className="mobile-chat"
            hidden={showConversations}
            aria-label={`Conversation with ${state.gezel.name}`}
          >
            <div className="mobile-companion">
              <Poppetje
                poppetje={state.gezel.poppetje}
                variant="icon"
                size={32}
                grainStyle="none"
                className="mobile-avatar"
              />
              <div>
                <h1>{state.gezel.name}</h1>
                <p>Your {state.gezel.role}</p>
              </div>
              <span className="mobile-locality">{available ? 'On this device' : 'Local chat'}</span>
            </div>
            {!available && (
              <div className="mobile-model-notice">
                <p>Choose a model in Settings to start talking with {state.gezel.name}.</p>
                <button type="button" className="gz-key" onClick={() => openView('settings')}>
                  Choose a model
                </button>
              </div>
            )}
            <div
              className="mobile-messages"
              role="log"
              aria-label="Messages"
              aria-live="polite"
              aria-relevant="additions"
              aria-busy={turnBusy}
            >
              {session?.messages.length === 0 && (
                <div className="mobile-welcome">
                  <h2>A little help, right here.</h2>
                  <p>
                    Bring a question, a half-formed idea, or something you want to think through.
                  </p>
                  <p className="mobile-small">
                    {available
                      ? 'Your conversation stays on this device.'
                      : `Choose a model to start talking with ${state.gezel.name}.`}
                  </p>
                </div>
              )}
              {session?.messages.map((message) => (
                <article
                  key={message.id}
                  className={`mobile-message mobile-message-${message.role}`}
                >
                  <p className="mobile-message-author">
                    {message.role === 'user' ? 'You' : state.gezel.name}
                    {message.providerId &&
                      ` · ${providers.find(({ id }) => id === message.providerId)?.name ?? 'On-device model'}`}
                  </p>
                  <div className="mobile-message-body">
                    {message.content || (message.status === 'streaming' ? 'Thinking…' : '')}
                  </div>
                  {message.status === 'interrupted' && (
                    <p className="mobile-message-status">
                      Response stopped. You can continue the conversation.
                    </p>
                  )}
                  {message.status === 'error' && (
                    <p className="mobile-message-status">
                      {message.error || 'The response could not finish.'}
                    </p>
                  )}
                  {message.status === 'complete' && message.stopReason === 'length' && (
                    <p className="mobile-message-status">
                      The response reached its length limit. You can ask to continue.
                    </p>
                  )}
                </article>
              ))}
              <div ref={bottom} />
            </div>
            <form className="mobile-composer" onSubmit={(event) => void submit(event)}>
              <label className="mobile-visually-hidden" htmlFor="mobile-message">
                Message {state.gezel.name}
              </label>
              <textarea
                id="mobile-message"
                value={draft}
                maxLength={16000}
                rows={2}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={`Message ${state.gezel.name}…`}
                disabled={
                  navigationBusy ||
                  !available ||
                  Boolean(snapshot.persistenceError || snapshot.cancellationError)
                }
              />
              <div className="mobile-composer-actions">
                <output className="mobile-small">
                  {turnBusy
                    ? `${state.gezel.name} is thinking…`
                    : available
                      ? 'Private · On this device'
                      : 'Choose a model to begin'}
                </output>
                {turnBusy ? (
                  <button
                    type="button"
                    className="gz-key"
                    onClick={() => {
                      void client
                        .cancel()
                        .then(setSnapshot)
                        .catch((e) => setError(errorText(e)));
                    }}
                  >
                    {snapshot.cancellationError ? 'Retry stop' : 'Stop'}
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="gz-key mobile-send"
                    disabled={
                      navigationBusy ||
                      !draft.trim() ||
                      !available ||
                      modelBusy ||
                      Boolean(snapshot?.persistenceError)
                    }
                  >
                    Send
                  </button>
                )}
              </div>
            </form>
          </section>
        </section>
      </ResponsiveAppShell>
    </div>
  );
}
