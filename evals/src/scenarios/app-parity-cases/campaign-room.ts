import { isoDaysAhead, list } from '../app-parity-helpers.ts';
import type { ParityCase } from '../app-parity.ts';

/** The most recent Tuesday before today, the day "How did Tuesday do?" means. */
const LAST_TUESDAY = isoDaysAhead(-(((new Date().getDay() - 2 + 6) % 7) + 1));
const ADS_DAY = isoDaysAhead(-9);
const CAMPAIGN = [
  {
    tool: 'page_set_campaign',
    input: {
      name: 'The Salt Road launch',
      goal: '600 preorders by launch day',
      goalMetric: 'preorders',
      goalTarget: 600,
      launchAt: isoDaysAhead(6),
      budget: 2400,
    },
  },
  {
    tool: 'page_add_asset',
    input: {
      title: 'Author Q&A thread',
      channel: 'bluesky',
      goesOutAt: LAST_TUESDAY,
      owner: 'Ines',
      status: 'scheduled',
    },
  },
  {
    tool: 'page_add_asset',
    input: {
      title: 'Preorder ads, round one',
      channel: 'ads',
      goesOutAt: ADS_DAY,
      owner: 'Ines',
      status: 'scheduled',
    },
  },
  {
    tool: 'page_add_asset',
    input: {
      title: 'Bookshop window poster',
      channel: 'print',
      goesOutAt: isoDaysAhead(4),
      owner: 'Theo',
      status: 'approved',
    },
  },
  {
    tool: 'page_log_result',
    input: {
      title: 'Author Q&A thread',
      day: LAST_TUESDAY,
      reach: 3100,
      clicks: 240,
      conversions: 31,
    },
  },
  {
    tool: 'page_log_result',
    input: {
      title: 'Preorder ads, round one',
      day: ADS_DAY,
      reach: 9800,
      clicks: 410,
      conversions: 28,
    },
  },
  {
    tool: 'page_log_spend',
    input: { amount: 600, channel: 'ads', title: 'Preorder ads, round one', day: ADS_DAY },
  },
];

const spends = (doc: unknown) =>
  list(doc, 'events').filter((e) => e.kind === 'spend') as Array<{
    data?: { amountCents?: unknown; channel?: unknown };
  }>;

const cases: ParityCase[] = [
  {
    id: 'campaign-room-spent',
    typeId: 'campaign-room',
    params: { business: 'a small press in Portland', campaign: 'our autumn novel' },
    prepare: CAMPAIGN,
    message: 'We spent $250 on another round of preorder ads',
    reads: ['results.json'],
    check: (docs, before) => {
      const added = spends(docs['results.json']).length - spends(before['results.json']).length;
      const logged = spends(docs['results.json']).find((e) => e.data?.amountCents === 25_000);
      if (!logged) return { ok: false, detail: `no $250.00 spend; ${added} new spend events` };
      return added === 1
        ? { ok: true, detail: `$250.00 logged on ${String(logged.data?.channel)}` }
        : { ok: false, detail: `${added} new spend events for one $250 spend` };
    },
  },
  {
    id: 'campaign-room-tuesday',
    typeId: 'campaign-room',
    params: { business: 'a small press in Portland', campaign: 'our autumn novel' },
    prepare: CAMPAIGN,
    message: 'How did Tuesday do?',
    reads: [],
    check: () => ({ ok: true, detail: 'a question changes no file' }),
    reply: (text) => {
      const preorders = /\b31\b/.test(text);
      const evidence = /3,?100|\b240\b|Q&A|thread/i.test(text);
      return preorders && evidence
        ? { ok: true, detail: "quoted Tuesday's 31 preorders from the Q&A thread" }
        : { ok: false, detail: `preorders31=${preorders} reachClicksOrAsset=${evidence}` };
    },
  },
];

export default cases;
