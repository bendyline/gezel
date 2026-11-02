import { isoDaysAhead, records } from '../app-parity-helpers.ts';
import type { ParityCase } from '../app-parity.ts';

const JUNIPER = 'Juniper Press website redesign';
const HARBOR = 'Harbor Street Café menu and signage';
const BOARD = [
  {
    tool: 'page_add_project',
    input: {
      title: JUNIPER,
      client: 'Juniper Press',
      contact: 'Mei Lin',
      lead: 'Ruth',
      dueAt: isoDaysAhead(40),
      status: 'active',
    },
  },
  {
    tool: 'page_add_project',
    input: {
      title: HARBOR,
      client: 'Harbor Street Café',
      contact: 'Dana',
      lead: 'Sam',
      dueAt: isoDaysAhead(12),
      status: 'active',
    },
  },
  {
    tool: 'page_add_milestone',
    input: { project: JUNIPER, title: 'Homepage design', dueAt: isoDaysAhead(2), owner: 'Ruth' },
  },
  {
    tool: 'page_add_milestone',
    input: {
      project: JUNIPER,
      title: 'Inner page templates',
      dueAt: isoDaysAhead(9),
      owner: 'Ruth',
    },
  },
  {
    tool: 'page_add_milestone',
    input: { project: HARBOR, title: 'Menu layout', dueAt: isoDaysAhead(3), owner: 'Sam' },
  },
  { tool: 'page_set_milestone_status', input: { title: 'Homepage design', status: 'waiting' } },
  {
    tool: 'page_set_milestone_status',
    input: { title: 'Inner page templates', status: 'in-progress' },
  },
  { tool: 'page_set_milestone_status', input: { title: 'Menu layout', status: 'waiting' } },
];

const cases: ParityCase[] = [
  {
    id: 'client-delivery-approved',
    typeId: 'client-delivery',
    params: { studio: 'Fernwood Studio, a six-person design agency' },
    prepare: BOARD,
    message: 'Juniper approved the homepage design',
    reads: ['milestones.json'],
    check: (docs) => {
      const all = records(docs['milestones.json']);
      const homepage = all.filter((r) => /homepage design/i.test(String(r.fields?.title)));
      if (homepage.length !== 1)
        return { ok: false, detail: `${homepage.length} homepage records` };
      const inner = all.find((r) => /inner page/i.test(String(r.fields?.title)));
      const menu = all.find((r) => /menu layout/i.test(String(r.fields?.title)));
      return homepage[0]!.status === 'approved' &&
        inner?.status === 'in-progress' &&
        menu?.status === 'waiting'
        ? { ok: true, detail: 'homepage approved; the other milestones untouched' }
        : {
            ok: false,
            detail: `homepage=${homepage[0]!.status} inner=${inner?.status} menu=${menu?.status}`,
          };
    },
  },
  {
    id: 'client-delivery-waiting',
    typeId: 'client-delivery',
    params: { studio: 'Fernwood Studio, a six-person design agency' },
    prepare: BOARD,
    message: 'What’s waiting on clients?',
    reads: [],
    check: () => ({ ok: true, detail: 'a question changes no file' }),
    reply: (text) => {
      const homepage = /homepage/i.test(text);
      const menu = /menu layout/i.test(text);
      const strays =
        /inner page/i.test(text) && !/progress|working|our side|not waiting|due/i.test(text);
      return homepage && menu && !strays
        ? { ok: true, detail: 'named both approvals out, not the in-progress work' }
        : { ok: false, detail: `homepage=${homepage} menu=${menu} strayInner=${strays}` };
    },
  },
];

export default cases;
