/**
 * Minimal 5-field cron parser (minute hour dayOfMonth month dayOfWeek).
 * Supports:
 *   - `*` wildcard
 *   - comma lists: `1,15,30`
 *   - ranges: `9-17`
 *   - steps: `*`/`5` or `0-30/5`
 *   - numeric day-of-week 0 (Sunday) – 6; we also accept 7 as Sunday.
 *
 * Does not support named months/days (JAN, MON) — we don't need them for the
 * scheduler and the simpler surface keeps the parser small. If someone types
 * a bad expression we throw and the scheduler logs + skips the task.
 */

interface Field {
  min: number;
  max: number;
  allowed: Set<number>;
}

interface Schedule {
  minute: Field;
  hour: Field;
  dayOfMonth: Field;
  month: Field;
  dayOfWeek: Field;
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

const BOUNDS: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week (0 = Sun)
];

function parseField(raw: string, min: number, max: number): Field {
  const allowed = new Set<number>();
  for (const piece of raw.split(',')) {
    const [rangePart, stepPart] = piece.split('/');
    const step = stepPart ? Number.parseInt(stepPart, 10) : 1;
    if (!Number.isFinite(step) || step < 1) {
      throw new Error(`cron: invalid step "${piece}"`);
    }
    let start = min;
    let end = max;
    if (rangePart !== '*' && rangePart !== undefined) {
      if (rangePart.includes('-')) {
        const [a, b] = rangePart.split('-');
        start = Number.parseInt(a!, 10);
        end = Number.parseInt(b!, 10);
      } else {
        start = Number.parseInt(rangePart, 10);
        end = stepPart ? max : start;
      }
    }
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < min ||
      end > max ||
      start > end
    ) {
      throw new Error(`cron: out-of-range "${piece}" (bounds ${min}-${max})`);
    }
    for (let v = start; v <= end; v += step) allowed.add(v);
  }
  return { min, max, allowed };
}

export function parseCron(expression: string): Schedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron: expected 5 fields, got ${fields.length} ("${expression}")`);
  }
  const parsed = fields.map((f, i) => parseField(f, BOUNDS[i]![0], BOUNDS[i]![1]));
  // Treat `7` as `0` for day-of-week.
  if (parsed[4]!.allowed.has(7)) {
    parsed[4]!.allowed.delete(7);
    parsed[4]!.allowed.add(0);
  }
  return {
    minute: parsed[0]!,
    hour: parsed[1]!,
    dayOfMonth: parsed[2]!,
    month: parsed[3]!,
    dayOfWeek: parsed[4]!,
    dayOfMonthRestricted: fields[2] !== '*',
    dayOfWeekRestricted: fields[4] !== '*',
  };
}

/**
 * Return the next Date strictly after `from` that matches the schedule. Caps
 * at ~4 years of lookahead so a malformed schedule can't wedge the loop.
 */
/**
 * Interpreted in UTC so schedules are stable across machines and DST
 * transitions. If you want "9am local", translate on the way in.
 */
export function nextCronFire(schedule: Schedule, from: Date): Date {
  const limit = 60 * 24 * 366 * 4;
  const next = new Date(from.getTime());
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(next.getUTCMinutes() + 1);
  for (let i = 0; i < limit; i++) {
    const month = next.getUTCMonth() + 1;
    const dayOfMonth = next.getUTCDate();
    const dayOfWeek = next.getUTCDay();
    const hour = next.getUTCHours();
    const minute = next.getUTCMinutes();
    if (!schedule.month.allowed.has(month)) {
      next.setUTCMonth(next.getUTCMonth() + 1, 1);
      next.setUTCHours(0, 0, 0, 0);
      continue;
    }
    const domOk = schedule.dayOfMonth.allowed.has(dayOfMonth);
    const dowOk = schedule.dayOfWeek.allowed.has(dayOfWeek);
    let dayOk = true;
    if (schedule.dayOfMonthRestricted && schedule.dayOfWeekRestricted) {
      dayOk = domOk || dowOk;
    } else if (schedule.dayOfMonthRestricted) {
      dayOk = domOk;
    } else if (schedule.dayOfWeekRestricted) {
      dayOk = dowOk;
    }
    if (!dayOk) {
      next.setUTCDate(dayOfMonth + 1);
      next.setUTCHours(0, 0, 0, 0);
      continue;
    }
    if (!schedule.hour.allowed.has(hour)) {
      next.setUTCHours(hour + 1, 0, 0, 0);
      continue;
    }
    if (!schedule.minute.allowed.has(minute)) {
      next.setUTCMinutes(minute + 1, 0, 0);
      continue;
    }
    return next;
  }
  throw new Error('cron: could not find next fire within lookahead window');
}
