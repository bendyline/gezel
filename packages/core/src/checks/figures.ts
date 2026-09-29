import { normalizeInlineEmphasis } from './grounding.js';

/**
 * Figure checks: the numbers an owner would send to a customer.
 *
 * A review run's catering quote said $297.00 for items that add up to
 * $197.00, called Saturday October 10 a Friday, and priced a fruit platter the
 * owner never priced. Nothing looked at the numbers before the owner did.
 * These checks need no spec: subtotals against their items, quantity × unit
 * price, weekday against date, dates that have clearly passed, and, when the
 * caller supplies what the owner said, prices that came from nowhere.
 *
 * Deliberately conservative. A false alarm on an owner's review card costs
 * more trust than it buys, so anything ambiguous (a per-unit price with no
 * line total, a total line quoting several options) is skipped, not guessed.
 */

export type FigureFindingKind = 'sum' | 'line-math' | 'weekday' | 'stale-date' | 'unsourced-price';

export interface FigureFinding {
  kind: FigureFindingKind;
  /** 1-based line in the checked text. */
  line: number;
  /** One owner-facing sentence. */
  message: string;
  /** For `unsourced-price`: the item and its price, for a caller that groups them. */
  item?: string;
  amount?: string;
}

export interface FigureCheckResult {
  findings: FigureFinding[];
  /** How much was actually checked, so a caller can say "the sums add up" honestly. */
  checked: { sums: number; lineMath: number; dates: number; prices: number };
}

export interface FigureCheckOptions {
  /** Today as YYYY-MM-DD, in the owner's time zone. */
  today: string;
  /** Amounts the owner supplied. Without any, prices are not checked for provenance. */
  knownAmounts?: readonly number[];
}

interface Money {
  value: number;
  symbol: string;
  index: number;
  end: number;
}

const MONEY_RE = /([-−]\s?)?([$€£])\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?(?![\d.,]*\d)/g;

