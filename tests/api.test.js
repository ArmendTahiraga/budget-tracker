// Backend tests against an in-memory database. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.js';
import { handleApi } from '../server/api.js';
import { addMonths, today, currentMonth, shiftMonth, addDays } from '../server/util.js';
import { processDue } from '../server/recurring.js';

const fresh = () => {
  const db = openDb(':memory:');
  const call = (method, path, body) => {
    const [p, q = ''] = path.split('?');
    return handleApi(db, method, p, Object.fromEntries(new URLSearchParams(q)), body);
  };
  const cat = (name) => db.prepare('SELECT id FROM categories WHERE name = ?').get(name).id;
  return { db, call, cat };
};
const rejects = async (p, re) => assert.rejects(p, (e) => { assert.match(e.message, re); return true; });
const M = currentMonth();
const T = today();
const PREV = shiftMonth(M, -1);

test('date helpers keep the anchor day across short months', () => {
  assert.equal(addMonths('2026-01-31', 1, 31), '2026-02-28');
  assert.equal(addMonths('2026-02-28', 1, 31), '2026-03-31');
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
  assert.equal(addMonths('2026-01-15', -1), '2025-12-15');
});

test('transactions: create, validate, update, delete', async () => {
  const { call, cat } = fresh();
  const t = await call('POST', '/api/transactions', { date: T, type: 'expense', amount_cents: 1249, category_id: cat('Groceries'), description: 'Lidl' });
  assert.equal(t.amount_cents, 1249);
  await rejects(call('POST', '/api/transactions', { date: T, type: 'expense', amount_cents: -5 }), /negative/);
  await rejects(call('POST', '/api/transactions', { date: '2026-02-30', type: 'expense', amount_cents: 5 }), /valid date/);
  await rejects(call('POST', '/api/transactions', { date: T, type: 'expense', amount_cents: 5, category_id: cat('Salary') }), /income category/);
  await call('PUT', `/api/transactions/${t.id}`, { amount_cents: 2000 });
  const list = await call('GET', `/api/transactions?month=${M}`);
  assert.equal(list.total, 1);
  assert.equal(list.expense_cents, 2000);
  await call('DELETE', `/api/transactions/${t.id}`);
  assert.equal((await call('GET', '/api/transactions')).total, 0);
});

test('budget: limits, copy, averages, 50/30/20 and zero-based', async () => {
  const { call, cat } = fresh();
  await call('PUT', '/api/settings', { expected_income_cents: 300000, monthly_invest_plan_cents: 20000 });
  await call('PUT', `/api/budget/${M}/${cat('Groceries')}`, { amount_cents: 30000 });
  await call('PUT', `/api/budget/${M}/${cat('Dining out')}`, { amount_cents: 10000 });
  await call('POST', '/api/transactions', { date: T, type: 'expense', amount_cents: 12000, category_id: cat('Groceries') });
  await call('POST', '/api/transactions', { date: T, type: 'expense', amount_cents: 15000, category_id: cat('Dining out') });
  await call('POST', '/api/transactions', { date: T, type: 'expense', amount_cents: 5000, category_id: cat('Shopping') });
  await call('POST', '/api/goals', { name: 'Trip', target_cents: 100000, monthly_cents: 25000 });

  const b = await call('GET', `/api/budget?month=${M}`);
  assert.equal(b.totals.budget_cents, 40000);
  assert.equal(b.totals.spent_cents, 32000);
  assert.equal(b.totals.remaining_cents, 40000 - 27000); // 18,000 left on groceries minus 5,000 overspent on dining
  assert.equal(b.totals.overspent_cents, 5000);
  assert.equal(b.totals.unbudgeted_spent_cents, 5000);
  assert.equal(b.split.needs.target_cents, 150000);
  assert.equal(b.split.needs.actual_cents, 12000);
  assert.equal(b.split.wants.actual_cents, 20000);
  assert.equal(b.zero.left_to_assign_cents, 300000 - 40000 - 25000 - 20000);

  const next = shiftMonth(M, 1);
  const copied = await call('POST', `/api/budget/${next}/copy-previous`);
  assert.equal(copied.copied, 2);
  const avg = await call('POST', `/api/budget/${next}/from-average`);
  assert.equal(avg.set, 3);
  const nb = await call('GET', `/api/budget?month=${next}`);
  assert.equal(nb.categories.find((c) => c.name === 'Groceries').budget_cents, 4000); // 12,000 / 3 = 4,000 (already a multiple of €5)
  assert.equal(nb.categories.find((c) => c.name === 'Shopping').budget_cents, 2000); // 5,000 / 3 = 1,666.67 -> rounded up to €20
  await rejects(call('PUT', '/api/settings', { split_needs: 60 }), /add up to 100/);
});

