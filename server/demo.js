// Synthetic demo data covering the last ~6 months, so every screen can be explored before entering real data.
import { currentMonth, shiftMonth, monthBounds, today, addDays } from './util.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

export function loadDemo(db) {
  const rand = rng(42);
  const between = (a, b) => Math.round((a + rand() * (b - a)) * 100); // euros -> cents
  const cat = Object.fromEntries(db.prepare('SELECT id, name FROM categories').all().map((c) => [c.name, c.id]));
  const t = today();
  const startMonth = shiftMonth(currentMonth(), -5);
  const months = Array.from({ length: 6 }, (_, i) => shiftMonth(startMonth, i));
  const insTx = db.prepare('INSERT INTO transactions (date, type, amount_cents, category_id, description, source) VALUES (?, ?, ?, ?, ?, ?)');
  const add = (date, type, amount, category, description) => {
    if (date <= t) insTx.run(date, type, amount, cat[category] ?? null, description, 'manual');
  };
  const day = (m, d) => `${m}-${String(Math.min(d, monthBounds(m).days)).padStart(2, '0')}`;

  // settings
  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  set.run('expected_income_cents', '290000');
  set.run('monthly_invest_plan_cents', '25000');
  set.run('starting_balance_cents', '250000');
  set.run('starting_balance_date', `${startMonth}-01`);

  // recurring (autopay items are posted by processDue right after this runs)
  const insRec = db.prepare(`INSERT INTO recurring (name, type, amount_cents, category_id, frequency, next_due, anchor_day, autopay, subscription, icon)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const rec = (name, type, amount, category, freq, first, autopay, sub, icon = '') =>
    insRec.run(name, type, amount, cat[category] ?? null, freq, first, Number(first.slice(8)), autopay, sub, icon);
  rec('Salary', 'income', 290000, 'Salary', 'monthly', day(startMonth, 25), 1, 0, 'briefcase');
  rec('Rent', 'expense', 75000, 'Housing', 'monthly', day(startMonth, 1), 1, 0, 'home');
  rec('Internet', 'expense', 3499, 'Phone & Internet', 'monthly', day(startMonth, 5), 1, 0, 'wifi');
  rec('Mobile plan', 'expense', 1999, 'Phone & Internet', 'monthly', day(startMonth, 12), 1, 0, 'phone');
  rec('Spotify', 'expense', 1099, 'Subscriptions', 'monthly', day(startMonth, 8), 1, 1, 'headphones');
  rec('Netflix', 'expense', 1399, 'Subscriptions', 'monthly', day(startMonth, 17), 1, 1, 'film');
  rec('Gym membership', 'expense', 2990, 'Health', 'monthly', day(startMonth, 3), 1, 1, 'dumbbell');
  rec('Electricity', 'expense', 6500, 'Utilities', 'monthly', day(currentMonth(), 20), 0, 0, 'bolt');
  rec('Car insurance', 'expense', 48000, 'Insurance', 'yearly', addDays(t, 40), 0, 0, 'car');
  rec('iCloud+', 'expense', 299, 'Subscriptions', 'monthly', day(startMonth, 14), 1, 1, 'cloud');

  // day-to-day spending
  const groceries = ['Lidl', 'Aldi', 'Rewe', 'Edeka', 'Albert Heijn'];
  const dining = ['Pizzeria Roma', 'Sushi Bar', 'Coffee Lab', 'Burger House', 'Thai Garden', 'Kebab corner'];
  const shopping = ['Zara', 'Amazon', 'IKEA', 'H&M', 'MediaMarkt'];
  const fun = ['Cinema', 'Concert tickets', 'Steam', 'Bowling'];
  for (const m of months) {
    const { days } = monthBounds(m);
    for (let d = 2; d <= days; d += 3 + Math.floor(rand() * 2)) add(day(m, d), 'expense', between(18, 85), 'Groceries', groceries[Math.floor(rand() * groceries.length)]);
    const nDining = 4 + Math.floor(rand() * 4);
    for (let i = 0; i < nDining; i++) add(day(m, 1 + Math.floor(rand() * days)), 'expense', between(9, 48), 'Dining out', dining[Math.floor(rand() * dining.length)]);
    add(day(m, 2), 'expense', 4900, 'Transport', 'Monthly transit pass');
    if (rand() > 0.4) add(day(m, 10 + Math.floor(rand() * 10)), 'expense', between(15, 60), 'Transport', 'Taxi / ride share');
    const nShop = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < nShop; i++) add(day(m, 1 + Math.floor(rand() * days)), 'expense', between(20, 140), 'Shopping', shopping[Math.floor(rand() * shopping.length)]);
    add(day(m, 6 + Math.floor(rand() * 20)), 'expense', between(12, 70), 'Entertainment', fun[Math.floor(rand() * fun.length)]);
    if (rand() > 0.5) add(day(m, 15), 'expense', between(15, 45), 'Personal care', 'Barber');
    if (m !== currentMonth()) add(day(m, 20), 'expense', between(55, 95), 'Utilities', 'Electricity');
    if (rand() > 0.6) add(day(m, 18), 'income', between(80, 300), 'Side income', 'Freelance gig');
  }
  add(day(months[3], 9), 'expense', 32000, 'Travel', 'Weekend in Lisbon');
  add(day(months[4], 27), 'expense', 6500, 'Gifts & Donations', 'Birthday present');
  add(day(months[5], 4), 'expense', 4200, 'Health', 'Pharmacy');
  insTx.run(day(months[5], Math.min(6, Number(t.slice(8)))), 'expense', 2350, null, 'Card payment 4471', 'manual');

  // budgets (category limits)
  const budget = { Housing: 75000, Utilities: 9000, Groceries: 32000, Transport: 8000, 'Phone & Internet': 5500, Health: 5000,
    'Dining out': 15000, Entertainment: 6000, Shopping: 15000, Subscriptions: 3000, 'Personal care': 3000, 'Debt payments': 15500 };
  const insB = db.prepare('INSERT INTO budgets (month, category_id, amount_cents) VALUES (?, ?, ?)');
  for (const m of months) for (const [name, amt] of Object.entries(budget)) insB.run(m, cat[name], amt);

  // savings goals
  const insG = db.prepare('INSERT INTO goals (name, kind, icon, color, target_cents, target_date, monthly_cents, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insE = db.prepare('INSERT INTO goal_entries (goal_id, date, amount_cents, note) VALUES (?, ?, ?, ?)');
  const nextYear = Number(t.slice(0, 4)) + 1;
  const trip = Number(insG.run('Trip to Japan', 'goal', 'plane', '#22d3ee', 350000, `${nextYear}-06-01`, 25000, 'Two weeks: Tokyo, Kyoto, Osaka').lastInsertRowid);
  const emergency = Number(insG.run('Emergency fund', 'emergency', 'lifebuoy', '#34d399', 600000, null, 20000, '').lastInsertRowid);
  const laptop = Number(insG.run('New laptop', 'sinking', 'laptop', '#a78bfa', 160000, `${nextYear}-02-01`, 10000, '').lastInsertRowid);
  db.prepare('INSERT INTO goal_entries (goal_id, date, amount_cents, note, initial) VALUES (?, ?, ?, ?, 1)').run(emergency, `${startMonth}-01`, 120000, 'Already saved');
  for (const m of months) {
    insE.run(trip, day(m, 26), 25000, 'Monthly transfer');
    insE.run(emergency, day(m, 26), 20000, 'Monthly transfer');
    if (m !== months[0]) insE.run(laptop, day(m, 26), 10000, 'Monthly transfer');
  }
  db.prepare('DELETE FROM goal_entries WHERE date > ?').run(t);

  // investments
  const insH = db.prepare(`INSERT INTO holdings (symbol, name, asset_type, price_source, source_id, last_price, native_price, native_currency)
                           VALUES (?, ?, ?, ?, ?, ?, ?, 'EUR')`);
  const insI = db.prepare('INSERT INTO investment_tx (holding_id, date, kind, quantity, price, fees_cents, total_cents, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const vwce = Number(insH.run('VWCE.DE', 'Vanguard FTSE All-World UCITS ETF (Acc)', 'etf', 'yahoo', '', 172.5, 172.5).lastInsertRowid);
  const btc = Number(insH.run('BTC', 'Bitcoin', 'crypto', 'coingecko', 'bitcoin', 74000, 74000).lastInsertRowid);
  const buy = (h, date, qty, price, fee = 100) => {
    if (date <= t) insI.run(h, date, 'buy', qty, price, fee, Math.round(qty * price * 100) + fee, 'Monthly savings plan');
  };
  months.forEach((m, i) => {
    const price = 160 + i * 2.2 + rand() * 4;
    buy(vwce, day(m, 27), +(200 / price).toFixed(4), +price.toFixed(2)); // ~€200 per month
  });
  buy(btc, day(months[1], 14), 0.004, 68000, 150);
  buy(btc, day(months[4], 3), 0.0025, 71000, 150);

  // debts (balances are current, payments are history)
  const insD = db.prepare('INSERT INTO debts (name, kind, balance_cents, original_cents, apr, min_payment_cents, due_day, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const insP = db.prepare('INSERT INTO debt_payments (debt_id, date, amount_cents, transaction_id) VALUES (?, ?, ?, ?)');
  const student = Number(insD.run('Student loan', 'student', 480000, 800000, 3.5, 12000, 15, '').lastInsertRowid);
  const card = Number(insD.run('Credit card', 'credit_card', 65000, 120000, 18.9, 3500, 28, '').lastInsertRowid);
  for (const m of months) {
    for (const [id, amt, name, d] of [[student, 12000, 'Student loan', 15], [card, 3500, 'Credit card', 28]]) {
      const date = day(m, d);
      if (date > t) continue;
      const txId = Number(insTx.run(date, 'expense', amt, cat['Debt payments'], `Payment: ${name}`, 'debt').lastInsertRowid);
      insP.run(id, date, amt, txId);
    }
  }

  // categorisation rules
  const insR = db.prepare('INSERT INTO rules (pattern, category_id) VALUES (?, ?)');
  for (const [p, c] of [['lidl', 'Groceries'], ['aldi', 'Groceries'], ['rewe', 'Groceries'], ['spotify', 'Subscriptions'], ['netflix', 'Subscriptions'], ['uber', 'Transport'], ['amazon', 'Shopping']]) insR.run(p, cat[c]);
}
