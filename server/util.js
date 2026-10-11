// Date and validation helpers. Dates are local 'YYYY-MM-DD'; months are 'YYYY-MM'.

const pad = (n) => String(n).padStart(2, '0');

export function ymd(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function today() {
  return ymd(new Date());
}

export function parseYmd(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function addDays(s, days) {
  const d = parseYmd(s);
  d.setDate(d.getDate() + days);
  return ymd(d);
}

export function daysInMonth(y, m /* 1-12 */) {
  return new Date(y, m, 0).getDate();
}

// Add months keeping the anchor day (clamped to the month's last day): Jan 31 -> Feb 28 -> Mar 31.
export function addMonths(s, months, anchorDay) {
  const [y, m, d] = s.split('-').map(Number);
  const idx = (m - 1) + months;
  const ny = y + Math.floor(idx / 12);
  const nm = ((idx % 12) + 12) % 12 + 1;
  const day = Math.min(anchorDay || d, daysInMonth(ny, nm));
  return `${ny}-${pad(nm)}-${pad(day)}`;
}

export const FREQ_MONTHS = { monthly: 1, quarterly: 3, semiannual: 6, yearly: 12 };
export const FREQ_PER_YEAR = { weekly: 52, biweekly: 26, monthly: 12, quarterly: 4, semiannual: 2, yearly: 1 };

export function advanceDate(s, frequency, anchorDay) {
  if (frequency === 'weekly') return addDays(s, 7);
  if (frequency === 'biweekly') return addDays(s, 14);
  return addMonths(s, FREQ_MONTHS[frequency] || 1, anchorDay);
}

export function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  return { start: `${month}-01`, end: `${month}-${pad(daysInMonth(y, m))}`, days: daysInMonth(y, m) };
}

export function shiftMonth(month, delta) {
  return addMonths(`${month}-01`, delta).slice(0, 7);
}

// `count` months ending at `month` (inclusive), oldest first.
export function monthsBack(month, count) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) out.push(shiftMonth(month, -i));
  return out;
}

export function currentMonth() {
  return today().slice(0, 7);
}

// ---- validation ----
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && ymd(parseYmd(s)) === s;
export const isMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

export function reqDate(v, field = 'date') {
  if (!isDate(v)) throw new HttpError(400, `${field} must be a valid date (YYYY-MM-DD)`);
  return v;
}

export function optDate(v, field = 'date') {
  if (v === null || v === undefined || v === '') return null;
  return reqDate(v, field);
}

export function reqMonth(v) {
  if (!isMonth(v)) throw new HttpError(400, 'month must be YYYY-MM');
  return v;
}

export function cents(v, field = 'amount', { allowNegative = false } = {}) {
  const n = Number(v);
  if (v === '' || v === null || !Number.isFinite(n) || !Number.isInteger(n)) throw new HttpError(400, `${field} must be a valid amount`);
  if (!allowNegative && n < 0) throw new HttpError(400, `${field} cannot be negative`);
  if (Math.abs(n) > 1e13) throw new HttpError(400, `${field} is too large`);
  return n;
}

export function num(v, field, { min = -Infinity, max = Infinity } = {}) {
  const n = Number(v);
  if (v === '' || v === null || !Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${field} is invalid`);
  return n;
}

export function str(v, field, { max = 500, required = false } = {}) {
  const s = v === undefined || v === null ? '' : String(v).trim();
  if (required && !s) throw new HttpError(400, `${field} is required`);
  if (s.length > max) throw new HttpError(400, `${field} is too long`);
  return s;
}

export function oneOf(v, field, options) {
  if (!options.includes(v)) throw new HttpError(400, `${field} must be one of: ${options.join(', ')}`);
  return v;
}

export const bool = (v) => (v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0);