test('goals: initial balance does not reduce cash; withdrawals are capped', async () => {
  const { call } = fresh();
  await call('PUT', '/api/settings', { starting_balance_cents: 100000, starting_balance_date: addDays(T, -1) });
  const g = await call('POST', '/api/goals', { name: 'Japan', target_cents: 300000, target_date: `${Number(T.slice(0, 4)) + 1}-${T.slice(5, 7)}-01`, initial_cents: 50000 });
  let nw = await call('GET', '/api/networth');
  assert.equal(nw.cash_cents, 100000);
  assert.equal(nw.goals_cents, 50000);
  await call('POST', `/api/goals/${g.id}/entries`, { amount_cents: 20000, date: T });
  nw = await call('GET', '/api/networth');
  assert.equal(nw.cash_cents, 80000);
  assert.equal(nw.goals_cents, 70000);
  assert.equal(nw.net_worth_cents, 150000);
  await rejects(call('POST', `/api/goals/${g.id}/entries`, { amount_cents: -80000, date: T }), /more than is saved/);
  const { goals } = await call('GET', '/api/goals');
  assert.equal(goals[0].saved_cents, 70000);
  assert.equal(goals[0].months_left, 12);
  assert.equal(goals[0].needed_monthly_cents, Math.ceil(230000 / 12));
  const dash = await call('GET', `/api/dashboard?month=${M}`);
  assert.equal(dash.kpis.saved_cents, 20000); // the "already saved" amount is not counted as saved this month
});

test('investments: average cost, realised gains, oversell protection', async () => {
  const { call } = fresh();
  const h = await call('POST', '/api/holdings', { symbol: 'TEST', name: 'Test fund', asset_type: 'etf', price_source: 'manual', manual_price: 120 });
  await call('POST', '/api/investment-tx', { holding_id: h.id, kind: 'buy', quantity: 10, price: 100, fees_cents: 100, date: addDays(T, -10) });
  await call('POST', '/api/investment-tx', { holding_id: h.id, kind: 'buy', quantity: 10, price: 110, fees_cents: 100, date: addDays(T, -5) });
  await rejects(call('POST', '/api/investment-tx', { holding_id: h.id, kind: 'sell', quantity: 25, price: 120, date: T }), /only hold 20/);
  await call('POST', '/api/investment-tx', { holding_id: h.id, kind: 'sell', quantity: 5, price: 120, fees_cents: 0, date: T });
  const inv = await call('GET', '/api/investments');
  const item = inv.items[0];
  assert.equal(item.quantity, 15);
  // cost: 100,100 + 110,100 = 210,200 cents for 20 -> avg 10,510; selling 5 removes 52,550
  assert.equal(item.cost_cents, 157650);
  assert.equal(item.value_cents, 15 * 120 * 100);
  assert.equal(item.realized_cents, 60000 - 52550);
  assert.equal(inv.totals.unrealized_cents, 180000 - 157650);
});

test('recurring: autopay catches up and keeps month-end dates', async () => {
  const { db, call, cat } = fresh();
  const start = addMonths(T, -3);
  await call('POST', '/api/recurring', { name: 'Salary', type: 'income', amount_cents: 250000, category_id: cat('Salary'), frequency: 'monthly', next_due: start, autopay: true });
  const tx = await call('GET', '/api/transactions?type=income');
  assert.equal(tx.total, 4); // 3 months ago, 2 months ago, last month, this month
  const r = db.prepare('SELECT * FROM recurring').get();
  assert.ok(r.next_due > T);
  assert.equal(processDue(db), 0); // nothing posted twice

  const rent = await call('POST', '/api/recurring', { name: 'Rent', amount_cents: 80000, category_id: cat('Housing'), frequency: 'monthly', next_due: addDays(T, 3), autopay: false });
  const paid = await call('POST', `/api/recurring/${rent.id}/pay`, { amount_cents: 81000 });
  assert.equal(paid.next_due, addMonths(addDays(T, 3), 1));
  const skipped = await call('POST', `/api/recurring/${rent.id}/skip`);
  assert.equal(skipped.next_due, addMonths(addDays(T, 3), 2));
  const yearly = await call('POST', '/api/recurring', { name: 'Insurance', amount_cents: 48000, frequency: 'yearly', next_due: addDays(T, 30), subscription: false });
  const list = await call('GET', '/api/recurring');
  assert.equal(list.items.find((i) => i.id === yearly.id).monthly_cents, 4000);
  assert.equal(list.totals.income_monthly_cents, 250000);
});

