// A minimal standard 5-field cron parser: "minute hour day-of-month month day-of-week".
// Supports `*`, single numbers, comma lists (`1,15`), ranges (`1-5`), and steps
// (`*/2`, `0-30/10`). Month (1-12) and day-of-week (0-6, Sunday=0) also accept the
// usual three-letter names (jan…dec, sun…sat). Kept dependency-free on purpose.

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>; // day of month
  month: Set<number>;
  dow: Set<number>; // day of week, 0=Sun
  domRestricted: boolean; // field was not "*"
  dowRestricted: boolean;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function nameToNum(token: string, names: string[]): string {
  const i = names.indexOf(token.toLowerCase());
  return i >= 0 ? String(i + (names === MONTHS ? 1 : 0)) : token;
}

// Expand one field into the set of matching integers, validating against [min,max].
function parseField(field: string, min: number, max: number, names?: string[]): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid step in "${part}"`);

    let lo: number;
    let hi: number;
    if (rangePart === "*") {
      lo = min;
      hi = max;
    } else {
      const bounds = rangePart.split("-").map((t) => (names ? nameToNum(t, names) : t));
      lo = Number(bounds[0]);
      hi = bounds.length > 1 ? Number(bounds[1]) : lo;
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) throw new Error(`invalid range "${rangePart}"`);
      // Allow Sunday as both 0 and 7 for day-of-week.
      if (max === 6) {
        if (lo === 7) lo = 0;
        if (hi === 7) hi = 0;
      }
      if (lo < min || hi > max || lo > hi) throw new Error(`out-of-range field "${rangePart}"`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  if (out.size === 0) throw new Error(`empty field "${field}"`);
  return out;
}

export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron expression must have 5 fields (got ${parts.length}): "${expr}"`);
  }
  const [minute, hour, dom, month, dow] = parts;
  return {
    minute: parseField(minute, 0, 59),
    hour: parseField(hour, 0, 23),
    dom: parseField(dom, 1, 31),
    month: parseField(month, 1, 12, MONTHS),
    dow: parseField(dow, 0, 6, DAYS),
    domRestricted: dom !== "*",
    dowRestricted: dow !== "*",
  };
}

// Validate an expression, returning an error message or null if it parses.
export function cronError(expr: string): string | null {
  try {
    parseCron(expr);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function matches(f: CronFields, d: Date): boolean {
  if (!f.minute.has(d.getMinutes())) return false;
  if (!f.hour.has(d.getHours())) return false;
  if (!f.month.has(d.getMonth() + 1)) return false;
  // Standard cron: when BOTH day-of-month and day-of-week are restricted, a match
  // on EITHER is sufficient. When only one is restricted, it alone must match.
  const domOk = f.dom.has(d.getDate());
  const dowOk = f.dow.has(d.getDay());
  if (f.domRestricted && f.dowRestricted) return domOk || dowOk;
  if (f.domRestricted) return domOk;
  if (f.dowRestricted) return dowOk;
  return true;
}

// The next fire time strictly after `from` (local time), or null if none within a
// ~4-year horizon (e.g. Feb 30). Seconds/millis are cleared; we scan minute by minute.
export function nextRun(expr: string, from: Date = new Date()): Date | null {
  const fields = parseCron(expr);
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // strictly after `from`
  const limit = 366 * 4 * 24 * 60; // minutes in ~4 years
  for (let i = 0; i < limit; i++) {
    if (matches(fields, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}
