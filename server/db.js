// SQLite schema, migrations and default data.
// All money is stored as integer cents; dates are local 'YYYY-MM-DD' strings.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT NOT NULL,
  kind     TEXT NOT NULL CHECK (kind IN ('expense','income')),
  grp      TEXT CHECK (grp IN ('needs','wants','savings')),
  icon     TEXT DEFAULT '',
  color    TEXT DEFAULT '#7c5cff',
  archived INTEGER NOT NULL DEFAULT 0,
  sort     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS recurring (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'expense' CHECK (type IN ('income','expense')),
  amount_cents INTEGER NOT NULL DEFAULT 0,
  category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  frequency    TEXT NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('weekly','biweekly','monthly','quarterly','semiannual','yearly')),
  next_due     TEXT NOT NULL,
  anchor_day   INTEGER,
  autopay      INTEGER NOT NULL DEFAULT 0,
  subscription INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  icon         TEXT DEFAULT '',
  notes        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  date         TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('income','expense')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  description  TEXT NOT NULL DEFAULT '',
  notes        TEXT NOT NULL DEFAULT '',
  source       TEXT NOT NULL DEFAULT 'manual',
  recurring_id INTEGER REFERENCES recurring(id) ON DELETE SET NULL,
  import_hash  TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_tx_cat ON transactions(category_id);
CREATE INDEX IF NOT EXISTS idx_tx_hash ON transactions(import_hash);

CREATE TABLE IF NOT EXISTS budgets (
  month        TEXT NOT NULL,
  category_id  INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (month, category_id)
);

CREATE TABLE IF NOT EXISTS goals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'goal' CHECK (kind IN ('goal','sinking','emergency')),
  icon          TEXT DEFAULT 'target',
  color         TEXT DEFAULT '#7c5cff',
  target_cents  INTEGER NOT NULL DEFAULT 0,
  target_date   TEXT,
  monthly_cents INTEGER NOT NULL DEFAULT 0,
  notes         TEXT NOT NULL DEFAULT '',
  archived      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS goal_entries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  goal_id      INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  date         TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  initial      INTEGER NOT NULL DEFAULT 0  -- 1 = money already saved before tracking (not taken from cash)
);
CREATE INDEX IF NOT EXISTS idx_ge_goal ON goal_entries(goal_id);

