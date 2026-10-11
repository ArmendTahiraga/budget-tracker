// Recurring bills, subscriptions and income (e.g. salary).
import { advanceDate, today, FREQ_PER_YEAR, addDays } from './util.js';
import { inTx } from './db.js';

const MAX_CATCHUP = 400; // guard against runaway loops (e.g. weekly item with a very old start date)

export function postOccurrence(db, item, date, amountCents = item.amount_cents) {
  const r = db.prepare(`INSERT INTO transactions (date, type, amount_cents, category_id, description, source, recurring_id)
                        VALUES (?, ?, ?, ?, ?, 'recurring', ?)`)
    .run(date, item.type, amountCents, item.category_id, item.name, item.id);
  return Number(r.lastInsertRowid);
}

export function advanceItem(db, item) {
  const next = advanceDate(item.next_due, item.frequency, item.anchor_day);
  db.prepare('UPDATE recurring SET next_due = ? WHERE id = ?').run(next, item.id);
  return next;
}

// Auto-post every autopay item whose due date has arrived. Returns number of transactions created.
export function processDue(db, asOf = today()) {
  const items = db.prepare('SELECT * FROM recurring WHERE active = 1 AND autopay = 1 AND next_due <= ?').all(asOf);
  if (!items.length) return 0;
  let created = 0;
  inTx(db, () => {
    for (const item of items) {
      let due = item.next_due;
      let guard = 0;
      while (due <= asOf && guard++ < MAX_CATCHUP) {
        postOccurrence(db, item, due);
        created++;
        due = advanceDate(due, item.frequency, item.anchor_day);
      }
      db.prepare('UPDATE recurring SET next_due = ? WHERE id = ?').run(due, item.id);
    }
  });
  return created;
}

export function monthlyEquivalent(item) {
  return Math.round((item.amount_cents * (FREQ_PER_YEAR[item.frequency] || 12)) / 12);
}

// Occurrences up to `days` ahead; overdue manual items are included and flagged.
export function upcoming(db, days = 30, from = today()) {
  const until = addDays(from, days);
  const items = db.prepare(`SELECT r.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color
                            FROM recurring r LEFT JOIN categories c ON c.id = r.category_id
                            WHERE r.active = 1 AND r.next_due <= ?`).all(until);
  const out = [];
  for (const item of items) {
    let due = item.next_due;
    let first = true;
    let guard = 0;
    while (due <= until && guard++ < 60) {
      out.push({
        recurring_id: item.id,
        name: item.name,
        type: item.type,
        amount_cents: item.amount_cents,
        date: due,
        overdue: due < from,
        is_next: first,
        autopay: item.autopay,
        subscription: item.subscription,
        icon: item.icon || item.category_icon || '',
        color: item.category_color || '#7c5cff',
        category_name: item.category_name,
      });
      first = false;
      due = advanceDate(due, item.frequency, item.anchor_day);
    }
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  return out;
}
