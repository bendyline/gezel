import { isoDaysAhead, records } from '../app-parity-helpers.ts';
import type { ParityCase } from '../app-parity.ts';

const DESK = [
  {
    tool: 'page_add_ticket',
    input: {
      subject: 'Book arrived with a torn cover',
      customer: 'Daniel Okafor',
      channel: 'email',
      category: 'delivery',
      priority: 'normal',
      message: 'My copy of Night Ferries came with the cover torn at one corner. Order JP-4471.',
      receivedAt: isoDaysAhead(-2),
    },
  },
  {
    tool: 'page_add_ticket',
    input: {
      subject: 'Charged twice for the autumn bundle',
      customer: 'Sam Ortiz',
      channel: 'email',
      category: 'billing',
      priority: 'urgent',
      message: 'My card shows two charges for the autumn bundle. I only placed one order.',
      receivedAt: isoDaysAhead(-1),
    },
  },
  {
    tool: 'page_add_ticket',
    input: {
      subject: 'Wholesale order for 20 copies',
      customer: 'Fernhill Books',
      channel: 'email',
      category: 'business',
      priority: 'normal',
      message: 'We would like 20 copies of The Salt Road for an author event. What are your terms?',
      receivedAt: isoDaysAhead(-4),
      gap: 'wholesale terms',
    },
  },
  {
    tool: 'page_add_ticket',
    input: {
      subject: 'Trade discount for a bookshop',
      customer: 'Corner Shelf Books',
      channel: 'email',
      category: 'business',
      priority: 'normal',
      message: 'We stock a lot of poetry. What discount do you offer bookshops?',
      receivedAt: isoDaysAhead(-8),
      gap: 'wholesale terms',
    },
  },
  {
    tool: 'page_set_ticket_status',
    input: { subject: 'Trade discount for a bookshop', status: 'waiting' },
  },
  {
    tool: 'page_add_ticket',
    input: {
      subject: 'When will Night Ferries be back in stock?',
      customer: 'Ana Ruiz',
      channel: 'social',
      category: 'product',
      priority: 'normal',
      receivedAt: isoDaysAhead(-11),
    },
  },
  { tool: 'page_set_ticket_status', input: { subject: 'Night Ferries', status: 'resolved' } },
];

const cases: ParityCase[] = [
  {
    id: 'support-desk-draft-reply',
    typeId: 'support-desk',
    params: { business: 'a small publisher', voice: 'warm and plain' },
    prepare: DESK,
    message: 'Draft a reply to the torn cover',
    reads: ['tickets.json'],
    check: (docs) => {
      const all = records(docs['tickets.json']);
      const torn = all.find((r) => /torn cover/i.test(String(r.fields?.subject)));
      if (!torn) return { ok: false, detail: 'the torn-cover ticket left the desk' };
      const reply = String(torn.fields?.suggestedReply ?? '');
      const others = all.filter((r) => r !== torn && r.fields?.suggestedReply);
      return reply.length >= 40 &&
        others.length === 0 &&
        all.length === DESK.filter((s) => s.tool === 'page_add_ticket').length
        ? {
            ok: true,
            detail: `reply saved on ${torn.id} (${reply.length} chars), status ${String(torn.status)}`,
          }
        : {
            ok: false,
            detail: `reply=${reply.length} chars, replies on other tickets=${others.length}, tickets=${all.length}`,
          };
    },
  },
  {
    id: 'support-desk-needs-reply',
    typeId: 'support-desk',
    params: { business: 'a small publisher', voice: 'warm and plain' },
    prepare: DESK,
    message: 'What needs a reply today?',
    reads: [],
    check: () => ({ ok: true, detail: 'a question changes no file' }),
    reply: (text) => {
      const urgent = /charged twice|double charge|two charges|autumn bundle/i.test(text);
      const torn = /torn|cover/i.test(text);
      // The torn copy is also Night Ferries, so the resolved ticket is told apart by its question and customer.
      const strays = /back in stock|ana ruiz/i.test(text);
      return urgent && torn && !strays
        ? {
            ok: true,
            detail: 'named the urgent charge and the torn cover, left the resolved ticket out',
          }
        : { ok: false, detail: `urgent=${urgent} torn=${torn} strayResolved=${strays}` };
    },
  },
];

export default cases;
