import type { Poppetje as PoppetjeStruct } from '@bendyline/gezel';
import { useEffect, useMemo, useState } from 'react';
import { ChatComposer } from '../../components/ChatComposer.js';
import { ChatReferences } from '../../components/ChatReferences.js';
import { GlobalTimeline } from '../../components/GlobalTimeline.js';
import { SessionSwitcher } from '../../components/SessionSwitcher.js';
import { pickChatPlaceholder } from '../../components/chat-placeholder.js';

/**
 * The meester conversation in the workshop's main column. Reuses the
 * existing global timeline + composer verbatim (migrated from HomeView's
 * `MeesterChatBody`) so streaming, tool calls, mentions, and markdown all
 * keep working. The conversation rail fills the workshop's main column, while
 * the composer receives its own quiet project-chat-style frame in CSS.
 */
export function MeesterConversation({
  meesterGezelId,
  meesterName,
  meesterIcon,
  meesterPoppetje,
  meesterIconOverride,
  emptyPlaceholder,
}: {
  meesterGezelId: string;
  meesterName: string;
  meesterIcon: string | null;
  meesterPoppetje: PoppetjeStruct | null;
  meesterIconOverride: boolean;
  emptyPlaceholder?: string;
}) {
  const [sessionId, setSessionId] = useState<string>('');
  const [sessionRefreshKey, setSessionRefreshKey] = useState(0);

  // Reset the focused session if the meester changes (rare).
  // biome-ignore lint/correctness/useExhaustiveDependencies: meesterGezelId is the reset trigger.
  useEffect(() => {
    setSessionId('');
  }, [meesterGezelId]);

  const composerPlaceholder = useMemo(
    () => pickChatPlaceholder({ role: 'meester', gezelName: meesterName }),
    [meesterName],
  );

  return (
    <section className="home-workshop-conversation" data-testid="meester-chat">
      <ChatReferences chatKey="meester:global">
        {({ onToolActivity, onArtifactReference, onTaskReference }) => (
          <>
            <GlobalTimeline
              activeSessionId={sessionId || undefined}
              onFocusSession={(sid) => setSessionId(sid)}
              onToolActivity={onToolActivity}
              onArtifactReference={onArtifactReference}
              onTaskReference={onTaskReference}
              emptyPlaceholder={emptyPlaceholder}
            />
            <ChatComposer
              gezelId={meesterGezelId}
              gezelName={meesterName}
              gezelIcon={meesterIcon}
              gezelPoppetje={meesterPoppetje}
              gezelIconOverride={meesterIconOverride}
              projectId="default"
              sessionId={sessionId || undefined}
              onSessionCreated={(sid) => {
                setSessionId(sid);
                setSessionRefreshKey((k) => k + 1);
              }}
              onToolActivity={onToolActivity}
              placeholder={composerPlaceholder}
              belowAddressLine={
                <SessionSwitcher
                  gezelId={meesterGezelId}
                  projectId="default"
                  sessionId={sessionId || undefined}
                  onSessionIdChange={(next) => setSessionId(next ?? '')}
                  refreshKey={sessionRefreshKey}
                />
              }
            />
          </>
        )}
      </ChatReferences>
    </section>
  );
}
