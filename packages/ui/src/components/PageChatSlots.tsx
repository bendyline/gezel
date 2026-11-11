import { PageChatMessageSchema, type PageChatModal, type PageChatOptions } from '@bendyline/gezel';
import { type RefObject, Suspense, lazy, useEffect, useState } from 'react';
import './PageChatSlots.css';

const PageChat = lazy(() =>
  import('./PageChat.js').then((module) => ({ default: module.PageChat })),
);
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface Slot {
  id: string;
  options: PageChatOptions;
  rect: Rect;
  modal?: PageChatModal;
}

/**
 * The slot's clip while a page modal is open: everything but the modal's
 * areas, so the dimmed conversation never covers the dialog drawn beneath it.
 */
export function clipAroundModal(rect: Rect, modal: PageChatModal | undefined): string | undefined {
  if (!modal) return undefined;
  const left = Math.max(0, rect.x);
  const top = Math.max(0, rect.y);
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  const holes = modal.areas
    .map((area) => {
      const x1 = Math.max(0, Math.round(area.x - left));
      const y1 = Math.max(0, Math.round(area.y - top));
      const x2 = Math.min(width, Math.round(area.x + area.width - left));
      const y2 = Math.min(height, Math.round(area.y + area.height - top));
      return x2 > x1 && y2 > y1 ? `M${x1} ${y1}H${x2}V${y2}H${x1}Z` : '';
    })
    .join('');
  return holes ? `path(evenodd, "M0 0H${width}V${height}H0Z${holes}")` : undefined;
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
            : { ...slot, rect: message.rect, modal: message.modal },
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
      {slots.map((slot) => {
        // A page modal is open: the conversation stays on screen, dimmed like
        // the rest of the page and out of reach until the modal closes.
        const dimmed = slot.modal !== undefined;
        return (
          <div
            key={slot.id}
            className="page-chat-slot"
            data-dimmed={dimmed ? 'true' : undefined}
            inert={dimmed}
            style={{
              left: Math.max(0, slot.rect.x),
              top: Math.max(0, slot.rect.y),
              width: slot.rect.width,
              height: slot.rect.height,
              visibility: slot.rect.width && slot.rect.height ? 'visible' : 'hidden',
              clipPath: clipAroundModal(slot.rect, slot.modal),
            }}
          >
            <Suspense fallback={<output>Loading chat…</output>}>
              <PageChat projectId={projectId} options={slot.options} />
            </Suspense>
            {dimmed && (
              <div
                className="page-chat-slot-scrim"
                aria-hidden="true"
                style={slot.modal?.scrim ? { background: slot.modal.scrim } : undefined}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