function parseMoney(text: string): Money[] {
  const out: Money[] = [];
  for (const m of text.matchAll(MONEY_RE)) {
    const whole = Number(m[3]!.replace(/,/g, ''));
    const cents = m[4] ? Number(m[4].padEnd(2, '0')) / 100 : 0;
    const value = (whole + cents) * (m[1] ? -1 : 1);
    out.push({ value, symbol: m[2]!, index: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Every currency amount in some text: the "known" side of a price check. */
export function extractMoneyAmounts(text: string): number[] {
  return parseMoney(normalizeInlineEmphasis(text)).map((m) => Math.abs(m.value));
}

const same = (a: number, b: number): boolean => Math.abs(a - b) < 0.005;

function fmt(value: number, symbol: string): string {
  const abs = Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${value < 0 ? '-' : ''}${symbol}${abs}`;
}

const TOTAL_RE =
  /\b(sub-?\s?total|grand\s+total|total|amount\s+due|balance\s+due|totaal|subtotaal)\b/i;
const SUBTOTAL_RE = /\bsub-?\s?total|\bsubtotaal/i;
const DISCOUNT_RE = /\b(discount|korting|credit|coupon|less|deposit\s+paid|paid)\b/i;
const TAX_RE = /\b(tax|vat|gst|hst|btw|sales\s+tax)\b/i;
const PER_UNIT_RE = /\b(each|apiece|per|pp)\b|\/\s?(ea|each|person|head|dozen|hour|hr|unit)\b/i;
const UNIT_COLUMN_RE = /\b(unit|each|per|rate)\b/i;
const TOTAL_COLUMN_RE = /\b(total|subtotal|amount|line|sum)\b/i;
const QTY_CELL_RE = /^\d+(?:\.\d+)?$/;
const MONEY_SRC = '([$€£])\\s?(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.(\\d{1,2}))?';
const QTY_TIMES_RE = new RegExp(
  `(\\d+(?:\\.\\d+)?)\\s*(?:×|x|\\*|@)\\s*${MONEY_SRC}\\s*(?:=|→|->)\\s*${MONEY_SRC}`,
  'i',
);
const TIMES_QTY_RE = new RegExp(
  `${MONEY_SRC}\\s*(?:×|x|\\*)\\s*(\\d+(?:\\.\\d+)?)\\s*(?:=|→|->)\\s*${MONEY_SRC}`,
  'i',
);

function moneyFrom(groups: string[], at: number): number {
  const whole = Number(groups[at + 1]!.replace(/,/g, ''));
  const cents = groups[at + 2] ? Number(groups[at + 2]!.padEnd(2, '0')) / 100 : 0;
  return whole + cents;
}

function cleanLabel(text: string): string {
  return text
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/[(\s:—–-]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Line {
  no: number;
  label: string;
  amounts: Money[];
  /** The value this line contributes to a sum; null when it can't be known. */
  value: number | null;
  total: 'subtotal' | 'total' | null;
  discount: boolean;
  /** The price the line is built from, for the provenance check. */
  unit: Money | null;
}

function splitCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function analyzeTableRow(
  no: number,
  cells: string[],
  header: string[] | null,
  findings: FigureFinding[],
  checked: FigureCheckResult['checked'],
): Line {
  const label = cleanLabel(cells[0] ?? '');
  const moneyCells: Array<{ col: number; money: Money }> = [];
  let qty: number | null = null;
  cells.forEach((cell, col) => {
    const money = parseMoney(cell);
    if (money.length === 1) moneyCells.push({ col, money: money[0]! });
    else if (col > 0 && qty === null && QTY_CELL_RE.test(cell)) qty = Number(cell);
  });
  const total = TOTAL_RE.test(label) ? (SUBTOTAL_RE.test(label) ? 'subtotal' : 'total') : null;
  const discount = DISCOUNT_RE.test(label);
  const amounts = moneyCells.map((c) => c.money);
  if (amounts.length === 0) {
    return { no, label, amounts, value: null, total, discount, unit: null };
  }
  const last = amounts[amounts.length - 1]!;
  if (moneyCells.length >= 2 && qty !== null) {
    const unit = amounts[0]!;
    checked.lineMath++;
    const expected = Math.round(qty * unit.value * 100) / 100;
    if (!same(expected, last.value)) {
      findings.push({
        kind: 'line-math',
        line: no,
        message: `${label}: ${qty} × ${fmt(unit.value, unit.symbol)} is ${fmt(expected, unit.symbol)}, not ${fmt(last.value, last.symbol)}.`,
      });
    }
    return { no, label, amounts, value: last.value, total, discount, unit };
  }
  if (moneyCells.length === 1 && qty !== null && !total) {
    const heading = header?.[moneyCells[0]!.col] ?? '';
    const isUnit = UNIT_COLUMN_RE.test(heading) && !TOTAL_COLUMN_RE.test(heading);
    const isLine = TOTAL_COLUMN_RE.test(heading);
    const value = isUnit ? Math.round(qty * last.value * 100) / 100 : isLine ? last.value : null;
    return { no, label, amounts, value, total, discount, unit: isUnit ? last : null };
  }
  return {
    no,
    label,
    amounts,
    value: last.value,
    total,
    discount,
    unit: total ? null : amounts[0]!,
  };
}

function analyzeTextLine(
  no: number,
  text: string,
  findings: FigureFinding[],
  checked: FigureCheckResult['checked'],
): Line {
  const amounts = parseMoney(text);
  const label = cleanLabel(amounts.length > 0 ? text.slice(0, amounts[0]!.index) : text);
  const total = TOTAL_RE.test(label) ? (SUBTOTAL_RE.test(label) ? 'subtotal' : 'total') : null;
  const discount = DISCOUNT_RE.test(label);
  if (amounts.length === 0) return { no, label, amounts, value: null, total, discount, unit: null };

  // Groups: forward is qty, unit (symbol, whole, cents), line; backward is
  // unit, qty, line. `moneyFrom(groups, at)` reads the symbol at `at`.
  const forward = QTY_TIMES_RE.exec(text);
  const backward = forward ? null : TIMES_QTY_RE.exec(text);
  const math = forward ?? backward;
  if (math) {
    const groups = [...math];
    const qty = Number(forward ? groups[1] : groups[4]);
    const unitValue = moneyFrom(groups, forward ? 2 : 1);
    const lineValue = moneyFrom(groups, 5);
    const symbol = forward ? groups[2]! : groups[1]!;
    const mathLabel = cleanLabel(text.slice(0, math.index)) || label || 'A line';
    checked.lineMath++;
    const expected = Math.round(qty * unitValue * 100) / 100;
    if (!same(expected, lineValue)) {
      findings.push({
        kind: 'line-math',
        line: no,
        message: `${mathLabel}: ${qty} × ${fmt(unitValue, symbol)} is ${fmt(expected, symbol)}, not ${fmt(lineValue, symbol)}.`,
      });
    }
    const unit = amounts.find((m) => same(m.value, unitValue)) ?? amounts[0]!;
    return { no, label: mathLabel, amounts, value: lineValue, total, discount, unit };
  }
  if (amounts.length > 1) {
    // "Total: $175 (Option 1) or $297 (Option 2)" quotes several figures;
    // no single value to add up.
    return { no, label, amounts, value: null, total: null, discount, unit: null };
  }
  const only = amounts[0]!;
  if (!total && PER_UNIT_RE.test(text)) {
    return { no, label, amounts, value: null, total, discount, unit: only };
  }
  return { no, label, amounts, value: only.value, total, discount, unit: total ? null : only };
}

interface RunItem {
  value: number | null;
  discount: boolean;
}

/** Sums the stated total may mean: the whole run, or a tail after a break. */
function candidateSums(run: RunItem[], breaks: number[]): number[] | null {
  const starts = [0, ...breaks.filter((b) => b > 0 && b < run.length)];
  const sums: number[] = [];
  for (const start of starts) {
    const slice = run.slice(start);
    if (slice.length === 0) continue;
    if (slice.some((item) => item.value === null)) continue;
    const discounts = slice.filter((item) => item.discount && (item.value ?? 0) > 0);
    const base = slice.reduce((acc, item) => acc + (item.value ?? 0), 0);
    sums.push(base);
    // A positive discount line is usually subtracted, not added.
    const off = discounts.reduce((acc, item) => acc + (item.value ?? 0), 0);
    if (off > 0) sums.push(base - 2 * off);
  }
  return sums.length > 0 ? sums : null;
}

const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};
const WEEKDAYS: Record<string, number> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};
const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAY_SRC =
  '(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sun|Mon|Tues|Tue|Wed|Thurs|Thur|Thu|Fri|Sat)\\.?,?\\s+';
const MONTH_SRC =
  '(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec)\\.?';
const US_DATE_RE = new RegExp(
  `\\b(?:${WEEKDAY_SRC})?${MONTH_SRC}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`,
  'gi',
);
const EU_DATE_RE = new RegExp(
  `\\b(?:${WEEKDAY_SRC})?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_SRC}\\b(?:,?\\s+(\\d{4}))?`,
  'gi',
);
const ISO_DATE_RE = new RegExp(`\\b(?:${WEEKDAY_SRC})?(\\d{4})-(\\d{2})-(\\d{2})\\b`, 'gi');
const FUTURE_RE =
  /\b(due|by|deadline|confirm|deliver(?:y|ed)?|event|scheduled?|until|expires?|valid|starting|order|pick-?up|week of)\b/i;
/** A line about the past ("since", "founded") may carry any old date. */
const PAST_RE = /\b(since|founded|established|est\.|opened|born|history|ago|last year|back in)\b/i;
/** Past this, a dated line is stale whatever it says. */
const STALE_DAYS = 180;

function utcDay(year: number, month: number, day: number): number | null {
  const at = Date.UTC(year, month - 1, day);
  const d = new Date(at);
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return at;
}

interface DateHit {
  raw: string;
  weekday: number | null;
  month: number;
  day: number;
  year: number | null;
}

function dateHits(text: string): DateHit[] {
  const hits: DateHit[] = [];
  const seen = new Set<number>();
  const weekdayOf = (w: string | undefined) =>
    w ? (WEEKDAYS[w.toLowerCase().replace(/\.$/, '')] ?? null) : null;
  for (const m of text.matchAll(US_DATE_RE)) {
    seen.add(m.index);
    hits.push({
      raw: m[0],
      weekday: weekdayOf(m[1]),
      month: MONTHS[m[2]!.toLowerCase()]!,
      day: Number(m[3]),
      year: m[4] ? Number(m[4]) : null,
    });
  }
  for (const m of text.matchAll(EU_DATE_RE)) {
    if (seen.has(m.index)) continue;
    hits.push({
      raw: m[0],
      weekday: weekdayOf(m[1]),
      day: Number(m[2]),
      month: MONTHS[m[3]!.toLowerCase()]!,
      year: m[4] ? Number(m[4]) : null,
    });
  }
  for (const m of text.matchAll(ISO_DATE_RE)) {
    hits.push({
      raw: m[0],
      weekday: weekdayOf(m[1]),
      year: Number(m[2]),
      month: Number(m[3]),
      day: Number(m[4]),
    });
  }
  return hits;
}

function checkDates(
  no: number,
  text: string,
  todayAt: number,
  findings: FigureFinding[],
  checked: FigureCheckResult['checked'],
): void {
  const todayYear = new Date(todayAt).getUTCFullYear();
  for (const hit of dateHits(text)) {
    let at: number | null = null;
    let year = hit.year;
    if (year !== null) {
      at = utcDay(year, hit.month, hit.day);
    } else {
      // No year: the nearest occurrence to today is the one the writer meant.
      let best: { at: number; year: number } | null = null;
      for (const candidate of [todayYear - 1, todayYear, todayYear + 1]) {
        const cAt = utcDay(candidate, hit.month, hit.day);
        if (cAt === null) continue;
        if (!best || Math.abs(cAt - todayAt) < Math.abs(best.at - todayAt)) {
          best = { at: cAt, year: candidate };
        }
      }
      at = best?.at ?? null;
      year = best?.year ?? null;
    }
    if (at === null || year === null) continue;
    checked.dates++;
    const named = `${MONTH_NAMES[hit.month - 1]} ${hit.day}, ${year}`;
    if (hit.weekday !== null) {
      const actual = new Date(at).getUTCDay();
      if (actual !== hit.weekday) {
        findings.push({
          kind: 'weekday',
          line: no,
          message: `${named} is a ${WEEKDAY_NAMES[actual]}, not a ${WEEKDAY_NAMES[hit.weekday]}.`,
        });
      }
    }
    if (hit.year !== null && at < todayAt && !PAST_RE.test(text)) {
      const daysAgo = Math.round((todayAt - at) / 86_400_000);
      if (daysAgo > STALE_DAYS || (daysAgo > 1 && FUTURE_RE.test(text))) {
        findings.push({
          kind: 'stale-date',
          line: no,
          message: `${named} has already passed; check the date.`,
        });
      }
    }
  }
}

/** Check the figures in one text deliverable (markdown or plain text). */
export function checkFigures(text: string, opts: FigureCheckOptions): FigureCheckResult {
  const findings: FigureFinding[] = [];
  const checked = { sums: 0, lineMath: 0, dates: 0, prices: 0 };
  const [ty, tm, td] = opts.today.split('-').map(Number);
  const todayAt = utcDay(ty ?? 1970, tm ?? 1, td ?? 1) ?? 0;
  const known = opts.knownAmounts ?? [];

  const lines: Line[] = [];
  let heading: string | null = null;
  let header: string[] | null = null;
  let run: RunItem[] = [];
  let breaks: number[] = [];
  const statedTotals: number[] = [];
  const reset = () => {
    run = [];
    breaks = [];
  };

  const rawLines = text.split(/\r?\n/);
  for (let i = 0; i < rawLines.length; i++) {
    const no = i + 1;
    const raw = rawLines[i]!;
    const plain = normalizeInlineEmphasis(raw);
    checkDates(no, plain, todayAt, findings, checked);

    const trimmed = plain.trim();
    if (/^#{1,6}\s/.test(trimmed)) {
      heading = trimmed.replace(/^#+\s*/, '').trim();
      header = null;
      reset();
    }
    if (/^([-*_])(\s*\1){2,}\s*$/.test(trimmed)) {
      header = null;
      reset();
      continue;
    }
    if (trimmed.length === 0) continue;

    let line: Line;
    if (trimmed.startsWith('|')) {
      if (/^\|?\s*:?-{2,}/.test(trimmed)) continue;
      const cells = splitCells(trimmed);
      line = analyzeTableRow(no, cells, header, findings, checked);
      if (line.amounts.length === 0 && !header) {
        header = cells;
        breaks.push(run.length);
        continue;
      }
    } else {
      if (header) header = null;
      line = analyzeTextLine(no, trimmed, findings, checked);
    }
    lines.push(line);

    if (line.total && line.value !== null) {
      const stated = line.value;
      statedTotals.push(stated);
      const sums = candidateSums(run, breaks);
      if (sums) {
        checked.sums++;
        if (!sums.some((sum) => same(sum, stated))) {
          const symbol = line.amounts[line.amounts.length - 1]!.symbol;
          const where = heading ? `Under "${heading}", the ` : 'The ';
          findings.push({
            kind: 'sum',
            line: no,
            message: `${where}${line.label.toLowerCase() || 'total'} says ${fmt(stated, symbol)}, but the items above it add up to ${fmt(sums[0]!, symbol)}.`,
          });
        }
      }
      if (line.total === 'subtotal') {
        run = [{ value: stated, discount: false }];
        breaks = [];
      } else {
        reset();
      }
      continue;
    }
    if (line.amounts.length === 0) {
      breaks.push(run.length);
      continue;
    }
    run.push({ value: line.value, discount: line.discount });
  }

  if (known.length > 0) {
    // The unit price is what gets checked; a line total follows from it, and
    // a figure repeating a stated total ("confirm Option 2 at $297") is a
    // reference, not a price.
    for (const line of lines) {
      if (line.total || line.discount || !line.unit || TAX_RE.test(line.label)) continue;
      const price = Math.abs(line.unit.value);
      checked.prices++;
      if (known.some((k) => same(k, price))) continue;
      if (statedTotals.some((t) => same(t, price))) continue;
      const amount = fmt(price, line.unit.symbol);
      const item = line.label || 'A line';
      findings.push({
        kind: 'unsourced-price',
        line: line.no,
        item,
        amount,
        message: `${item} at ${amount}: this price didn't come from you.`,
      });
    }
  }

  findings.sort((a, b) => a.line - b.line);
  return { findings, checked };
}
