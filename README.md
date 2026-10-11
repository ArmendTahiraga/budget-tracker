# Moneta: personal budget tracker

A local-first money app: budgets, savings goals, investments with live prices, bills and subscriptions, debt payoff, and bank CSV import. Everything is stored in a SQLite file on your computer. Nothing is uploaded anywhere. The only outside requests are price lookups to Yahoo Finance and CoinGecko.

## Start it

**Easiest:** double-click `start.command` in Finder. It installs what's needed on first run, starts the server and opens your browser.

> The first time, macOS may say it's from an unidentified developer. Right-click → **Open** → **Open** once, and it works normally after that.

**From a terminal:**

```bash
npm install
```

```bash
npm start
```

Then open <http://localhost:4747>. Stop it with `Ctrl+C`. Requires Node.js 22.13 or newer (it uses Node's built-in SQLite, so there's no native database driver to compile).

## First steps

1. **Settings**: enter your expected monthly take-home pay and your current bank balance (with today as the start date).
2. **Bills & income**: add your salary (tick *log automatically*), rent, phone and subscriptions.
3. **Budget**: pick a method and set amounts. *Use 3-month average* fills it in once you have some history.
4. **Savings goals**: create a goal for the trip or purchase you're saving for; add money each payday.
5. **Investments**: search for your ETF or stock (e.g. `VWCE`, `IWDA`) or crypto and log your buys.

Want to look around first? Use **Explore with demo data** on the dashboard, then **Settings → Erase everything** before entering your own.

## Features

| Area | What it does |
|---|---|
| Dashboard | Income, spending, saved and invested, left to spend with a safe daily amount, net worth, 6-month cash flow, category breakdown, spending pace vs last month and vs budget, smart insights, upcoming bills, goals, recent transactions |
| Transactions | Search, filter by type, category and month, grouped by day, bulk categorise or delete, CSV export, auto-suggested category while typing |
| Budget | Three switchable methods: **category limits**, **50/30/20** (editable split, categories grouped into needs, wants and savings), **zero-based** (every euro gets a job, with "left to assign"). Copy last month, fill from 3-month average, pace marker on progress bars |
| Savings goals | Goals, sinking funds and emergency fund; templates; target and date with the monthly amount you need; projected finish date; contributions, withdrawals and history; suggested emergency-fund size from your essential spending |
| Investments | Stocks, ETFs, funds and crypto with live EUR prices (Yahoo Finance and CoinGecko, auto FX conversion); buys, sells, dividends and fees; average cost, unrealised and realised return, day change; allocation; portfolio value history from market data; compound-growth calculator with inflation |
| Bills & income | Weekly to yearly recurring items, auto-log on due date (salary, direct debits) or mark paid or skip, subscription totals per month and year, overdue alerts, bill calendar |
| Debt payoff | Loans and cards with APR and minimum payments, payment log (optionally booked as an expense), avalanche vs snowball planner with extra payments, debt-free date, interest saved, payoff order and chart |
| Reports | 6/12/24-month income vs spending, net worth over time, spending by category with per-month average, category trend, top merchants, annual month-by-month overview grid |
| Import | Bank CSV wizard: auto-detects separator, header row, date format and decimal comma; column mapping with live preview; duplicate detection; auto-categorisation from rules and history; learns new rules from your corrections |
| Settings | Number format (e.g. `1.234,56 €`), income and starting balance, budget method, categories (icon, colour, group), auto-categorise rules, backup, restore, CSV export, erase |

Keyboard: <kbd>N</kbd> new expense · <kbd>I</kbd> new income · <kbd>←</kbd>/<kbd>→</kbd> change month · <kbd>1</kbd>–<kbd>9</kbd> jump to a page.

## How the numbers work

- **Cash** = starting balance + income − expenses − money moved into goals − net investment buys + dividends, counted from the start date in Settings.
- **Net worth** = cash + savings goals + investment market value − debts.
- Money you mark as **already saved** when creating a goal counts toward net worth but isn't taken from cash.
- Moving money into a goal or buying investments is *saving*, not spending, so it doesn't eat into category budgets.

## Your data

- Database: `data/moneta.db` (SQLite). Copy it to back it up, or use **Settings → Download backup** (JSON).
- Use another file or port: `MONETA_DB=/path/to/file.db PORT=4848 npm start`.
- The server only listens on `127.0.0.1` and rejects cross-origin requests.

## Development

```bash
npm test
```

```bash
npm run dev
```

`npm test` runs the backend test suite against an in-memory database; `npm run dev` restarts the server automatically on changes.

```
server/   index.js (HTTP + static), api.js (routes & calculations), db.js (schema), recurring.js, prices.js, demo.js, util.js
public/   index.html, css/app.css, js/app.js (shell & router), js/core.js (helpers), js/forms.js, js/views/*.js
tests/    api.test.js
```
