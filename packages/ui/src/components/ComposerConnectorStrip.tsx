import {
  type PromptConnectorOffer,
  type PromptInclusion,
  findPromptConnectorCandidates,
  promptConnectorKey,
} from '@bendyline/gezel';
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { apiErrorMessage } from '../api-error.js';
import { api } from '../api.js';
import { ConnectorMark } from './ConnectorMark.js';

/**
 * Connections the draft calls for, one row each, above the To line. A rule
 * finds something in the words (a web address) and the daemon says whether it
 * still needs doing. An `include` offer is a notice, not a question: Send
 * takes it, unless the person dismissed it or already pressed Save now. A
 * `connect` offer opens a form and is never taken on Send.
 *
 * Nothing here is specific to web pages: the wording comes from the offer's
 * effect and the mark from its connector type, so a new rule shows up with no
 * change to this file. Contract: docs/prompt-connectors.md.
 */

export interface ComposerConnectorHandle {
  /**
   * Take every open `include` offer in these words that the person has not
   * dismissed, and wait for each to settle. Never rejects, and never holds
   * Send past `SEND_WAIT_MS`: the message goes with whatever was saved.
   */
  beforeSend(text: string): Promise<void>;
}

/** How long Send waits for saves. A page capture is bounded at 45 awake-seconds. */
export const SEND_WAIT_MS = 60_000;

type Status =
  | { state: 'working'; offer: PromptConnectorOffer }
  | { state: 'done'; offer: PromptConnectorOffer; inclusion: PromptInclusion }
  | { state: 'failed'; offer: PromptConnectorOffer; reason: string };

export const ComposerConnectorStrip = forwardRef<
  ComposerConnectorHandle,
  {
    projectId: string;
    /** The draft, settled after a typing pause. */
    text: string;
    /** Opens the Connections form for a `connect` offer. Without it, those offers are not shown. */
    onConnect?: (offer: PromptConnectorOffer) => void;
  }
