/**
 * "Is it open now?" for the common forms of OpenStreetMap's `opening_hours`.
 *
 * The full specification is a language — months, week numbers, sunrise
 * offsets, school holidays, comments — and a partial implementation that
 * guesses at the rest would answer "open" for a restaurant that is shut. So
 * this parses the forms that cover most tagged places and returns `null` for
 * anything else. `null` is an honest answer the widget shows as "hours
 * unknown"; a confident wrong one is not.
 *
 * Understood:
 *   24/7
 *   10:00-23:00                       (every day)
 *   Mo-Fr 09:00-17:00; Sa 10:00-14:00 (later rules override earlier ones for their days)
 *   Mo-Th 11:00-23:00; Fr-Su 11:00-01:00   (past midnight)
 *   Mo-Fr 08:00-12:00,13:00-17:00     (split shifts)
 *   Su off / Su closed
 *   Sa-Mo …                           (ranges that wrap the week)
 *   PH off                            (public-holiday rules are skipped — we cannot know the calendar)
 *
 * @module tools/opening-hours
 */

const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as const;
const DAY = '(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)';
const DAY_SELECTOR = new RegExp(`^(${DAY}(?:-${DAY})?(?:\\s*,\\s*${DAY}(?:-${DAY})?)*)(?:\\s+|$)`);
const TIME_RANGE = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/;

/** Minutes-from-midnight intervals per weekday, Monday first. End may exceed 1440 (past midnight). */
export type WeekSchedule = Array<Array<[number, number]>>;

/** Parse a tag value, or `null` when it uses a form this does not understand. */
export function parseOpeningHours(spec: string | undefined | null): WeekSchedule | null {
  if (!spec) return null;
  const text = spec.trim();
  if (!text) return null;
  const week: WeekSchedule = DAYS.map(() => []);
  const set = new Array<boolean>(7).fill(false);

  const rules = text.split(/\s*(?:;|\|\|)\s*/).filter(Boolean);
  for (const raw of rules) {
    let rule = raw.trim();
    let days: number[] | 'all' = 'all';

    const selector = DAY_SELECTOR.exec(rule);
    if (selector) {
      const parts = selector[1]!.split(/\s*,\s*/);
      const picked: number[] = [];
      let holidayOnly = true;
      for (const part of parts) {
        if (/^(PH|SH)$/.test(part)) continue;
        holidayOnly = false;
        const [from, to] = part.split('-') as [string, string | undefined];
        const a = DAYS.indexOf(from as typeof DAYS[number]);
        const b = to === undefined ? a : DAYS.indexOf(to as typeof DAYS[number]);
        if (a < 0 || b < 0) return null;
        for (let d = a; ; d = (d + 1) % 7) {
          picked.push(d);
          if (d === b) break;
        }
      }
      // A rule about holidays alone says nothing about an ordinary day.
      if (holidayOnly) continue;
      days = picked;
      rule = rule.slice(selector[0].length).trim();
    }

    let intervals: Array<[number, number]>;
    if (rule === '') {
      // "Mo-Fr" with no times means open all day on those days.
      intervals = [[0, 1440]];
    } else if (/^(off|closed)$/i.test(rule)) {
      intervals = [];
    } else if (rule === '24/7' || rule === '00:00-24:00') {
      intervals = [[0, 1440]];
    } else {
      intervals = [];
      for (const piece of rule.split(/\s*,\s*/)) {
        const m = TIME_RANGE.exec(piece);
        if (!m) return null;
        const start = Number(m[1]) * 60 + Number(m[2]);
        let end = Number(m[3]) * 60 + Number(m[4]);
        if (start > 1440 || end > 1440 + 12 * 60 || Number(m[2]) > 59 || Number(m[4]) > 59) return null;
        // Ending at or before it starts means it runs past midnight.
        if (end <= start) end += 1440;
        intervals.push([start, end]);
      }
    }

    for (const d of days === 'all' ? [0, 1, 2, 3, 4, 5, 6] : days) {
      week[d] = intervals.map(i => [i[0], i[1]] as [number, number]);
      set[d] = true;
    }
  }
  // Nothing understood at all is not "closed every day".
  if (!set.some(Boolean)) return null;
  return week;
}

/**
 * Whether a schedule has the place open at a local weekday and minute.
 *
 * @param day Monday = 0 … Sunday = 6.
 */
export function isOpenAt(week: WeekSchedule, day: number, minute: number): boolean {
  for (const [start, end] of week[day] ?? []) {
    if (minute >= start && minute < end) return true;
  }
  // Yesterday's late shift, still running.
  const yesterday = (day + 6) % 7;
  for (const [, end] of week[yesterday] ?? []) {
    if (end > 1440 && minute < end - 1440) return true;
  }
  return false;
}

/**
 * Open right now, at a place whose clock is `utcOffsetSeconds` from UTC.
 *
 * `null` when the hours are missing or in a form this does not read — never a
 * guess.
 */
export function openNow(spec: string | undefined | null, utcOffsetSeconds: number, nowMs = Date.now()): boolean | null {
  const week = parseOpeningHours(spec);
  if (!week) return null;
  const local = new Date(nowMs + utcOffsetSeconds * 1000);
  const day = (local.getUTCDay() + 6) % 7;
  return isOpenAt(week, day, local.getUTCHours() * 60 + local.getUTCMinutes());
}
