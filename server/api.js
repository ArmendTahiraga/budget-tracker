// JSON API. Every handler receives ({ db, params, query, body }) and returns a JSON-serialisable value,
// or { raw: { status, headers, body } } for non-JSON responses.
import crypto from 'node:crypto';
import { inTx, seedDefaults, migrate, iconName, TABLES, DEFAULT_SETTINGS } from './db.js';
import {
  HttpError, today, currentMonth, monthBounds, shiftMonth, monthsBack, addDays,
  reqDate, optDate, reqMonth, cents, num, str, oneOf, bool, isMonth, isDate,
} from './util.js';
import { processDue, postOccurrence, advanceItem, upcoming, monthlyEquivalent } from './recurring.js';
import { refreshPrices, searchSymbols, yahooHistory, coingeckoHistory } from './prices.js';
import { loadDemo } from './demo.js';

// ------------------------------------------------------------------ helpers
const one = (db, sql, ...p) => db.prepare(sql).get(...p);
const all = (db, sql, ...p) => db.prepare(sql).all(...p);
const run = (db, sql, ...p) => db.prepare(sql).run(...p);
const scalar = (db, sql, ...p) => {
  const r = db.prepare(sql).get(...p);
  return r ? Number(Object.values(r)[0] || 0) : 0;
};

function getSettings(db) {
  const s = Object.fromEntries(all(db, 'SELECT key, value FROM settings').map((r) => [r.key, r.value]));
  return { ...DEFAULT_SETTINGS, ...s };
}
const sNum = (s, k) => Number(s[k] || 0);

function mustExist(db, table, id, label = table) {
  const row = one(db, `SELECT * FROM ${table} WHERE id = ?`, Number(id));
  if (!row) throw new HttpError(404, `${label} not found`);
  return row;
}

function categoryOrNull(db, id, kind) {
  if (id === null || id === undefined || id === '') return null;
  const c = one(db, 'SELECT * FROM categories WHERE id = ?', Number(id));
  if (!c) throw new HttpError(400, 'Unknown category');
  if (kind && c.kind !== kind) throw new HttpError(400, `Category "${c.name}" is an ${c.kind} category`);
  return c.id;
}

const sumTx = (db, type, start, end) =>
  scalar(db, 'SELECT COALESCE(SUM(amount_cents),0) FROM transactions WHERE type = ? AND date BETWEEN ? AND ?', type, start, end);
// Money moved into/out of goals from cash. Initial balances (already saved elsewhere) are excluded.
const goalNet = (db, start, end) =>
  scalar(db, 'SELECT COALESCE(SUM(amount_cents),0) FROM goal_entries WHERE initial = 0 AND date BETWEEN ? AND ?', start, end);
const investNet = (db, start, end) =>
  scalar(db, `SELECT COALESCE(SUM(CASE kind WHEN 'buy' THEN total_cents WHEN 'sell' THEN -total_cents ELSE 0 END),0)
              FROM investment_tx WHERE date BETWEEN ? AND ?`, start, end);
const dividends = (db, start, end) =>
  scalar(db, "SELECT COALESCE(SUM(total_cents),0) FROM investment_tx WHERE kind = 'dividend' AND date BETWEEN ? AND ?", start, end);

