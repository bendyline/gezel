import { isoDaysAhead, records } from '../app-parity-helpers.ts';
import type { ParityCase } from '../app-parity.ts';

// Tomorrow's shifts are covered; the day after, the barista open needs one more.
// Cleo is unavailable that weekday and Eli closes the night before (the 10-hour
// rest rule), so the roster's rules leave Ben as the one person who fits.
const DAY1 = isoDaysAhead(1);
const GAP_DAY = isoDaysAhead(2);
const GAP_WEEKDAY = new Date(`${GAP_DAY}T12:00:00`).toLocaleDateString('en-US', {
  weekday: 'long',
});

const ROSTER = [
  { tool: 'page_add_staff', input: { name: 'Ana', roles: 'barista, kitchen' } },
  { tool: 'page_add_staff', input: { name: 'Ben', roles: 'barista', maxHours: 20 } },
  { tool: 'page_add_staff', input: { name: 'Cleo', roles: 'barista' } },
  { tool: 'page_add_staff', input: { name: 'Dev', roles: 'kitchen' } },
  { tool: 'page_add_staff', input: { name: 'Eli', roles: 'barista' } },
  { tool: 'page_set_rules', input: { maxWeekHours: 40, minRestHours: 10 } },
  {
    tool: 'page_set_availability',
    input: { staff: 'Cleo', day: GAP_WEEKDAY.toLowerCase(), part: 'all day' },
  },
  {
    tool: 'page_add_shift',
    input: { date: DAY1, start: '06:00', end: '14:00', role: 'barista', needed: 2 },
  },
  {
    tool: 'page_add_shift',
    input: { date: DAY1, start: '14:00', end: '21:00', role: 'barista', needed: 1 },
  },
  {
    tool: 'page_add_shift',
    input: { date: GAP_DAY, start: '06:00', end: '14:00', role: 'barista', needed: 2 },
  },
  {
    tool: 'page_add_shift',
    input: { date: GAP_DAY, start: '07:00', end: '15:00', role: 'kitchen', needed: 1 },
  },
  { tool: 'page_assign_shift', input: { id: 'sh-1', staff: 'Ana' } },
  { tool: 'page_assign_shift', input: { id: 'sh-1', staff: 'Cleo' } },
  { tool: 'page_assign_shift', input: { id: 'sh-2', staff: 'Eli' } },
  { tool: 'page_assign_shift', input: { id: 'sh-3', staff: 'Ana' } },
  { tool: 'page_assign_shift', input: { id: 'sh-4', staff: 'Dev' } },
];

const isGapShift = (r: { fields?: Record<string, unknown> }) =>
  r.fields?.date === GAP_DAY && r.fields?.start === '06:00' && r.fields?.role === 'barista';

const cases: ParityCase[] = [
  {
    id: 'shift-roster-fill-open',
    typeId: 'shift-roster',
    params: { business: 'a café with 12 staff' },
    prepare: ROSTER,
    message: `Fill the open barista shift on ${GAP_WEEKDAY}`,
    reads: ['shifts.json', 'staff.json'],
    check: (docs) => {
      const gap = records(docs['shifts.json']).filter(isGapShift);
      if (gap.length !== 1)
        return { ok: false, detail: `${gap.length} ${GAP_DAY} 06:00 barista shifts` };
      const on = Array.isArray(gap[0]!.fields?.staff) ? (gap[0]!.fields?.staff as string[]) : [];
      const names = on.map(
        (id) => records(docs['staff.json']).find((p) => p.id === id)?.fields?.name ?? id,
      );
      if (on.length !== 2)
        return { ok: false, detail: `the open shift has ${on.length} of 2: ${names.join(', ')}` };
      return names.includes('Cleo')
        ? { ok: false, detail: `put Cleo on a day she is unavailable: ${names.join(', ')}` }
        : { ok: true, detail: `covered by ${names.join(' and ')}` };
    },
  },
  {
    id: 'shift-roster-whats-open',
    typeId: 'shift-roster',
    params: { business: 'a café with 12 staff' },
    prepare: ROSTER,
    message: 'Which shifts still need someone?',
    reads: [],
    check: () => ({ ok: true, detail: 'a question changes no file' }),
    reply: (text) => {
      const barista = /barista/i.test(text);
      const day =
        new RegExp(GAP_WEEKDAY.slice(0, 3), 'i').test(text) ||
        text.includes(GAP_DAY) ||
        text.includes(GAP_DAY.slice(5));
      const strayKitchen =
        /kitchen (shift )?(is |still )?(open|short|unfilled|uncovered|needs someone)/i.test(text);
      return barista && day && !strayKitchen
        ? { ok: true, detail: `named the ${GAP_WEEKDAY} barista open` }
        : { ok: false, detail: `barista=${barista} day=${day} strayKitchen=${strayKitchen}` };
    },
  },
];

export default cases;
