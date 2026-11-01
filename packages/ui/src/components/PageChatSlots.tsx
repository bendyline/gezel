import { PageChatMessageSchema, type PageChatOptions } from '@bendyline/gezel';
import { type RefObject, Suspense, lazy, useEffect, useState } from 'react';
import './PageChatSlots.css';

const PageChat = lazy(() =>
  import('./PageChat.js').then((module) => ({ default: module.PageChat })),
);
interface Slot {
  id: string;
  options: PageChatOptions;
  rect: { x: number; y: number; width: number; height: number };
}

/** Kept inside the frame's clipped wrapper so a page cannot cover shell controls. */
export function PageChatSlots({
  frameRef,
  projectId,
}: {
  frameRef: RefObject<HTMLIFrameElement | null>;
  projectId: string;
}) {
  const [slots, setSlots] = useState<Slot[]>([]);
  useEffect(() => {
    const active = new Map<string, Slot>();
    const receive = (event: MessageEvent) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const raw = event.data;
      if (raw?.__gezelPage === 1 && raw.kind === 'hello') {
        active.clear();
        setSlots([]);
        return;
      }
      if (raw?.__gezelPage !== 1 || !String(raw.kind).startsWith('chat-')) return;
      const reply = (ok: boolean, error?: string) =>
        frameRef.current?.contentWindow?.postMessage(
          {
            __gezelPage: 1,
            kind: 'chat-result',
            id: raw.id,
            ok,
            ...(error ? { error, errorCode: 'invalid-input' } : {}),
          },
          '*',
        );
      const parsed = PageChatMessageSchema.safeParse(raw);
      if (!parsed.success) {
        if (raw.kind === 'chat-mount') reply(false, 'Invalid chat options.');
        return;
      }
      const message = parsed.data;
      if (message.kind === 'chat-mount') {
        if (active.has(message.id) || active.size >= 4) {
          reply(false, 'At most four chat components can be open.');
          return;
        }
        active.set(message.id, {
          id: message.id,
          options: message.options,
          rect: { x: 0, y: 0, width: 0, height: 0 },
        });
        reply(true);
      } else if (message.kind === 'chat-destroy') active.delete(message.id);
      else {
        const slot = active.get(message.id);
        if (!slot) return;
        active.set(
          message.id,
          message.kind === 'chat-update'
            ? { ...slot, options: message.options }
            : { ...slot, rect: message.rect },
        );
      }
      setSlots([...active.values()]);
    };
    window.addEventListener('message', receive);
    return () => {
      window.removeEventListener('message', receive);
    };
  }, [frameRef]);
  return (
    <div className="page-chat-slots">
      {slots.map((slot) => (
        <div
          key={slot.id}
          className="page-chat-slot"
          style={{
            left: Math.max(0, slot.rect.x),
            top: Math.max(0, slot.rect.y),
            width: slot.rect.width,
            height: slot.rect.height,
            visibility: slot.rect.width && slot.rect.height ? 'visible' : 'hidden',
          }}
        >
          <Suspense fallback={<output>Loading chat…</output>}>
            <PageChat projectId={projectId} options={slot.options} />
          </Suspense>
        </div>
      ))}
    </div>
  );
}