function normDesc(s) {
  return String(s || '').toLowerCase().replace(/\d+/g, ' ').replace(/[^\p{L}\s&]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function suggestCategory(db, description, type) {
  const d = String(description || '').toLowerCase();
  if (!d) return null;
  const rules = all(db, `SELECT r.pattern, r.category_id FROM rules r JOIN categories c ON c.id = r.category_id
                         WHERE c.archived = 0 AND c.kind = ? ORDER BY LENGTH(r.pattern) DESC`, type);
  for (const r of rules) if (d.includes(r.pattern.toLowerCase())) return r.category_id;
  const n = normDesc(description);
  if (!n) return null;
  const hist = all(db, `SELECT description, category_id FROM transactions
                        WHERE type = ? AND category_id IS NOT NULL ORDER BY date DESC LIMIT 2000`, type);
  for (const h of hist) if (normDesc(h.description) === n) return h.category_id;
  return null;
}

// ------------------------------------------------------------------ portfolio math (average-cost method)
function computePortfolio(db, { includeArchived = false } = {}) {
  const holdings = all(db, `SELECT * FROM holdings ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY symbol`);
  const txs = all(db, 'SELECT * FROM investment_tx ORDER BY date, id');
  const byHolding = new Map(holdings.map((h) => [h.id, []]));
  for (const t of txs) byHolding.get(t.holding_id)?.push(t);

  let totalValue = 0, totalCost = 0, totalRealized = 0, totalDividends = 0, totalDayChange = 0;
  const items = holdings.map((h) => {
    let qty = 0, cost = 0, realized = 0, divs = 0;
    for (const t of byHolding.get(h.id)) {
      if (t.kind === 'buy') { qty += t.quantity; cost += t.total_cents; }
      else if (t.kind === 'sell') {
        const avg = qty > 0 ? cost / qty : 0;
        const q = Math.min(t.quantity, qty);
        realized += t.total_cents - avg * q;
        cost -= avg * q;
        qty -= q;
      } else if (t.kind === 'dividend') { divs += t.total_cents; }
    }
    if (qty < 1e-9) { qty = 0; cost = 0; }
    const hasPrice = typeof h.last_price === 'number';
    const value = hasPrice ? Math.round(qty * h.last_price * 100) : Math.round(cost);
    const unrealized = value - cost;
    const dayChange = hasPrice && typeof h.day_change_pct === 'number'
      ? value - value / (1 + h.day_change_pct / 100) : 0;
    totalValue += value; totalCost += cost; totalRealized += realized; totalDividends += divs; totalDayChange += dayChange;
    return {
      ...h,
      quantity: qty,
      avg_cost: qty > 0 ? cost / qty / 100 : 0,
      cost_cents: Math.round(cost),
      value_cents: value,
      unrealized_cents: Math.round(unrealized),
      unrealized_pct: cost > 0 ? (unrealized / cost) * 100 : 0,
      realized_cents: Math.round(realized),
      dividends_cents: divs,
      day_change_cents: Math.round(dayChange),
      has_price: hasPrice,
      tx_count: byHolding.get(h.id).length,
    };
  });
  return {
    items,
    totals: {
      value_cents: Math.round(totalValue),
      cost_cents: Math.round(totalCost),
      unrealized_cents: Math.round(totalValue - totalCost),
      unrealized_pct: totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0,
      realized_cents: Math.round(totalRealized),
      dividends_cents: totalDividends,
      day_change_cents: Math.round(totalDayChange),
    },
  };
}

function snapshotPortfolio(db) {
  const { items, totals } = computePortfolio(db);
  if (!items.length) return;
  run(db, `INSERT INTO portfolio_snapshots (date, value_cents, cost_cents) VALUES (?, ?, ?)
           ON CONFLICT(date) DO UPDATE SET value_cents = excluded.value_cents, cost_cents = excluded.cost_cents`,
  today(), totals.value_cents, totals.cost_cents);
}

// ------------------------------------------------------------------ balances & net worth
function cashAsOf(db, s, end) {
  const start = isDate(s.starting_balance_date) ? s.starting_balance_date : '0000-01-01';
  if (end < start) return sNum(s, 'starting_balance_cents');
  return sNum(s, 'starting_balance_cents')
    + sumTx(db, 'income', start, end) - sumTx(db, 'expense', start, end)
    - goalNet(db, start, end) - investNet(db, start, end) + dividends(db, start, end);
}

function goalsTotal(db, end = '9999-12-31') {
  return scalar(db, 'SELECT COALESCE(SUM(e.amount_cents),0) FROM goal_entries e JOIN goals g ON g.id = e.goal_id WHERE e.date <= ?', end);
}

function debtsTotal(db) {
  return scalar(db, 'SELECT COALESCE(SUM(balance_cents),0) FROM debts WHERE archived = 0');
}

function netWorthNow(db, s) {
  const cash = cashAsOf(db, s, today());
  const goals = goalsTotal(db);
  const invest = computePortfolio(db).totals.value_cents;
  const debt = debtsTotal(db);
  return { cash_cents: cash, goals_cents: goals, investments_cents: invest, debts_cents: debt, net_worth_cents: cash + goals + invest - debt };
}

function netWorthHistory(db, s, months) {
  const snaps = all(db, 'SELECT * FROM portfolio_snapshots ORDER BY date');
  const debtNow = debtsTotal(db);
  const curMonth = currentMonth();
  const portfolioNow = computePortfolio(db).totals.value_cents;
  return months.map((m) => {
    const isCur = m === curMonth;
    const end = isCur ? today() : monthBounds(m).end;
    const cash = cashAsOf(db, s, end);
    const goals = goalsTotal(db, end);
    let invest;
    if (isCur || m > curMonth) invest = portfolioNow;
    else {
      const snap = [...snaps].reverse().find((x) => x.date <= end);
      invest = snap ? snap.value_cents
        : scalar(db, `SELECT COALESCE(SUM(CASE kind WHEN 'buy' THEN total_cents WHEN 'sell' THEN -total_cents ELSE 0 END),0)
                      FROM investment_tx WHERE date <= ?`, end);
    }
    const paidAfter = scalar(db, `SELECT COALESCE(SUM(p.amount_cents),0) FROM debt_payments p JOIN debts d ON d.id = p.debt_id
                                  WHERE d.archived = 0 AND p.date > ?`, end);
    const debt = debtNow + paidAfter;
    return { month: m, cash_cents: cash, goals_cents: goals, investments_cents: invest, debts_cents: debt, net_worth_cents: cash + goals + invest - debt };
  });
}

// ------------------------------------------------------------------ budget computation
function budgetData(db, month) {
  const s = getSettings(db);
  const { start, end, days } = monthBounds(month);
  const incomeActual = sumTx(db, 'income', start, end);
  const expected = sNum(s, 'expected_income_cents');
  const planIncome = s.plan_basis === 'actual' ? incomeActual : (expected || incomeActual);

  const avgStart = monthBounds(shiftMonth(month, -3)).start;
  const avgEnd = monthBounds(shiftMonth(month, -1)).end;

  const cats = all(db, `
    SELECT c.*,
      COALESCE(b.amount_cents, 0) AS budget_cents,
      COALESCE((SELECT SUM(amount_cents) FROM transactions t WHERE t.category_id = c.id AND t.type = 'expense' AND t.date BETWEEN ? AND ?), 0) AS spent_cents,
      COALESCE((SELECT SUM(amount_cents) FROM transactions t WHERE t.category_id = c.id AND t.type = 'expense' AND t.date BETWEEN ? AND ?), 0) AS last3_cents
    FROM categories c
    LEFT JOIN budgets b ON b.category_id = c.id AND b.month = ?
    WHERE c.kind = 'expense'
    ORDER BY c.sort, c.name`, start, end, avgStart, avgEnd, month)
    .filter((c) => !c.archived || c.spent_cents > 0 || c.budget_cents > 0)
    .map(({ last3_cents, ...c }) => ({ ...c, avg3_cents: Math.round(last3_cents / 3), remaining_cents: c.budget_cents - c.spent_cents }));

  const uncategorized = scalar(db, "SELECT COALESCE(SUM(amount_cents),0) FROM transactions WHERE type='expense' AND category_id IS NULL AND date BETWEEN ? AND ?", start, end);
  const budgeted = cats.filter((c) => c.budget_cents > 0);
  const totalBudget = budgeted.reduce((a, c) => a + c.budget_cents, 0);
  const totalSpent = cats.reduce((a, c) => a + c.spent_cents, 0) + uncategorized;
  const spentBudgeted = budgeted.reduce((a, c) => a + c.spent_cents, 0);
  const overspent = budgeted.reduce((a, c) => a + Math.max(0, c.spent_cents - c.budget_cents), 0);
  const unbudgetedSpent = totalSpent - spentBudgeted;

  const goals = all(db, 'SELECT id, name, icon, color, monthly_cents FROM goals WHERE archived = 0 ORDER BY id');
  const goalsPlanned = goals.reduce((a, g) => a + g.monthly_cents, 0);
  const savedActual = goalNet(db, start, end);
  const investPlanned = sNum(s, 'monthly_invest_plan_cents');
  const investedActual = investNet(db, start, end);

  const pct = { needs: sNum(s, 'split_needs'), wants: sNum(s, 'split_wants'), savings: sNum(s, 'split_savings') };
  const grpSpent = (g) => cats.filter((c) => (c.grp || 'wants') === g).reduce((a, c) => a + c.spent_cents, 0);
  const split = {
    needs: { pct: pct.needs, target_cents: Math.round(planIncome * pct.needs / 100), actual_cents: grpSpent('needs') },
    wants: { pct: pct.wants, target_cents: Math.round(planIncome * pct.wants / 100), actual_cents: grpSpent('wants') + uncategorized },
    savings: { pct: pct.savings, target_cents: Math.round(planIncome * pct.savings / 100), actual_cents: grpSpent('savings') + Math.max(0, savedActual) + Math.max(0, investedActual) },
  };

  const assigned = totalBudget + goalsPlanned + investPlanned;
  const cur = currentMonth();
  const isCur = month === cur;
  const dayIdx = isCur ? Number(today().slice(8, 10)) : (month > cur ? 0 : days);

  return {
    month, method: s.budget_method, days_in_month: days, day_of_month: dayIdx, is_current: isCur,
    income_actual_cents: incomeActual, income_expected_cents: expected, plan_income_cents: planIncome, plan_basis: s.plan_basis,
    categories: cats,
    uncategorized_cents: uncategorized,
    totals: {
      budget_cents: totalBudget, spent_cents: totalSpent, remaining_cents: totalBudget - spentBudgeted,
      overspent_cents: overspent, unbudgeted_spent_cents: unbudgetedSpent,
    },
    goals, goals_planned_cents: goalsPlanned, saved_actual_cents: savedActual,
    invest_planned_cents: investPlanned, invested_actual_cents: investedActual,
    split,
    zero: { income_cents: planIncome, assigned_cents: assigned, left_to_assign_cents: planIncome - assigned },
  };
}

// ------------------------------------------------------------------ goals
function goalsData(db) {
  const goals = all(db, 'SELECT * FROM goals ORDER BY archived, id');
  const t = today();
  const m3start = monthBounds(shiftMonth(currentMonth(), -2)).start;
  const curM = monthBounds(currentMonth());
  return goals.map((g) => {
    const saved = scalar(db, 'SELECT COALESCE(SUM(amount_cents),0) FROM goal_entries WHERE goal_id = ?', g.id);
    const last3 = scalar(db, 'SELECT COALESCE(SUM(amount_cents),0) FROM goal_entries WHERE goal_id = ? AND date >= ? AND initial = 0', g.id, m3start);
    const thisMonth = scalar(db, 'SELECT COALESCE(SUM(amount_cents),0) FROM goal_entries WHERE goal_id = ? AND initial = 0 AND date BETWEEN ? AND ?', g.id, curM.start, curM.end);
    const remaining = Math.max(0, g.target_cents - saved);
    let monthsLeft = null, needed = null;
    if (g.target_date) {
      const [ty, tm] = g.target_date.split('-').map(Number);
      const [cy, cm] = t.split('-').map(Number);
      monthsLeft = Math.max(0, (ty - cy) * 12 + (tm - cm));
      needed = remaining > 0 ? Math.ceil(remaining / Math.max(1, monthsLeft)) : 0;
    }
    const rate = g.monthly_cents > 0 ? g.monthly_cents : Math.max(0, Math.round(last3 / 3));
    let projected = null;
    if (remaining === 0 && g.target_cents > 0) projected = t;
    else if (rate > 0 && remaining > 0) {
      const months = Math.ceil(remaining / rate);
      projected = months <= 600 ? addDays(t, Math.round(months * 30.44)) : null;
    }
    let status = 'no_target';
    if (g.target_cents > 0 && saved >= g.target_cents) status = 'done';
    else if (g.target_date && g.target_date < t) status = 'overdue';
    else if (g.target_date && needed !== null) status = rate >= needed ? 'on_track' : 'behind';
    else if (g.target_cents > 0) status = 'no_date';
    return {
      ...g, saved_cents: saved, remaining_cents: remaining,
      progress: g.target_cents > 0 ? Math.min(1, saved / g.target_cents) : 0,
      months_left: monthsLeft, needed_monthly_cents: needed, avg_monthly_cents: Math.round(last3 / 3),
      this_month_cents: thisMonth, projected_date: projected, status,
    };
  });
}

function emergencySuggestion(db, s) {
  const m = currentMonth();
  const start = monthBounds(shiftMonth(m, -3)).start, end = monthBounds(shiftMonth(m, -1)).end;
  const essentials = scalar(db, `SELECT COALESCE(SUM(t.amount_cents),0) FROM transactions t JOIN categories c ON c.id = t.category_id
                                 WHERE t.type='expense' AND c.grp = 'needs' AND t.date BETWEEN ? AND ?`, start, end) / 3;
  const allExp = sumTx(db, 'expense', start, end) / 3;
  const monthsTarget = sNum(s, 'emergency_months_target') || 6;
  return { monthly_essentials_cents: Math.round(essentials), monthly_expenses_cents: Math.round(allExp), months_target: monthsTarget, suggested_cents: Math.round((essentials || allExp) * monthsTarget) };
}

// ------------------------------------------------------------------ dashboard
function dashboardData(db, month) {
  const s = getSettings(db);
  const { start, end, days } = monthBounds(month);
  const income = sumTx(db, 'income', start, end);
  const expense = sumTx(db, 'expense', start, end);
  const saved = goalNet(db, start, end);
  const invested = investNet(db, start, end);
  const budget = budgetData(db, month);
  const isCur = month === currentMonth();
  const dayIdx = budget.day_of_month;
  const daysLeft = isCur ? days - dayIdx + 1 : 0;

  const byCategory = all(db, `SELECT t.category_id AS id, COALESCE(c.name, 'Uncategorized') AS name, COALESCE(c.icon, 'help') AS icon,
                                     COALESCE(c.color, '#52525b') AS color, SUM(t.amount_cents) AS spent_cents
                              FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
                              WHERE t.type = 'expense' AND t.date BETWEEN ? AND ?
                              GROUP BY t.category_id ORDER BY spent_cents DESC`, start, end);

  const cashflow = monthsBack(month, 6).map((m) => {
    const b = monthBounds(m);
    return { month: m, income_cents: sumTx(db, 'income', b.start, b.end), expense_cents: sumTx(db, 'expense', b.start, b.end), saved_cents: goalNet(db, b.start, b.end) + investNet(db, b.start, b.end) };
  });

  // cumulative daily spending this month vs previous month
  const daily = (b) => {
    const rows = all(db, "SELECT CAST(substr(date, 9, 2) AS INTEGER) AS d, SUM(amount_cents) AS s FROM transactions WHERE type='expense' AND date BETWEEN ? AND ? GROUP BY d", b.start, b.end);
    const arr = new Array(b.days).fill(0);
    for (const r of rows) arr[r.d - 1] = r.s;
    let acc = 0;
    return arr.map((v) => (acc += v));
  };
  const curDaily = daily({ start, end, days });
  const pace = {
    current: isCur ? curDaily.slice(0, dayIdx) : curDaily,
    previous: daily(monthBounds(shiftMonth(month, -1))),
    budget_cents: budget.totals.budget_cents,
  };

  const recent = all(db, `SELECT t.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color
                          FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
                          WHERE t.date BETWEEN ? AND ? ORDER BY t.date DESC, t.id DESC LIMIT 8`, start, end);
  const goals = goalsData(db).filter((g) => !g.archived);
  const nw = netWorthNow(db, s);
  const portfolio = computePortfolio(db).totals;
  const up = upcoming(db, 14);
  const subs = all(db, 'SELECT * FROM recurring WHERE active = 1 AND subscription = 1');
  const subsMonthly = subs.reduce((a, r) => a + monthlyEquivalent(r), 0);

  // ---- insights ({{cents}} placeholders are formatted as money by the client)
  const insights = [];
  const savingsRate = income > 0 ? (income - expense) / income : null;
  const overdue = up.filter((u) => u.overdue);
  if (overdue.length) insights.push({ level: 'bad', icon: 'clock', text: `${overdue.length} bill${overdue.length > 1 ? 's are' : ' is'} overdue: ${overdue.slice(0, 3).map((o) => o.name).join(', ')}.`, link: '#/recurring' });
  // Pace projection: fixed bills (recurring/debt) don't scale with time, so only variable spending is extrapolated,
  // and bills still scheduled for the rest of the month are added on top.
  const fixedByCat = new Map(all(db, `SELECT category_id, SUM(amount_cents) AS s FROM transactions
                                      WHERE type='expense' AND source IN ('recurring','debt') AND date BETWEEN ? AND ? GROUP BY category_id`, start, end)
    .map((r) => [r.category_id, r.s]));
  const upcomingByCat = new Map();
  if (isCur) {
    const catOf = new Map(all(db, 'SELECT id, category_id FROM recurring').map((r) => [r.id, r.category_id]));
    for (const u of upcoming(db, days - dayIdx)) {
      if (u.type !== 'expense' || u.date > end) continue;
      const cid = catOf.get(u.recurring_id);
      upcomingByCat.set(cid, (upcomingByCat.get(cid) || 0) + u.amount_cents);
    }
  }
  const paceWarnings = [];
  for (const c of budget.categories) {
    if (c.budget_cents <= 0) continue;
    if (c.spent_cents > c.budget_cents) {
      insights.push({ level: 'bad', icon: c.icon || 'alert', text: `${c.name} is over budget by {{${c.spent_cents - c.budget_cents}}}.`, link: '#/budget' });
    } else if (isCur && dayIdx >= 7) {
      const variable = c.spent_cents - (fixedByCat.get(c.id) || 0);
      const projected = c.spent_cents + Math.round((Math.max(0, variable) / dayIdx) * (days - dayIdx)) + (upcomingByCat.get(c.id) || 0);
      if (variable > 0 && projected > c.budget_cents * 1.1) paceWarnings.push({ c, projected });
    }
  }
  paceWarnings.sort((a, b) => (b.projected - b.c.budget_cents) - (a.projected - a.c.budget_cents));
  for (const { c, projected } of paceWarnings.slice(0, 2)) {
    insights.push({ level: 'warn', icon: c.icon || 'trendingUp', text: `At this pace ${c.name} will reach about {{${projected}}}, {{${projected - c.budget_cents}}} over its budget.`, link: '#/budget' });
  }
  const spikes = budget.categories
    .filter((c) => c.avg3_cents > 0 && c.spent_cents > c.avg3_cents * 1.3 && c.spent_cents - c.avg3_cents > 3000)
    .sort((a, b) => (b.spent_cents - b.avg3_cents) - (a.spent_cents - a.avg3_cents));
  if (spikes[0]) insights.push({ level: 'warn', icon: spikes[0].icon || 'trendingUp', text: `${spikes[0].name} is ${Math.round((spikes[0].spent_cents / spikes[0].avg3_cents - 1) * 100)}% above your 3-month average of {{${spikes[0].avg3_cents}}}.`, link: '#/reports' });
  if (savingsRate !== null) {
    const target = sNum(s, 'split_savings');
    const pctR = Math.round(savingsRate * 100);
    if (pctR >= target) insights.push({ level: 'good', icon: 'sprout', text: `You kept ${pctR}% of your income this month. Your target is ${target}%.` });
    else if (!isCur || dayIdx > 20) insights.push({ level: 'warn', icon: 'sprout', text: `You kept ${pctR}% of your income this month, below your ${target}% target.` });
  }
  for (const g of goals.filter((x) => x.status === 'behind').slice(0, 2)) {
    const by = new Date(`${g.target_date}T00:00:00`).toLocaleDateString('en-IE', { month: 'short', year: 'numeric' });
    insights.push({ level: 'warn', icon: g.icon || 'target', text: `${g.name} needs {{${g.needed_monthly_cents}}}/month to be ready by ${by}.`, link: '#/goals' });
  }
  const emergency = goals.filter((g) => g.kind === 'emergency');
  const em = emergencySuggestion(db, s);
  const essentials = em.monthly_essentials_cents || em.monthly_expenses_cents;
  if (!emergency.length && essentials > 0) {
    insights.push({ level: 'info', icon: 'lifebuoy', text: `No emergency fund yet. ${em.months_target} months of essentials would be about {{${em.suggested_cents}}}.`, link: '#/goals' });
  } else if (emergency.length && essentials > 0) {
    const covered = emergency.reduce((a, g) => a + g.saved_cents, 0) / essentials;
    insights.push({ level: covered >= em.months_target ? 'good' : 'info', icon: 'lifebuoy', text: `Your emergency fund covers ${covered.toFixed(1)} months of essentials (target ${em.months_target}).`, link: '#/goals' });
  }
  if (subsMonthly > 0) insights.push({ level: 'info', icon: 'tv', text: `${subs.length} subscription${subs.length > 1 ? 's cost' : ' costs'} {{${subsMonthly * 12}}} a year ({{${subsMonthly}}}/month).`, link: '#/recurring' });
  const uncatCount = scalar(db, 'SELECT COUNT(*) FROM transactions WHERE category_id IS NULL AND date BETWEEN ? AND ?', start, end);
  if (uncatCount) insights.push({ level: 'info', icon: 'tag', text: `${uncatCount} transaction${uncatCount > 1 ? 's need' : ' needs'} a category this month.`, link: `#/transactions?uncategorized=1&month=${month}` });
  if (s.budget_method === 'zero' && budget.zero.left_to_assign_cents !== 0 && budget.plan_income_cents > 0) {
    const l = budget.zero.left_to_assign_cents;
    insights.push({ level: l > 0 ? 'info' : 'bad', icon: 'calculator', text: l > 0 ? `{{${l}}} of income still needs a job.` : `You've assigned {{${-l}}} more than your income.`, link: '#/budget' });
  }
  const order = { bad: 0, warn: 1, good: 2, info: 3 };
  insights.sort((a, b) => order[a.level] - order[b.level]);

  return {
    month, is_current: isCur, days_in_month: days, day_of_month: dayIdx, days_left: daysLeft,
    kpis: {
      income_cents: income, expense_cents: expense, saved_cents: saved, invested_cents: invested,
      net_cents: income - expense - saved - invested,
      savings_rate: savingsRate,
      budget_cents: budget.totals.budget_cents, budget_remaining_cents: budget.totals.remaining_cents,
      safe_daily_cents: isCur && daysLeft > 0 && budget.totals.budget_cents > 0 ? Math.max(0, Math.floor(budget.totals.remaining_cents / daysLeft)) : null,
    },
    by_category: byCategory, cashflow, pace, recent, goals: goals.slice(0, 6), upcoming: up.slice(0, 8),
    net_worth: nw, portfolio, insights: insights.slice(0, 7), method: s.budget_method, split: budget.split,
  };
}

// ------------------------------------------------------------------ validation of bodies
function txBody(db, b) {
  const type = oneOf(b.type, 'type', ['income', 'expense']);
  return {
    date: reqDate(b.date),
    type,
    amount_cents: cents(b.amount_cents),
    category_id: categoryOrNull(db, b.category_id, type),
    description: str(b.description, 'description', { max: 200 }),
    notes: str(b.notes, 'notes', { max: 2000 }),
  };
}

const SETTINGS_SCHEMA = {
  locale: (v) => oneOf(v, 'locale', ['en-IE', 'de-DE', 'en-US', 'fr-FR', 'nl-NL', 'sq-AL', 'en-GB']),
  budget_method: (v) => oneOf(v, 'budget_method', ['limits', '503020', 'zero']),
  split_needs: (v) => String(num(v, 'needs %', { min: 0, max: 100 })),
  split_wants: (v) => String(num(v, 'wants %', { min: 0, max: 100 })),
  split_savings: (v) => String(num(v, 'savings %', { min: 0, max: 100 })),
  expected_income_cents: (v) => String(cents(v, 'expected income')),
  plan_basis: (v) => oneOf(v, 'plan_basis', ['expected', 'actual']),
  monthly_invest_plan_cents: (v) => String(cents(v, 'monthly investing plan')),
  starting_balance_cents: (v) => String(cents(v, 'starting balance', { allowNegative: true })),
  starting_balance_date: (v) => optDate(v, 'starting balance date') || '',
  emergency_months_target: (v) => String(num(v, 'emergency months', { min: 1, max: 24 })),
  name: (v) => str(v, 'name', { max: 60 }),
};

// ------------------------------------------------------------------ routes
const routes = [];
const route = (method, path, handler) => {
  const keys = [];
  const re = new RegExp('^' + path.replace(/\./g, '\\.').replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
};

// ---- bootstrap / settings
route('GET', '/api/bootstrap', ({ db }) => ({
  settings: getSettings(db),
  categories: all(db, 'SELECT * FROM categories ORDER BY kind DESC, sort, name'),
  counts: {
    transactions: scalar(db, 'SELECT COUNT(*) FROM transactions'),
    goals: scalar(db, 'SELECT COUNT(*) FROM goals'),
    holdings: scalar(db, 'SELECT COUNT(*) FROM holdings'),
  },
  today: today(),
}));

route('PUT', '/api/settings', ({ db, body }) => {
  const s = getSettings(db);
  const next = {};
  for (const [k, v] of Object.entries(body || {})) {
    if (!SETTINGS_SCHEMA[k]) continue;
    next[k] = SETTINGS_SCHEMA[k](v);
  }
  const merged = { ...s, ...next };
  if (['split_needs', 'split_wants', 'split_savings'].some((k) => k in next)) {
    const total = Number(merged.split_needs) + Number(merged.split_wants) + Number(merged.split_savings);
    if (Math.abs(total - 100) > 0.01) throw new HttpError(400, `Needs + wants + savings must add up to 100% (currently ${total}%)`);
  }
  inTx(db, () => {
    for (const [k, v] of Object.entries(next)) run(db, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, v);
  });
  return getSettings(db);
});

// ---- categories
const COLOR = (v) => (/^#[0-9a-fA-F]{6}$/.test(v || '') ? v : '#7c5cff');
route('POST', '/api/categories', ({ db, body }) => {
  const kind = oneOf(body.kind, 'kind', ['expense', 'income']);
  const grp = kind === 'expense' ? oneOf(body.grp || 'wants', 'group', ['needs', 'wants', 'savings']) : null;
  const sort = scalar(db, 'SELECT COALESCE(MAX(sort),0)+1 FROM categories');
  const r = run(db, 'INSERT INTO categories (name, kind, grp, icon, color, sort) VALUES (?, ?, ?, ?, ?, ?)',
    str(body.name, 'name', { required: true, max: 40 }), kind, grp, iconName(str(body.icon, 'icon', { max: 30 })), COLOR(body.color), sort);
  return one(db, 'SELECT * FROM categories WHERE id = ?', r.lastInsertRowid);
});

route('PUT', '/api/categories/:id', ({ db, params, body }) => {
  const c = mustExist(db, 'categories', params.id, 'Category');
  const grp = c.kind === 'expense' ? oneOf(body.grp ?? c.grp ?? 'wants', 'group', ['needs', 'wants', 'savings']) : null;
  run(db, 'UPDATE categories SET name = ?, grp = ?, icon = ?, color = ?, archived = ? WHERE id = ?',
    str(body.name ?? c.name, 'name', { required: true, max: 40 }), grp, iconName(str(body.icon ?? c.icon, 'icon', { max: 30 })),
    COLOR(body.color ?? c.color), body.archived === undefined ? c.archived : bool(body.archived), c.id);
  return one(db, 'SELECT * FROM categories WHERE id = ?', c.id);
});

route('DELETE', '/api/categories/:id', ({ db, params }) => {
  const c = mustExist(db, 'categories', params.id, 'Category');
  const used = scalar(db, 'SELECT COUNT(*) FROM transactions WHERE category_id = ?', c.id) + scalar(db, 'SELECT COUNT(*) FROM recurring WHERE category_id = ?', c.id);
  if (used) {
    run(db, 'UPDATE categories SET archived = 1 WHERE id = ?', c.id);
    return { archived: true, message: `"${c.name}" is used by ${used} item(s), so it was archived instead of deleted.` };
  }
  run(db, 'DELETE FROM categories WHERE id = ?', c.id);
  return { deleted: true };
});

route('GET', '/api/suggest-category', ({ db, query }) => ({
  category_id: suggestCategory(db, query.description, query.type === 'income' ? 'income' : 'expense'),
}));

// ---- transactions
function txFilters(query) {
  const where = [];
  const p = [];
  if (isMonth(query.month)) { const b = monthBounds(query.month); where.push('t.date BETWEEN ? AND ?'); p.push(b.start, b.end); }
  if (isDate(query.from)) { where.push('t.date >= ?'); p.push(query.from); }
  if (isDate(query.to)) { where.push('t.date <= ?'); p.push(query.to); }
  if (query.type === 'income' || query.type === 'expense') { where.push('t.type = ?'); p.push(query.type); }
  if (query.uncategorized === '1') where.push('t.category_id IS NULL');
  else if (query.category) { where.push('t.category_id = ?'); p.push(Number(query.category)); }
  if (query.q) { where.push('(t.description LIKE ? OR t.notes LIKE ?)'); p.push(`%${query.q}%`, `%${query.q}%`); }
  if (query.source) { where.push('t.source = ?'); p.push(String(query.source)); }
  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', p };
}

route('GET', '/api/transactions', ({ db, query }) => {
  const { sql, p } = txFilters(query);
  const limit = Math.min(1000, Math.max(1, Number(query.limit) || 200));
  const offset = Math.max(0, Number(query.offset) || 0);
  const sortCol = { date: 't.date', amount: 't.amount_cents', description: 't.description' }[query.sort] || 't.date';
  const dir = query.dir === 'asc' ? 'ASC' : 'DESC';
  const items = all(db, `SELECT t.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color
                         FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
                         ${sql} ORDER BY ${sortCol} ${dir}, t.id ${dir} LIMIT ? OFFSET ?`, ...p, limit, offset);
  const agg = one(db, `SELECT COUNT(*) AS n,
                         COALESCE(SUM(CASE WHEN type='income' THEN amount_cents END),0) AS income,
                         COALESCE(SUM(CASE WHEN type='expense' THEN amount_cents END),0) AS expense
                       FROM transactions t ${sql}`, ...p);
  return { items, total: agg.n, income_cents: agg.income, expense_cents: agg.expense, limit, offset };
});

route('POST', '/api/transactions', ({ db, body }) => {
  const t = txBody(db, body);
  const r = run(db, 'INSERT INTO transactions (date, type, amount_cents, category_id, description, notes, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
    t.date, t.type, t.amount_cents, t.category_id, t.description, t.notes, 'manual');
  return one(db, 'SELECT * FROM transactions WHERE id = ?', r.lastInsertRowid);
});

route('PUT', '/api/transactions/:id', ({ db, params, body }) => {
  const cur = mustExist(db, 'transactions', params.id, 'Transaction');
  const t = txBody(db, { ...cur, ...body });
  run(db, 'UPDATE transactions SET date = ?, type = ?, amount_cents = ?, category_id = ?, description = ?, notes = ? WHERE id = ?',
    t.date, t.type, t.amount_cents, t.category_id, t.description, t.notes, cur.id);
  return one(db, 'SELECT * FROM transactions WHERE id = ?', cur.id);
});

route('DELETE', '/api/transactions/:id', ({ db, params }) => {
  mustExist(db, 'transactions', params.id, 'Transaction');
  run(db, 'DELETE FROM transactions WHERE id = ?', Number(params.id));
  return { deleted: true };
});

route('POST', '/api/transactions/bulk', ({ db, body }) => {
  const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter(Number.isInteger);
  if (!ids.length) throw new HttpError(400, 'No transactions selected');
  const marks = ids.map(() => '?').join(',');
  if (body.action === 'delete') {
    const r = run(db, `DELETE FROM transactions WHERE id IN (${marks})`, ...ids);
    return { changed: Number(r.changes) };
  }
  if (body.action === 'categorize') {
    const cat = body.category_id === null ? null : mustExist(db, 'categories', body.category_id, 'Category');
    const r = cat
      ? run(db, `UPDATE transactions SET category_id = ? WHERE type = ? AND id IN (${marks})`, cat.id, cat.kind, ...ids)
      : run(db, `UPDATE transactions SET category_id = NULL WHERE id IN (${marks})`, ...ids);
    return { changed: Number(r.changes), skipped: ids.length - Number(r.changes) };
  }
  throw new HttpError(400, 'Unknown bulk action');
});

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

route('GET', '/api/transactions/export.csv', ({ db, query }) => {
  const { sql, p } = txFilters(query);
  const rows = all(db, `SELECT t.date, t.type, t.amount_cents, COALESCE(c.name,'') AS category, t.description, t.notes, t.source
                        FROM transactions t LEFT JOIN categories c ON c.id = t.category_id ${sql} ORDER BY t.date, t.id`, ...p);
  const lines = ['Date,Type,Amount,Category,Description,Notes,Source'];
  for (const r of rows) {
    const amt = ((r.type === 'expense' ? -1 : 1) * r.amount_cents / 100).toFixed(2);
    lines.push([r.date, r.type, amt, r.category, r.description, r.notes, r.source].map(csvCell).join(','));
  }
  return { raw: { status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="moneta-transactions-${today()}.csv"` }, body: '\uFEFF' + lines.join('\n') } };
});

// ---- budget
route('GET', '/api/budget', ({ db, query }) => budgetData(db, isMonth(query.month) ? query.month : currentMonth()));

route('PUT', '/api/budget/:month/:categoryId', ({ db, params, body }) => {
  const month = reqMonth(params.month);
  const c = mustExist(db, 'categories', params.categoryId, 'Category');
  if (c.kind !== 'expense') throw new HttpError(400, 'Budgets apply to expense categories');
  if (body.amount_cents === null || body.amount_cents === '' || Number(body.amount_cents) === 0) {
    run(db, 'DELETE FROM budgets WHERE month = ? AND category_id = ?', month, c.id);
  } else {
    run(db, `INSERT INTO budgets (month, category_id, amount_cents) VALUES (?, ?, ?)
             ON CONFLICT(month, category_id) DO UPDATE SET amount_cents = excluded.amount_cents`, month, c.id, cents(body.amount_cents));
  }
  return { ok: true };
});

route('POST', '/api/budget/:month/copy-previous', ({ db, params }) => {
  const month = reqMonth(params.month);
  const src = one(db, 'SELECT month FROM budgets WHERE month < ? GROUP BY month ORDER BY month DESC LIMIT 1', month);
  if (!src) throw new HttpError(400, 'There is no earlier month with a budget to copy');
  const r = run(db, `INSERT INTO budgets (month, category_id, amount_cents)
                     SELECT ?, category_id, amount_cents FROM budgets WHERE month = ?
                     ON CONFLICT(month, category_id) DO UPDATE SET amount_cents = excluded.amount_cents`, month, src.month);
  return { copied: Number(r.changes), from: src.month };
});

route('POST', '/api/budget/:month/from-average', ({ db, params }) => {
  const month = reqMonth(params.month);
  const start = monthBounds(shiftMonth(month, -3)).start, end = monthBounds(shiftMonth(month, -1)).end;
  const rows = all(db, `SELECT t.category_id, SUM(t.amount_cents) / 3.0 AS avg FROM transactions t JOIN categories c ON c.id = t.category_id
                        WHERE t.type = 'expense' AND c.archived = 0 AND t.date BETWEEN ? AND ? GROUP BY t.category_id`, start, end);
  if (!rows.length) throw new HttpError(400, 'No spending in the last 3 months to average yet');
  inTx(db, () => {
    for (const r of rows) {
      const amt = Math.ceil(r.avg / 500) * 500; // round up to the next €5
      run(db, `INSERT INTO budgets (month, category_id, amount_cents) VALUES (?, ?, ?)
               ON CONFLICT(month, category_id) DO UPDATE SET amount_cents = excluded.amount_cents`, month, r.category_id, amt);
    }
  });
  return { set: rows.length };
});

route('POST', '/api/budget/:month/clear', ({ db, params }) => {
  const r = run(db, 'DELETE FROM budgets WHERE month = ?', reqMonth(params.month));
  return { cleared: Number(r.changes) };
});

// ---- goals
function goalBody(b) {
  return {
    name: str(b.name, 'name', { required: true, max: 60 }),
    kind: oneOf(b.kind || 'goal', 'kind', ['goal', 'sinking', 'emergency']),
    icon: iconName(str(b.icon, 'icon', { max: 30 })) || 'target',
    color: COLOR(b.color),
    target_cents: cents(b.target_cents ?? 0, 'target'),
    target_date: optDate(b.target_date, 'target date'),
    monthly_cents: cents(b.monthly_cents ?? 0, 'monthly contribution'),
    notes: str(b.notes, 'notes', { max: 2000 }),
    archived: bool(b.archived),
  };
}

route('GET', '/api/goals', ({ db }) => ({ goals: goalsData(db), emergency: emergencySuggestion(db, getSettings(db)) }));

route('POST', '/api/goals', ({ db, body }) => {
  const g = goalBody(body);
  const initial = body.initial_cents ? cents(body.initial_cents, 'starting amount') : 0;
  return inTx(db, () => {
    const r = run(db, 'INSERT INTO goals (name, kind, icon, color, target_cents, target_date, monthly_cents, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      g.name, g.kind, g.icon, g.color, g.target_cents, g.target_date, g.monthly_cents, g.notes);
    const id = Number(r.lastInsertRowid);
    if (initial > 0) run(db, 'INSERT INTO goal_entries (goal_id, date, amount_cents, note, initial) VALUES (?, ?, ?, ?, 1)', id, today(), initial, 'Already saved');
    return one(db, 'SELECT * FROM goals WHERE id = ?', id);
  });
});

route('PUT', '/api/goals/:id', ({ db, params, body }) => {
  const cur = mustExist(db, 'goals', params.id, 'Goal');
  const g = goalBody({ ...cur, ...body });
  run(db, 'UPDATE goals SET name=?, kind=?, icon=?, color=?, target_cents=?, target_date=?, monthly_cents=?, notes=?, archived=? WHERE id=?',
    g.name, g.kind, g.icon, g.color, g.target_cents, g.target_date, g.monthly_cents, g.notes, g.archived, cur.id);
  return one(db, 'SELECT * FROM goals WHERE id = ?', cur.id);
});

route('DELETE', '/api/goals/:id', ({ db, params }) => {
  mustExist(db, 'goals', params.id, 'Goal');
  run(db, 'DELETE FROM goals WHERE id = ?', Number(params.id));
  return { deleted: true };
});

route('GET', '/api/goals/:id/entries', ({ db, params }) => {
  mustExist(db, 'goals', params.id, 'Goal');
  return all(db, 'SELECT * FROM goal_entries WHERE goal_id = ? ORDER BY date DESC, id DESC', Number(params.id));
});

route('POST', '/api/goals/:id/entries', ({ db, params, body }) => {
  const g = mustExist(db, 'goals', params.id, 'Goal');
  const amount = cents(body.amount_cents, 'amount', { allowNegative: true });
  if (amount === 0) throw new HttpError(400, 'Amount cannot be zero');
  if (amount < 0) {
    const saved = scalar(db, 'SELECT COALESCE(SUM(amount_cents),0) FROM goal_entries WHERE goal_id = ?', g.id);
    if (saved + amount < 0) throw new HttpError(400, 'You cannot withdraw more than is saved in this goal');
  }
  const r = run(db, 'INSERT INTO goal_entries (goal_id, date, amount_cents, note) VALUES (?, ?, ?, ?)',
    g.id, reqDate(body.date || today()), amount, str(body.note, 'note', { max: 200 }));
  return one(db, 'SELECT * FROM goal_entries WHERE id = ?', r.lastInsertRowid);
});

route('DELETE', '/api/goal-entries/:id', ({ db, params }) => {
  mustExist(db, 'goal_entries', params.id, 'Entry');
  run(db, 'DELETE FROM goal_entries WHERE id = ?', Number(params.id));
  return { deleted: true };
});

// ---- investments
route('GET', '/api/investments', ({ db }) => {
  const p = computePortfolio(db);
  const snaps = all(db, 'SELECT * FROM portfolio_snapshots ORDER BY date');
  const lastUpdate = one(db, "SELECT MAX(price_updated_at) AS t FROM holdings WHERE archived = 0 AND price_source != 'manual'")?.t;
  const needsPrices = scalar(db, "SELECT COUNT(*) FROM holdings WHERE archived = 0 AND price_source != 'manual'") > 0;
  const stale = needsPrices && (!lastUpdate || Date.now() - Date.parse(lastUpdate) > 15 * 60_000);
  const monthly = monthsBack(currentMonth(), 12).map((m) => {
    const b = monthBounds(m);
    return { month: m, net_cents: investNet(db, b.start, b.end) };
  });
  return { ...p, snapshots: snaps, last_update: lastUpdate, stale, monthly, plan_cents: sNum(getSettings(db), 'monthly_invest_plan_cents') };
});

// Weekly portfolio value over time: what you held on each date × that date's market price.
const HISTORY_RANGES = { '6mo': [182, 180], '1y': [365, 365], '2y': [730, 365], '5y': [1826, 365] }; // [days, max coingecko days]
const historyCache = new Map();
route('GET', '/api/investments/history', async ({ db, query }) => {
  const range = HISTORY_RANGES[query.range] ? query.range : '1y';
  const holdings = all(db, 'SELECT * FROM holdings WHERE archived = 0');
  const txs = all(db, 'SELECT * FROM investment_tx ORDER BY date, id');
  if (!txs.length || !holdings.length) return { points: [], errors: [] };
  const key = `${range}|${txs.length}|${txs[txs.length - 1].id}|${holdings.map((h) => h.id + h.symbol + h.price_source).join(',')}`;
  const hit = historyCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.data;

  const [days, cgDays] = HISTORY_RANGES[range];
  const todayStr = today();
  let start = addDays(todayStr, -days);
  if (txs[0].date > start) start = txs[0].date;
  const errors = [];
  const series = new Map();
  await Promise.all(holdings.map(async (h) => {
    try {
      if (h.price_source === 'yahoo') series.set(h.id, await yahooHistory(h.symbol, range));
      else if (h.price_source === 'coingecko') series.set(h.id, await coingeckoHistory(h.source_id || h.symbol.toLowerCase(), Math.min(days, cgDays)));
    } catch (e) { errors.push({ symbol: h.symbol, error: String(e.message || e) }); }
  }));

  const dates = [];
  for (let d = start; d < todayStr; d = addDays(d, 7)) dates.push(d);
  dates.push(todayStr);
  const points = dates.map((date) => {
    let value = 0, cost = 0;
    for (const h of holdings) {
      let qty = 0, c = 0, lastTradePrice = null;
      for (const t of txs) {
        if (t.holding_id !== h.id || t.date > date) continue;
        if (t.kind === 'buy') { qty += t.quantity; c += t.total_cents; lastTradePrice = t.price; }
        else if (t.kind === 'sell') { const avg = qty > 0 ? c / qty : 0; const q = Math.min(qty, t.quantity); c -= avg * q; qty -= q; lastTradePrice = t.price; }
      }
      if (qty < 1e-9) continue;
      let price = null;
      if (date === todayStr && typeof h.last_price === 'number') price = h.last_price;
      else {
        const s = series.get(h.id);
        if (s) for (const [d, p] of s) { if (d <= date) price = p; else break; }
      }
      if (price === null) price = lastTradePrice ?? (c / qty / 100);
      value += qty * price * 100;
      cost += c;
    }
    return { date, value_cents: Math.round(value), cost_cents: Math.round(cost) };
  });
  const data = { points, errors, range };
  if (!errors.length) historyCache.set(key, { at: Date.now(), data });
  return data;
});

function holdingBody(b) {
  const source = oneOf(b.price_source || 'yahoo', 'price source', ['yahoo', 'coingecko', 'manual']);
  return {
    symbol: str(b.symbol, 'symbol', { required: true, max: 30 }).toUpperCase(),
    name: str(b.name, 'name', { max: 120 }),
    asset_type: oneOf(b.asset_type || 'etf', 'asset type', ['stock', 'etf', 'crypto', 'bond', 'fund', 'other']),
    price_source: source,
    source_id: source === 'coingecko' ? str(b.source_id || b.symbol, 'coin id', { required: true, max: 80 }).toLowerCase() : '',
    notes: str(b.notes, 'notes', { max: 2000 }),
  };
}

const priceOrNull = (v) => (v === undefined || v === '' || v === null ? null : num(v, 'price', { min: 0 }));

route('POST', '/api/holdings', async ({ db, body }) => {
  const h = holdingBody(body);
  const manualPrice = priceOrNull(body.manual_price);
  const r = run(db, `INSERT INTO holdings (symbol, name, asset_type, price_source, source_id, notes, last_price, native_price, native_currency, price_updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'EUR', ?)`,
  h.symbol, h.name, h.asset_type, h.price_source, h.source_id, h.notes, manualPrice, manualPrice, manualPrice !== null ? new Date().toISOString() : null);
  const id = Number(r.lastInsertRowid);
  let priceError = null;
  if (h.price_source !== 'manual') {
    try {
      const res = await refreshPrices(db);
      priceError = res.errors.find((e) => e.symbol === h.symbol)?.error || null;
    } catch (e) { priceError = String(e.message || e); }
  }
  return { ...one(db, 'SELECT * FROM holdings WHERE id = ?', id), price_error: priceError };
});

route('PUT', '/api/holdings/:id', ({ db, params, body }) => {
  const cur = mustExist(db, 'holdings', params.id, 'Holding');
  const h = holdingBody({ ...cur, ...body });
  run(db, 'UPDATE holdings SET symbol=?, name=?, asset_type=?, price_source=?, source_id=?, notes=?, archived=? WHERE id=?',
    h.symbol, h.name, h.asset_type, h.price_source, h.source_id, h.notes, body.archived === undefined ? cur.archived : bool(body.archived), cur.id);
  const p = priceOrNull(body.manual_price);
  if (p !== null) {
    run(db, "UPDATE holdings SET last_price=?, native_price=?, native_currency='EUR', day_change_pct=NULL, price_updated_at=?, price_error=NULL WHERE id=?", p, p, new Date().toISOString(), cur.id);
  }
  snapshotPortfolio(db);
  return one(db, 'SELECT * FROM holdings WHERE id = ?', cur.id);
});

route('DELETE', '/api/holdings/:id', ({ db, params }) => {
  mustExist(db, 'holdings', params.id, 'Holding');
  run(db, 'DELETE FROM holdings WHERE id = ?', Number(params.id));
  snapshotPortfolio(db);
  return { deleted: true };
});

route('GET', '/api/holdings/:id/tx', ({ db, params }) => {
  mustExist(db, 'holdings', params.id, 'Holding');
  return all(db, 'SELECT * FROM investment_tx WHERE holding_id = ? ORDER BY date DESC, id DESC', Number(params.id));
});

route('POST', '/api/investment-tx', ({ db, body }) => {
  const h = mustExist(db, 'holdings', body.holding_id, 'Holding');
  const kind = oneOf(body.kind, 'kind', ['buy', 'sell', 'dividend']);
  const date = reqDate(body.date || today());
  const fees = cents(body.fees_cents || 0, 'fees');
  let quantity = 0, price = 0, total;
  if (kind === 'dividend') {
    total = cents(body.total_cents, 'amount');
    if (total <= 0) throw new HttpError(400, 'Dividend amount must be positive');
  } else {
    quantity = num(body.quantity, 'quantity', { min: 0 });
    price = num(body.price, 'price', { min: 0 });
    if (quantity <= 0) throw new HttpError(400, 'Quantity must be positive');
    const gross = Math.round(quantity * price * 100);
    total = kind === 'buy' ? gross + fees : gross - fees;
    if (kind === 'sell') {
      const held = computePortfolio(db, { includeArchived: true }).items.find((x) => x.id === h.id)?.quantity || 0;
      if (quantity > held + 1e-9) throw new HttpError(400, `You only hold ${+held.toFixed(8)} ${h.symbol}`);
    }
  }
  const r = run(db, 'INSERT INTO investment_tx (holding_id, date, kind, quantity, price, fees_cents, total_cents, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    h.id, date, kind, quantity, price, fees, total, str(body.note, 'note', { max: 200 }));
  // A holding without any price yet (manual, or offline) uses the trade price until a real quote arrives.
  if (h.last_price === null && kind !== 'dividend' && price > 0) {
    run(db, "UPDATE holdings SET last_price = ?, native_price = ?, native_currency = 'EUR' WHERE id = ?", price, price, h.id);
  }
  snapshotPortfolio(db);
  return one(db, 'SELECT * FROM investment_tx WHERE id = ?', r.lastInsertRowid);
});

route('DELETE', '/api/investment-tx/:id', ({ db, params }) => {
  mustExist(db, 'investment_tx', params.id, 'Investment transaction');
  run(db, 'DELETE FROM investment_tx WHERE id = ?', Number(params.id));
  snapshotPortfolio(db);
  return { deleted: true };
});

route('POST', '/api/prices/refresh', async ({ db }) => {
  const r = await refreshPrices(db);
  snapshotPortfolio(db);
  return r;
});

route('GET', '/api/symbol-search', async ({ query }) => {
  const q = str(query.q, 'query', { required: true, max: 60 });
  return searchSymbols(q);
});

// ---- recurring
function recurringBody(db, b) {
  const type = oneOf(b.type || 'expense', 'type', ['income', 'expense']);
  const next = reqDate(b.next_due, 'next due date');
  return {
    name: str(b.name, 'name', { required: true, max: 80 }),
    type,
    amount_cents: cents(b.amount_cents),
    category_id: categoryOrNull(db, b.category_id, type),
    frequency: oneOf(b.frequency || 'monthly', 'frequency', ['weekly', 'biweekly', 'monthly', 'quarterly', 'semiannual', 'yearly']),
    next_due: next,
    anchor_day: Number(next.slice(8, 10)),
    autopay: bool(b.autopay),
    subscription: bool(b.subscription),
    active: b.active === undefined ? 1 : bool(b.active),
    icon: iconName(str(b.icon, 'icon', { max: 30 })),
    notes: str(b.notes, 'notes', { max: 2000 }),
  };
}

route('GET', '/api/recurring', ({ db }) => {
  const items = all(db, `SELECT r.*, c.name AS category_name, c.icon AS category_icon, c.color AS category_color
                         FROM recurring r LEFT JOIN categories c ON c.id = r.category_id ORDER BY r.active DESC, r.next_due`)
    .map((r) => ({ ...r, monthly_cents: monthlyEquivalent(r), last_paid: one(db, 'SELECT MAX(date) AS d FROM transactions WHERE recurring_id = ?', r.id)?.d || null }));
  const active = items.filter((r) => r.active);
  const sum = (arr) => arr.reduce((a, r) => a + r.monthly_cents, 0);
  return {
    items,
    upcoming: upcoming(db, 45),
    totals: {
      bills_monthly_cents: sum(active.filter((r) => r.type === 'expense' && !r.subscription)),
      subs_monthly_cents: sum(active.filter((r) => r.type === 'expense' && r.subscription)),
      income_monthly_cents: sum(active.filter((r) => r.type === 'income')),
    },
  };
});

route('POST', '/api/recurring', ({ db, body }) => {
  const r = recurringBody(db, body);
  const res = run(db, `INSERT INTO recurring (name, type, amount_cents, category_id, frequency, next_due, anchor_day, autopay, subscription, active, icon, notes)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  r.name, r.type, r.amount_cents, r.category_id, r.frequency, r.next_due, r.anchor_day, r.autopay, r.subscription, r.active, r.icon, r.notes);
  const created = processDue(db);
  return { ...one(db, 'SELECT * FROM recurring WHERE id = ?', res.lastInsertRowid), auto_posted: created };
});

route('PUT', '/api/recurring/:id', ({ db, params, body }) => {
  const cur = mustExist(db, 'recurring', params.id, 'Recurring item');
  const r = recurringBody(db, { ...cur, ...body });
  run(db, `UPDATE recurring SET name=?, type=?, amount_cents=?, category_id=?, frequency=?, next_due=?, anchor_day=?, autopay=?, subscription=?, active=?, icon=?, notes=? WHERE id=?`,
    r.name, r.type, r.amount_cents, r.category_id, r.frequency, r.next_due, r.anchor_day, r.autopay, r.subscription, r.active, r.icon, r.notes, cur.id);
  const created = processDue(db);
  return { ...one(db, 'SELECT * FROM recurring WHERE id = ?', cur.id), auto_posted: created };
});

route('DELETE', '/api/recurring/:id', ({ db, params }) => {
  mustExist(db, 'recurring', params.id, 'Recurring item');
  run(db, 'DELETE FROM recurring WHERE id = ?', Number(params.id));
  return { deleted: true };
});

route('POST', '/api/recurring/:id/pay', ({ db, params, body }) => {
  const item = mustExist(db, 'recurring', params.id, 'Recurring item');
  const date = reqDate(body.date || item.next_due);
  const amount = body.amount_cents === undefined ? item.amount_cents : cents(body.amount_cents);
  return inTx(db, () => {
    const txId = postOccurrence(db, item, date, amount);
    const next = advanceItem(db, item);
    return { transaction_id: txId, next_due: next };
  });
});

route('POST', '/api/recurring/:id/skip', ({ db, params }) => {
  const item = mustExist(db, 'recurring', params.id, 'Recurring item');
  return { next_due: advanceItem(db, item) };
});

// ---- debts
function debtBody(b) {
  const balance = cents(b.balance_cents, 'balance');
  return {
    name: str(b.name, 'name', { required: true, max: 80 }),
    kind: oneOf(b.kind || 'loan', 'type', ['loan', 'credit_card', 'student', 'car', 'mortgage', 'personal', 'other']),
    balance_cents: balance,
    original_cents: Math.max(balance, cents(b.original_cents || balance, 'original amount')),
    apr: num(b.apr ?? 0, 'interest rate', { min: 0, max: 200 }),
    min_payment_cents: cents(b.min_payment_cents ?? 0, 'minimum payment'),
    due_day: b.due_day ? num(b.due_day, 'due day', { min: 1, max: 31 }) : null,
    notes: str(b.notes, 'notes', { max: 2000 }),
    archived: bool(b.archived),
  };
}

route('GET', '/api/debts', ({ db }) => {
  const debts = all(db, 'SELECT * FROM debts ORDER BY archived, id').map((d) => ({
    ...d,
    paid_cents: scalar(db, 'SELECT COALESCE(SUM(amount_cents),0) FROM debt_payments WHERE debt_id = ?', d.id),
    progress: d.original_cents > 0 ? Math.min(1, Math.max(0, (d.original_cents - d.balance_cents) / d.original_cents)) : 0,
    last_payment: one(db, 'SELECT MAX(date) AS d FROM debt_payments WHERE debt_id = ?', d.id)?.d || null,
  }));
  return { debts };
});

route('POST', '/api/debts', ({ db, body }) => {
  const d = debtBody(body);
  const r = run(db, 'INSERT INTO debts (name, kind, balance_cents, original_cents, apr, min_payment_cents, due_day, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    d.name, d.kind, d.balance_cents, d.original_cents, d.apr, d.min_payment_cents, d.due_day, d.notes);
  return one(db, 'SELECT * FROM debts WHERE id = ?', r.lastInsertRowid);
});

route('PUT', '/api/debts/:id', ({ db, params, body }) => {
  const cur = mustExist(db, 'debts', params.id, 'Debt');
  const d = debtBody({ ...cur, ...body });
  run(db, 'UPDATE debts SET name=?, kind=?, balance_cents=?, original_cents=?, apr=?, min_payment_cents=?, due_day=?, notes=?, archived=? WHERE id=?',
    d.name, d.kind, d.balance_cents, d.original_cents, d.apr, d.min_payment_cents, d.due_day, d.notes, d.archived, cur.id);
  return one(db, 'SELECT * FROM debts WHERE id = ?', cur.id);
});

route('DELETE', '/api/debts/:id', ({ db, params }) => {
  mustExist(db, 'debts', params.id, 'Debt');
  run(db, 'DELETE FROM debts WHERE id = ?', Number(params.id));
  return { deleted: true };
});

route('GET', '/api/debts/:id/payments', ({ db, params }) => {
  mustExist(db, 'debts', params.id, 'Debt');
  return all(db, 'SELECT * FROM debt_payments WHERE debt_id = ? ORDER BY date DESC, id DESC', Number(params.id));
});

route('POST', '/api/debts/:id/payments', ({ db, params, body }) => {
  const d = mustExist(db, 'debts', params.id, 'Debt');
  const amount = cents(body.amount_cents, 'amount');
  if (amount <= 0) throw new HttpError(400, 'Payment must be positive');
  const date = reqDate(body.date || today());
  return inTx(db, () => {
    let txId = null;
    if (body.log_expense !== false) {
      const cat = one(db, "SELECT id FROM categories WHERE kind = 'expense' AND name = 'Debt payments' AND archived = 0");
      txId = Number(run(db, "INSERT INTO transactions (date, type, amount_cents, category_id, description, source) VALUES (?, 'expense', ?, ?, ?, 'debt')",
        date, amount, cat?.id ?? null, `Payment: ${d.name}`).lastInsertRowid);
    }
    run(db, 'INSERT INTO debt_payments (debt_id, date, amount_cents, transaction_id, note) VALUES (?, ?, ?, ?, ?)', d.id, date, amount, txId, str(body.note, 'note', { max: 200 }));
    run(db, 'UPDATE debts SET balance_cents = MAX(0, balance_cents - ?) WHERE id = ?', amount, d.id);
    return one(db, 'SELECT * FROM debts WHERE id = ?', d.id);
  });
});

route('DELETE', '/api/debt-payments/:id', ({ db, params }) => {
  const p = mustExist(db, 'debt_payments', params.id, 'Payment');
  inTx(db, () => {
    run(db, 'UPDATE debts SET balance_cents = balance_cents + ? WHERE id = ?', p.amount_cents, p.debt_id);
    if (p.transaction_id) run(db, 'DELETE FROM transactions WHERE id = ?', p.transaction_id);
    run(db, 'DELETE FROM debt_payments WHERE id = ?', p.id);
  });
  return { deleted: true };
});

// ---- import
const importHash = (date, amount, type, desc) => crypto.createHash('sha1').update(`${date}|${amount}|${type}|${normDesc(desc)}`).digest('hex');

route('POST', '/api/import/preview', ({ db, body }) => {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (rows.length > 20000) throw new HttpError(400, 'Too many rows (max 20,000 per import)');
  const seen = new Set();
  return {
    rows: rows.map((r, i) => {
      const errors = [];
      if (!isDate(r.date)) errors.push('Invalid date');
      const amt = Number(r.amount_cents);
      if (!Number.isInteger(amt) || amt === 0) errors.push('Invalid amount');
      const type = amt < 0 ? 'expense' : 'income';
      const abs = Math.abs(amt);
      const description = String(r.description || '').trim().slice(0, 200);
      const hash = errors.length ? null : importHash(r.date, abs, type, description);
      let duplicate = false;
      if (hash) {
        duplicate = seen.has(hash)
          || !!one(db, 'SELECT 1 FROM transactions WHERE import_hash = ? LIMIT 1', hash)
          || !!one(db, 'SELECT 1 FROM transactions WHERE date = ? AND amount_cents = ? AND type = ? LIMIT 1', r.date, abs, type);
        seen.add(hash);
      }
      return { index: i, date: r.date, description, amount_cents: abs, type, category_id: errors.length ? null : suggestCategory(db, description, type), duplicate, errors };
    }),
  };
});

route('POST', '/api/import/commit', ({ db, body }) => {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) throw new HttpError(400, 'Nothing to import');
  return inTx(db, () => {
    let imported = 0;
    for (const r of rows) {
      const type = oneOf(r.type, 'type', ['income', 'expense']);
      const date = reqDate(r.date);
      const amount = cents(r.amount_cents);
      const description = str(r.description, 'description', { max: 200 });
      run(db, "INSERT INTO transactions (date, type, amount_cents, category_id, description, source, import_hash) VALUES (?, ?, ?, ?, ?, 'import', ?)",
        date, type, amount, categoryOrNull(db, r.category_id, type), description, importHash(date, amount, type, description));
      imported++;
    }
    let rulesAdded = 0;
    for (const rule of Array.isArray(body.rules) ? body.rules : []) {
      const pattern = str(rule.pattern, 'pattern', { max: 60 }).toLowerCase();
      if (pattern.length < 3) continue;
      const cat = categoryOrNull(db, rule.category_id);
      if (!cat || one(db, 'SELECT 1 FROM rules WHERE pattern = ?', pattern)) continue;
      run(db, 'INSERT INTO rules (pattern, category_id) VALUES (?, ?)', pattern, cat);
      rulesAdded++;
    }
    return { imported, rules_added: rulesAdded };
  });
});

// ---- rules
route('GET', '/api/rules', ({ db }) => all(db, `SELECT r.*, c.name AS category_name, c.icon AS category_icon FROM rules r
                                              JOIN categories c ON c.id = r.category_id ORDER BY r.pattern`));
route('POST', '/api/rules', ({ db, body }) => {
  const pattern = str(body.pattern, 'pattern', { required: true, max: 60 }).toLowerCase();
  const cat = categoryOrNull(db, body.category_id);
  if (!cat) throw new HttpError(400, 'Pick a category');
  if (one(db, 'SELECT 1 FROM rules WHERE pattern = ?', pattern)) throw new HttpError(400, 'A rule with that text already exists');
  const r = run(db, 'INSERT INTO rules (pattern, category_id) VALUES (?, ?)', pattern, cat);
  let applied = 0;
  if (body.apply_existing) {
    const c = one(db, 'SELECT kind FROM categories WHERE id = ?', cat);
    applied = Number(run(db, 'UPDATE transactions SET category_id = ? WHERE category_id IS NULL AND type = ? AND LOWER(description) LIKE ?', cat, c.kind, `%${pattern}%`).changes);
  }
  return { ...one(db, 'SELECT * FROM rules WHERE id = ?', r.lastInsertRowid), applied };
});
route('DELETE', '/api/rules/:id', ({ db, params }) => {
  mustExist(db, 'rules', params.id, 'Rule');
  run(db, 'DELETE FROM rules WHERE id = ?', Number(params.id));
  return { deleted: true };
});

// ---- dashboard & reports
route('GET', '/api/dashboard', ({ db, query }) => dashboardData(db, isMonth(query.month) ? query.month : currentMonth()));

route('GET', '/api/reports/overview', ({ db, query }) => {
  const end = isMonth(query.end) ? query.end : currentMonth();
  const count = Math.min(36, Math.max(3, Number(query.months) || 12));
  const months = monthsBack(end, count);
  const s = getSettings(db);
  const series = months.map((m) => {
    const b = monthBounds(m);
    const income = sumTx(db, 'income', b.start, b.end), expense = sumTx(db, 'expense', b.start, b.end);
    return { month: m, income_cents: income, expense_cents: expense, saved_cents: goalNet(db, b.start, b.end), invested_cents: investNet(db, b.start, b.end), net_cents: income - expense };
  });
  const from = monthBounds(months[0]).start, to = monthBounds(end).end;
  const categories = all(db, `SELECT t.category_id AS id, COALESCE(c.name,'Uncategorized') AS name, COALESCE(c.icon,'help') AS icon, COALESCE(c.color,'#52525b') AS color,
                                     c.grp, SUM(t.amount_cents) AS total_cents
                              FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
                              WHERE t.type='expense' AND t.date BETWEEN ? AND ? GROUP BY t.category_id ORDER BY total_cents DESC`, from, to);
  const catMonthly = all(db, `SELECT t.category_id AS id, substr(t.date,1,7) AS month, SUM(t.amount_cents) AS total
                              FROM transactions t WHERE t.type='expense' AND t.date BETWEEN ? AND ? GROUP BY t.category_id, month`, from, to);
  const payees = all(db, `SELECT MIN(description) AS description, COUNT(*) AS n, SUM(amount_cents) AS total_cents FROM transactions
                          WHERE type='expense' AND description != '' AND date BETWEEN ? AND ?
                          GROUP BY LOWER(description) ORDER BY total_cents DESC LIMIT 10`, from, to);
  const totIncome = series.reduce((a, x) => a + x.income_cents, 0);
  const totExpense = series.reduce((a, x) => a + x.expense_cents, 0);
  // Average only over months since tracking started, so empty months before that don't drag the average down.
  const firstActive = series.findIndex((x) => x.income_cents || x.expense_cents);
  const activeMonths = firstActive < 0 ? count : count - firstActive;
  return {
    months, series, categories, cat_monthly: catMonthly, payees,
    totals: {
      income_cents: totIncome, expense_cents: totExpense, active_months: activeMonths,
      saved_cents: series.reduce((a, x) => a + x.saved_cents, 0), invested_cents: series.reduce((a, x) => a + x.invested_cents, 0),
      avg_income_cents: Math.round(totIncome / activeMonths), avg_expense_cents: Math.round(totExpense / activeMonths),
      savings_rate: totIncome > 0 ? (totIncome - totExpense) / totIncome : null,
    },
    net_worth: netWorthHistory(db, s, months),
  };
});

route('GET', '/api/reports/annual', ({ db, query }) => {
  const year = Number(query.year) || Number(today().slice(0, 4));
  const rows = all(db, `SELECT t.type, t.category_id AS id, COALESCE(c.name,'Uncategorized') AS name, COALESCE(c.icon,'help') AS icon,
                               CAST(substr(t.date,6,2) AS INTEGER) AS m, SUM(t.amount_cents) AS total
                        FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
                        WHERE substr(t.date,1,4) = ? GROUP BY t.type, t.category_id, m`, String(year));
  const build = (type) => {
    const map = new Map();
    for (const r of rows.filter((x) => x.type === type)) {
      if (!map.has(r.id)) map.set(r.id, { id: r.id, name: r.name, icon: r.icon, months: new Array(12).fill(0), total: 0 });
      const e = map.get(r.id);
      e.months[r.m - 1] += r.total;
      e.total += r.total;
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  };
  const income = build('income'), expense = build('expense');
  const colTotals = (list) => list.reduce((acc, r) => acc.map((v, i) => v + r.months[i]), new Array(12).fill(0));
  const years = all(db, 'SELECT DISTINCT substr(date,1,4) AS y FROM transactions ORDER BY y DESC').map((r) => Number(r.y));
  if (!years.includes(year)) years.unshift(year);
  years.sort((a, b) => b - a);
  return { year, years, income, expense, income_totals: colTotals(income), expense_totals: colTotals(expense) };
});

route('GET', '/api/networth', ({ db }) => netWorthNow(db, getSettings(db)));

// ---- data management
route('GET', '/api/backup', ({ db }) => {
  const tables = Object.fromEntries(TABLES.map((t) => [t, all(db, `SELECT * FROM ${t}`)]));
  return { raw: { status: 200, headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="moneta-backup-${today()}.json"` }, body: JSON.stringify({ app: 'moneta', version: 1, exported_at: new Date().toISOString(), tables }) } };
});

function wipe(db) {
  for (const t of [...TABLES].reverse()) run(db, `DELETE FROM ${t}`);
  run(db, 'DELETE FROM sqlite_sequence');
}

route('POST', '/api/restore', ({ db, body }) => {
  if (!body || body.app !== 'moneta' || typeof body.tables !== 'object' || !body.tables) throw new HttpError(400, 'This file is not a Moneta backup');
  inTx(db, () => {
    db.exec('PRAGMA defer_foreign_keys = ON');
    wipe(db);
    for (const t of TABLES) {
      const rows = body.tables[t];
      if (!Array.isArray(rows) || !rows.length) continue;
      const cols = all(db, `PRAGMA table_info(${t})`).map((c) => c.name);
      for (const row of rows) {
        const keys = Object.keys(row).filter((k) => cols.includes(k));
        if (!keys.length) continue;
        run(db, `INSERT INTO ${t} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
          ...keys.map((k) => (typeof row[k] === 'boolean' ? Number(row[k]) : row[k] === undefined ? null : row[k])));
      }
    }
    seedDefaults(db);
    migrate(db);
  });
  return { restored: true };
});

route('POST', '/api/reset', ({ db, body }) => {
  if (body.confirm !== 'DELETE') throw new HttpError(400, 'Type DELETE to confirm');
  inTx(db, () => { wipe(db); seedDefaults(db); });
  return { reset: true };
});

route('POST', '/api/demo', ({ db }) => {
  if (scalar(db, 'SELECT COUNT(*) FROM transactions') > 0) throw new HttpError(400, 'Demo data can only be loaded into an empty tracker. Erase your data first.');
  inTx(db, () => loadDemo(db));
  processDue(db);
  snapshotPortfolio(db);
  return { loaded: true };
});

// ------------------------------------------------------------------ dispatcher
let lastProcessed = 0;
export async function handleApi(db, method, pathname, query, body) {
  if (Date.now() - lastProcessed > 60_000) {
    lastProcessed = Date.now();
    try { processDue(db); } catch (e) { console.error('processDue failed:', e); }
  }
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = pathname.match(r.re);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    return r.handler({ db, params, query, body: body || {} });
  }
  throw new HttpError(404, `No route for ${method} ${pathname}`);
}

export { budgetData, dashboardData, computePortfolio, goalsData, netWorthNow };