CREATE TABLE IF NOT EXISTS holdings (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol            TEXT NOT NULL,
  name              TEXT NOT NULL DEFAULT '',
  asset_type        TEXT NOT NULL DEFAULT 'etf' CHECK (asset_type IN ('stock','etf','crypto','bond','fund','other')),
  price_source      TEXT NOT NULL DEFAULT 'yahoo' CHECK (price_source IN ('yahoo','coingecko','manual')),
  source_id         TEXT NOT NULL DEFAULT '',
  last_price        REAL,
  native_price      REAL,
  native_currency   TEXT,
  day_change_pct    REAL,
  price_updated_at  TEXT,
  price_error       TEXT,
  notes             TEXT NOT NULL DEFAULT '',
  archived          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS investment_tx (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  holding_id  INTEGER NOT NULL REFERENCES holdings(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('buy','sell','dividend')),
  quantity    REAL NOT NULL DEFAULT 0,
  price       REAL NOT NULL DEFAULT 0,
  fees_cents  INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL DEFAULT 0,
  note        TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_itx_holding ON investment_tx(holding_id);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
  date        TEXT PRIMARY KEY,
  value_cents INTEGER NOT NULL,
  cost_cents  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS debts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'loan',
  balance_cents     INTEGER NOT NULL DEFAULT 0,
  original_cents    INTEGER NOT NULL DEFAULT 0,
  apr               REAL NOT NULL DEFAULT 0,
  min_payment_cents INTEGER NOT NULL DEFAULT 0,
  due_day           INTEGER,
  notes             TEXT NOT NULL DEFAULT '',
  archived          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS debt_payments (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  debt_id        INTEGER NOT NULL REFERENCES debts(id) ON DELETE CASCADE,
  date           TEXT NOT NULL,
  amount_cents   INTEGER NOT NULL,
  transaction_id INTEGER REFERENCES transactions(id) ON DELETE SET NULL,
  note           TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern     TEXT NOT NULL,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export const DEFAULT_SETTINGS = {
  currency: 'EUR',
  locale: 'en-IE',
  budget_method: 'limits',          // limits | 503020 | zero
  split_needs: '50',
  split_wants: '30',
  split_savings: '20',
  expected_income_cents: '0',
  plan_basis: 'expected',           // expected | actual
  monthly_invest_plan_cents: '0',
  starting_balance_cents: '0',
  starting_balance_date: '',
  emergency_months_target: '6',
  name: '',
};

const DEFAULT_CATEGORIES = [
  // [name, kind, group, icon, color]
  ['Housing', 'expense', 'needs', 'home', '#7c5cff'],
  ['Utilities', 'expense', 'needs', 'bulb', '#f59e0b'],
  ['Groceries', 'expense', 'needs', 'cart', '#22c55e'],
  ['Transport', 'expense', 'needs', 'bus', '#38bdf8'],
  ['Phone & Internet', 'expense', 'needs', 'phone', '#06b6d4'],
  ['Insurance', 'expense', 'needs', 'shield', '#64748b'],
  ['Health', 'expense', 'needs', 'health', '#f43f5e'],
  ['Education', 'expense', 'needs', 'grad', '#a3e635'],
  ['Dining out', 'expense', 'wants', 'utensils', '#fb923c'],
  ['Entertainment', 'expense', 'wants', 'film', '#e879f9'],
  ['Shopping', 'expense', 'wants', 'bag', '#f472b6'],
  ['Subscriptions', 'expense', 'wants', 'tv', '#818cf8'],
  ['Travel', 'expense', 'wants', 'plane', '#2dd4bf'],
  ['Personal care', 'expense', 'wants', 'scissors', '#c084fc'],
  ['Gifts & Donations', 'expense', 'wants', 'gift', '#fb7185'],
  ['Debt payments', 'expense', 'savings', 'card', '#94a3b8'],
  ['Other', 'expense', 'wants', 'box', '#71717a'],
  ['Salary', 'income', null, 'briefcase', '#34d399'],
  ['Side income', 'income', null, 'banknote', '#10b981'],
  ['Interest & Dividends', 'income', null, 'trendingUp', '#22d3ee'],
  ['Gifts received', 'income', null, 'sparkles', '#a78bfa'],
  ['Refunds', 'income', null, 'undo', '#60a5fa'],
  ['Other income', 'income', null, 'plusCircle', '#4ade80'],
];

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  migrate(db);
  seedDefaults(db);
  return db;
}

// Add columns introduced after a database was first created.
const COLUMN_MIGRATIONS = [
  ['goal_entries', 'initial', 'INTEGER NOT NULL DEFAULT 0'],
];
// Older versions stored emojis as icons; convert them to line-icon names.
const EMOJI_ICONS = {
  '🏠': 'home', '💡': 'bulb', '🛒': 'cart', '🚌': 'bus', '📱': 'phone', '🛡': 'shield', '💊': 'health', '📚': 'grad',
  '🍽': 'utensils', '🎬': 'film', '🛍': 'bag', '📺': 'tv', '✈': 'plane', '💇': 'scissors', '🎁': 'gift', '💳': 'card',
  '📦': 'box', '💼': 'briefcase', '💸': 'banknote', '📈': 'trendingUp', '🎉': 'sparkles', '↩': 'undo', '➕': 'plusCircle',
  '🎯': 'target', '🛟': 'lifebuoy', '💻': 'laptop', '🚗': 'car', '🎓': 'grad', '🧾': 'receipt', '🏝': 'sun', '💍': 'gem',
  '🎸': 'music', '🏋': 'dumbbell', '🐶': 'heart', '👶': 'heart', '💎': 'gem', '🚲': 'bike', '🌐': 'wifi', '🎧': 'headphones',
  '🍿': 'film', '⚡': 'bolt', '☁': 'cloud', '🍕': 'utensils', '🤖': 'bot', '▶': 'play', '🎮': 'gamepad', '🏰': 'film', '🍎': 'phone',
};
export function iconName(v) {
  const s = String(v || '').trim();
  if (!s || /^[A-Za-z][A-Za-z0-9]{0,23}$/.test(s)) return s;
  return EMOJI_ICONS[s.replace(/️/g, '')] || 'tag';
}

export function migrate(db) {
  for (const [table, column, def] of COLUMN_MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`);
  }
  for (const table of ['categories', 'goals', 'recurring']) {
    const rows = db.prepare(`SELECT id, icon FROM ${table} WHERE icon IS NOT NULL AND icon != ''`).all();
    const upd = db.prepare(`UPDATE ${table} SET icon = ? WHERE id = ?`);
    for (const r of rows) {
      const name = iconName(r.icon);
      if (name !== r.icon) upd.run(name, r.id);
    }
  }
}

export function seedDefaults(db) {
  const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insSetting.run(k, v);

  const { n } = db.prepare('SELECT COUNT(*) AS n FROM categories').get();
  if (n === 0) {
    const ins = db.prepare('INSERT INTO categories (name, kind, grp, icon, color, sort) VALUES (?, ?, ?, ?, ?, ?)');
    DEFAULT_CATEGORIES.forEach(([name, kind, grp, icon, color], i) => ins.run(name, kind, grp, icon, color, i));
  }
}

export function inTx(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// Order matters for restore: parents before children.
export const TABLES = [
  'settings', 'categories', 'recurring', 'transactions', 'budgets', 'goals', 'goal_entries',
  'holdings', 'investment_tx', 'portfolio_snapshots', 'debts', 'debt_payments', 'rules',
];