test('debts: payments reduce balance, log an expense, and can be undone', async () => {
  const { call } = fresh();
  const d = await call('POST', '/api/debts', { name: 'Card', kind: 'credit_card', balance_cents: 100000, apr: 18.9, min_payment_cents: 3500 });
  const after = await call('POST', `/api/debts/${d.id}/payments`, { amount_cents: 25000, date: T });
  assert.equal(after.balance_cents, 75000);
  const tx = await call('GET', '/api/transactions');
  assert.equal(tx.items[0].category_name, 'Debt payments');
  const pays = await call('GET', `/api/debts/${d.id}/payments`);
  await call('DELETE', `/api/debt-payments/${pays[0].id}`);
  const { debts } = await call('GET', '/api/debts');
  assert.equal(debts[0].balance_cents, 100000);
  assert.equal((await call('GET', '/api/transactions')).total, 0);
});

test('import: rule suggestions, duplicate detection, learning rules', async () => {
  const { call, cat } = fresh();
  await call('POST', '/api/rules', { pattern: 'lidl', category_id: cat('Groceries') });
  await call('POST', '/api/transactions', { date: T, type: 'expense', amount_cents: 999, description: 'Coffee' });
  const rows = [
    { date: T, description: 'LIDL Berlin 123', amount_cents: -2500 },
    { date: T, description: 'Coffee', amount_cents: -999 },
    { date: T, description: 'Employer', amount_cents: 250000 },
    { date: 'bad', description: 'x', amount_cents: -1 },
  ];
  const p = await call('POST', '/api/import/preview', { rows });
  assert.equal(p.rows[0].category_id, cat('Groceries'));
  assert.equal(p.rows[0].type, 'expense');
  assert.equal(p.rows[1].duplicate, true);
  assert.equal(p.rows[2].type, 'income');
  assert.deepEqual(p.rows[3].errors, ['Invalid date']);
  const c = await call('POST', '/api/import/commit', { rows: [p.rows[0], { ...p.rows[2], category_id: cat('Salary') }], rules: [{ pattern: 'employer', category_id: cat('Salary') }] });
  assert.equal(c.imported, 2);
  assert.equal(c.rules_added, 1);
  const again = await call('POST', '/api/import/preview', { rows: rows.slice(0, 1) });
  assert.equal(again.rows[0].duplicate, true);
  const s = await call('GET', '/api/suggest-category?type=income&description=Employer%20GmbH');
  assert.equal(s.category_id, cat('Salary'));
});

test('dashboard, reports and annual overview add up', async () => {
  const { call, cat } = fresh();
  await call('POST', '/api/transactions', { date: `${PREV}-10`, type: 'income', amount_cents: 200000, category_id: cat('Salary') });
  await call('POST', '/api/transactions', { date: `${PREV}-12`, type: 'expense', amount_cents: 50000, category_id: cat('Housing') });
  await call('POST', '/api/transactions', { date: T, type: 'expense', amount_cents: 7000, category_id: cat('Groceries') });
  const d = await call('GET', `/api/dashboard?month=${PREV}`);
  assert.equal(d.kpis.income_cents, 200000);
  assert.equal(d.kpis.expense_cents, 50000);
  assert.equal(d.kpis.savings_rate, 0.75);
  const r = await call('GET', '/api/reports/overview?months=6');
  assert.equal(r.totals.active_months, 2);
  assert.equal(r.totals.avg_income_cents, 100000);
  assert.equal(r.series.at(-1).expense_cents, 7000);
  const a = await call('GET', `/api/reports/annual?year=${PREV.slice(0, 4)}`);
  const housing = a.expense.find((x) => x.name === 'Housing');
  assert.equal(housing.months[Number(PREV.slice(5)) - 1], 50000);
});

test('backup → reset → restore round trip', async () => {
  const { call, cat } = fresh();
  await call('POST', '/api/transactions', { date: T, type: 'expense', amount_cents: 4200, category_id: cat('Groceries'), description: 'Market' });
  await call('POST', '/api/goals', { name: 'Laptop', target_cents: 150000, initial_cents: 1000 });
  const backup = JSON.parse((await call('GET', '/api/backup')).raw.body);
  await rejects(call('POST', '/api/reset', { confirm: 'nope' }), /DELETE/);
  await call('POST', '/api/reset', { confirm: 'DELETE' });
  assert.equal((await call('GET', '/api/transactions')).total, 0);
  await call('POST', '/api/restore', backup);
  const tx = await call('GET', '/api/transactions');
  assert.equal(tx.total, 1);
  assert.equal(tx.items[0].category_name, 'Groceries');
  const { goals } = await call('GET', '/api/goals');
  assert.equal(goals[0].saved_cents, 1000);
  await rejects(call('POST', '/api/restore', { hello: 1 }), /not a Moneta backup/);
});

test('demo data loads only into an empty tracker', async () => {
  const { call } = fresh();
  await call('POST', '/api/demo');
  const b = await call('GET', '/api/bootstrap');
  assert.ok(b.counts.transactions > 50);
  await rejects(call('POST', '/api/demo'), /empty tracker/);
  const nw = await call('GET', '/api/networth');
  assert.ok(nw.cash_cents > 0, 'demo cash should be positive');
});