>(function ComposerConnectorStrip({ projectId, text, onConnect }, ref) {
  const candidates = useMemo(() => findPromptConnectorCandidates(text), [text]);
  const candidateKey = candidates.map(promptConnectorKey).join('\n');
  const [offers, setOffers] = useState<PromptConnectorOffer[]>([]);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [status, setStatus] = useState<ReadonlyMap<string, Status>>(() => new Map());
  const textRef = useRef(text);
  textRef.current = text;
  const dismissedRef = useRef(dismissed);
  dismissedRef.current = dismissed;
  const statusRef = useRef(status);
  statusRef.current = status;
  /** Saves under way, so Send waits for one the person started with Save now. */
  const inFlight = useRef(new Map<string, Promise<void>>());

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new project starts the strip over.
  useEffect(() => {
    setOffers([]);
    setDismissed(new Set());
    setStatus(new Map());
    inFlight.current = new Map();
  }, [projectId]);

  // The daemon is asked only when what the rules find changes, never per keystroke.
  useEffect(() => {
    if (!candidateKey) {
      setOffers([]);
      // A cleared draft (a send) ends what was said about its addresses.
      setStatus((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }
    let stop = false;
    void api
      .promptConnectorOffers(projectId, textRef.current)
      .then((res) => {
        if (!stop) setOffers(res.offers ?? []);
      })
      // An older daemon has no such route; offer nothing.
      .catch(() => {
        if (!stop) setOffers([]);
      });
    return () => {
      stop = true;
    };
  }, [projectId, candidateKey]);

  const note = useCallback((key: string, next: Status) => {
    setStatus((prev) => new Map(prev).set(key, next));
  }, []);

  const take = useCallback(
    (offer: PromptConnectorOffer): Promise<void> => {
      const key = promptConnectorKey(offer);
      const running = inFlight.current.get(key);
      if (running) return running;
      note(key, { state: 'working', offer });
      const run = api
        .acceptPromptConnectorOffer(projectId, { rule: offer.rule, subject: offer.subject })
        .then(({ inclusion }) =>
          note(
            key,
            inclusion.path
              ? { state: 'done', offer, inclusion }
              : { state: 'failed', offer, reason: inclusion.reason ?? 'It could not be saved.' },
          ),
        )
        .catch((err) => note(key, { state: 'failed', offer, reason: apiErrorMessage(err) }))
        .finally(() => {
          inFlight.current.delete(key);
        });
      inFlight.current.set(key, run);
      return run;
    },
    [projectId, note],
  );

  useImperativeHandle(
    ref,
    () => ({
      async beforeSend(liveText: string) {
        if (findPromptConnectorCandidates(liveText).length === 0) return;
        let open: PromptConnectorOffer[];
        try {
          // Asked again with the words as sent: the strip's own list lags typing.
          open = (await api.promptConnectorOffers(projectId, liveText)).offers ?? [];
        } catch {
          return;
        }
        const pending = open.filter((offer) => {
          const key = promptConnectorKey(offer);
          if (offer.effect !== 'include' || dismissedRef.current.has(key)) return false;
          // A save that just failed is the person's to retry, not Send's.
          return statusRef.current.get(key)?.state !== 'failed';
        });
        if (pending.length === 0 && inFlight.current.size === 0) return;
        let timer: number | undefined;
        await Promise.race([
          Promise.all([...pending.map(take), ...inFlight.current.values()]),
          new Promise<void>((resolve) => {
            timer = window.setTimeout(resolve, SEND_WAIT_MS);
          }),
        ]);
        window.clearTimeout(timer);
      },
    }),
    [projectId, take],
  );

  // The daemon's offers decide what is shown; the rules run here only to know
  // when to ask and which offers the words still name.
  const named = new Set(candidates.map((c) => c.subject));
  const shown = new Map<string, { offer: PromptConnectorOffer; held: Status | undefined }>();
  for (const offer of offers) {
    const key = promptConnectorKey(offer);
    shown.set(key, { offer, held: status.get(key) });
  }
  // A saved page is no longer offered, but its row stays while the words name it.
  for (const [key, held] of status) {
    if (!shown.has(key)) shown.set(key, { offer: held.offer, held });
  }
  const rows = [...shown].flatMap(([key, { offer, held }]) => {
    if (!named.has(offer.subject) || dismissed.has(key)) return [];
    if (!held && offer.effect === 'connect' && !onConnect) return [];
    return [{ key, offer, held }];
  });
  if (rows.length === 0) return null;

  const dismiss = (key: string) => setDismissed((prev) => new Set([...prev, key]));

  return (
    <div className="chat-composer-connector-strip">
      {rows.map(({ key, offer, held }) => {
        const name = <strong title={offer.subject}>{offer.label}</strong>;
        const dismissKey = (label: string) => (
          <button
            type="button"
            className="gz-key gz-key--icon"
            aria-label={`${label} ${offer.label}`}
            title={label}
            onClick={() => dismiss(key)}
          >
            ×
          </button>
        );
        return (
          <div key={key} className="chat-composer-connector-row" data-state={held?.state ?? 'open'}>
            <ConnectorMark
              className="chat-composer-connector-mark"
              connectorType={offer.connectorType}
              tags={offer.typeTags}
              logoUrl={offer.logoUrl}
              iconSvg={offer.iconSvg}
              size={16}
              svgClassName="chat-composer-connector-mark-svg"
            />
            {held?.state === 'working' ? (
              <output className="chat-composer-connector-text">Saving {name}…</output>
            ) : held?.state === 'done' ? (
              <output className="chat-composer-connector-text">
                Saved <strong title={offer.subject}>{held.inclusion.title ?? offer.label}</strong>.
                It will be included in the chat.
              </output>
            ) : held?.state === 'failed' ? (
              <>
                <output className="chat-composer-connector-text" data-tone="error">
                  {name} could not be saved. {held.reason}
                </output>
                <div className="gz-tray" role="toolbar" aria-label={`Save ${offer.label}`}>
                  <button type="button" className="gz-key" onClick={() => void take(offer)}>
                    Try again
                  </button>
                  {dismissKey('Dismiss')}
                </div>
              </>
            ) : offer.effect === 'include' ? (
              <>
                <span className="chat-composer-connector-text">
                  {name} will be saved here and included in the chat.
                </span>
                <div className="gz-tray" role="toolbar" aria-label={`Save ${offer.label}`}>
                  <button type="button" className="gz-key" onClick={() => void take(offer)}>
                    Save now
                  </button>
                  {dismissKey('Don’t save')}
                </div>
              </>
            ) : (
              <>
                <span className="chat-composer-connector-text">
                  {name} can be connected with {offer.typeName ?? 'a connection'}.
                </span>
                <div className="gz-tray" role="toolbar" aria-label={`Connect ${offer.label}`}>
                  <button type="button" className="gz-key" onClick={() => onConnect?.(offer)}>
                    Connect…
                  </button>
                  {dismissKey('Not now')}
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
});
