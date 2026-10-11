import {
  api, state, esc, $, $$, icon, money, pct, shortMonth, monthLabel, seg, wireSeg, chart, moneyAxis, plainAxis, tooltipMoney,
  areaGradient, PALETTE, qs, emptyState, inlineIcon,
} from '../core.js';

const opts = { months: 12, catId: null, year: null };
const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(2000, i, 1).toLocaleDateString('en', { month: 'short' }));

export async function render(el, { setSubtitle }) {
  const end = state.today.slice(0, 7);
  opts.year ||= Number(state.today.slice(0, 4));
  const [o, annual] = await Promise.all([
    api.get(`/api/reports/overview${qs({ months: opts.months, end })}`),
    api.get(`/api/reports/annual${qs({ year: opts.year })}`),
  ]);
  setSubtitle(`${monthLabel(o.months[0], true)} to ${monthLabel(end, true)}`);
  const t = o.totals;
  const cats = o.categories;
  if (!opts.catId || !cats.some((c) => String(c.id) === String(opts.catId))) opts.catId = cats[0]?.id ?? null;

  el.innerHTML = `
    <div class="row" style="margin-bottom:18px">${seg([['6', '6 months'], ['12', '12 months'], ['24', '24 months']], String(opts.months), { name: 'range' })}</div>
    <div class="grid cols-4">
      <div class="card kpi tone-green"><div class="label"><span class="dot green">${icon('up', 'sm')}</span>Avg income / month</div><div class="value money">${money(t.avg_income_cents)}</div><div class="foot">${money(t.income_cents, { whole: true })} total${t.active_months < opts.months ? ` · over ${t.active_months} tracked months` : ''}</div></div>
      <div class="card kpi tone-red"><div class="label"><span class="dot red">${icon('down', 'sm')}</span>Avg spending / month</div><div class="value money">${money(t.avg_expense_cents)}</div><div class="foot">${money(t.expense_cents, { whole: true })} total</div></div>
      <div class="card kpi tone-violet"><div class="label"><span class="dot violet">${icon('piggy', 'sm')}</span>Savings rate</div><div class="value">${pct(t.savings_rate)}</div><div class="foot">of income not spent</div></div>
      <div class="card kpi tone-cyan"><div class="label"><span class="dot cyan">${icon('investments', 'sm')}</span>Saved + invested</div><div class="value money">${money(t.saved_cents + t.invested_cents)}</div><div class="foot">${money(t.saved_cents, { whole: true })} goals · ${money(t.invested_cents, { whole: true })} invested</div></div>
    </div>

    <div class="grid cols-2 mt">
      <div class="card"><div class="card-head"><h3>Income vs spending</h3></div><div class="chart-box"><canvas id="r-flow"></canvas></div></div>
      <div class="card"><div class="card-head"><h3>Net worth</h3><span class="sub">cash + savings + investments − debts</span></div><div class="chart-box"><canvas id="r-nw"></canvas></div></div>
    </div>

    <div class="grid cols-3 mt">
      <div class="card span-2">
        <div class="card-head"><h3>Spending by category</h3><span class="sub">${opts.months}-month total</span></div>
        ${cats.length ? `<div class="table-wrap"><table class="table compact">
          <thead><tr><th>Category</th><th class="num">Total</th><th class="num">Per month</th><th style="width:34%">Share</th></tr></thead>
          <tbody>${cats.map((c) => {
    const share = c.total_cents / t.expense_cents;
    return `<tr data-cat="${c.id ?? ''}" style="cursor:pointer" title="Show trend"><td>${inlineIcon(c.icon, c.color)}${esc(c.name)}</td><td class="num money">${money(c.total_cents)}</td><td class="num money muted">${money(Math.round(c.total_cents / t.active_months))}</td>
              <td><div class="row" style="gap:8px"><div class="progress thin" style="flex:1"><span style="width:${(share * 100).toFixed(1)}%;background:${esc(c.color)}"></span></div><span class="tiny muted" style="width:36px;text-align:right">${pct(share)}</span></div></td></tr>`;
  }).join('')}</tbody></table></div>` : emptyState({ icon: 'reports', title: 'No spending in this period' })}
      </div>
      <div class="card">
        <div class="card-head"><h3>Category trend</h3></div>
        ${cats.length ? `<select class="select sm" id="trend-cat">${cats.map((c) => `<option value="${c.id ?? ''}" ${String(c.id) === String(opts.catId) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
          <div class="chart-box sm mt"><canvas id="r-trend"></canvas></div>` : emptyState({ icon: 'trendingUp', title: 'Nothing to chart yet' })}
        <div class="divider"></div>
        <div class="card-head" style="margin-bottom:8px"><h3>Top merchants</h3></div>
        ${o.payees.length ? `<div class="list">${o.payees.map((p) => `<a class="list-item clickable" href="#/transactions?q=${encodeURIComponent(p.description)}"><div class="grow"><div class="title">${esc(p.description)}</div><div class="meta">${p.n} transaction${p.n > 1 ? 's' : ''}</div></div><span class="money strong">${money(p.total_cents)}</span></a>`).join('')}</div>` : '<div class="muted small">No data yet</div>'}
      </div>
    </div>

    <div class="card flush mt">
      <div class="card-head" style="padding:18px 20px 0">
        <h3>Annual overview</h3><span class="sub">every category, month by month</span>
        <div class="actions"><select class="select sm" id="year" style="width:110px">${annual.years.map((y) => `<option ${y === annual.year ? 'selected' : ''}>${y}</option>`).join('')}</select></div>
      </div>
      <div class="table-wrap">${annualTable(annual)}</div>
    </div>`;

  wireSeg($('.seg[data-name="range"]', el), (v) => { opts.months = Number(v); window.dispatchEvent(new CustomEvent('moneta:changed')); });
  $('#year', el).addEventListener('change', (e) => { opts.year = Number(e.target.value); window.dispatchEvent(new CustomEvent('moneta:changed')); });

  requestAnimationFrame(() => {
    if (!el.isConnected) return;
    const labels = o.series.map((s) => shortMonth(s.month));
    chart($('#r-flow', el), {
      type: 'bar',
      data: {
        labels,
        datasets: [
          { label: 'Income', data: o.series.map((s) => s.income_cents), backgroundColor: '#34d399', borderRadius: 5, maxBarThickness: 18, order: 2 },
          { label: 'Spending', data: o.series.map((s) => s.expense_cents), backgroundColor: '#fb7185', borderRadius: 5, maxBarThickness: 18, order: 2 },
          { type: 'line', label: 'Net', data: o.series.map((s) => s.net_cents), borderColor: '#c4b5fd', backgroundColor: '#c4b5fd', pointRadius: 3, borderWidth: 2, tension: 0.3, order: 1 },
        ],
      },
      options: { interaction: { mode: 'index', intersect: false }, plugins: { legend: { position: 'top', align: 'end' }, tooltip: { callbacks: { label: tooltipMoney } } }, scales: { x: plainAxis(), y: moneyAxis() } },
    });
    const nw = o.net_worth;
    chart($('#r-nw', el), {
      type: 'line',
      data: {
        labels,
        datasets: [
          { label: 'Net worth', data: nw.map((n) => n.net_worth_cents), borderColor: '#8b5cf6', backgroundColor: areaGradient('#8b5cf6', 0.35), fill: true, tension: 0.3, pointRadius: 2, borderWidth: 2.5 },
          { label: 'Investments', data: nw.map((n) => n.investments_cents), borderColor: '#22d3ee', pointRadius: 0, borderWidth: 1.5, tension: 0.3 },
          { label: 'Savings goals', data: nw.map((n) => n.goals_cents), borderColor: '#34d399', pointRadius: 0, borderWidth: 1.5, tension: 0.3 },
          { label: 'Debts', data: nw.map((n) => -n.debts_cents), borderColor: '#fb7185', pointRadius: 0, borderWidth: 1.5, borderDash: [4, 4], tension: 0.3 },
        ],
      },
      options: { interaction: { mode: 'index', intersect: false }, plugins: { legend: { position: 'top', align: 'end' }, tooltip: { callbacks: { label: tooltipMoney } } }, scales: { x: plainAxis(), y: moneyAxis() } },
    });
    drawTrend();
  });

  let trendChart = null;
  function drawTrend() {
    const canvas = $('#r-trend', el);
    if (!canvas) return;
    const id = opts.catId;
    const c = cats.find((x) => String(x.id) === String(id));
    const data = o.months.map((m) => o.cat_monthly.find((r) => String(r.id) === String(id) && r.month === m)?.total || 0);
    const avg = data.reduce((a, v) => a + v, 0) / Math.max(1, t.active_months);
    const ds = [
      { label: c?.name || '', data, backgroundColor: c?.color || PALETTE[0], borderRadius: 4, maxBarThickness: 16 },
      { type: 'line', label: 'Average', data: data.map(() => Math.round(avg)), borderColor: 'rgba(251,191,36,.7)', borderDash: [4, 4], pointRadius: 0, borderWidth: 1.5 },
    ];
    if (trendChart) { trendChart.data.datasets = ds; trendChart.update(); return; }
    trendChart = chart(canvas, { type: 'bar', data: { labels: o.months.map(shortMonth), datasets: ds }, options: { plugins: { legend: { display: false }, tooltip: { callbacks: { label: tooltipMoney } } }, scales: { x: plainAxis({ ticks: { maxTicksLimit: 12 } }), y: moneyAxis({ beginAtZero: true }) } } });
  }
  $('#trend-cat', el)?.addEventListener('change', (e) => { opts.catId = e.target.value; drawTrend(); });
  $$('[data-cat]', el).forEach((row) => row.addEventListener('click', () => {
    opts.catId = row.dataset.cat;
    const sel = $('#trend-cat', el);
    if (sel) sel.value = row.dataset.cat;
    drawTrend();
  }));
}

function annualTable(a) {
  if (!a.income.length && !a.expense.length) return `<div style="padding:0 20px 20px">${emptyState({ icon: 'calendar', title: `No transactions in ${a.year}` })}</div>`;
  const cell = (v, cls = '') => `<td class="num money ${cls}">${v ? money(v, { whole: true }) : '<span class="faint">–</span>'}</td>`;
  const row = (r) => `<tr><td class="nowrap">${inlineIcon(r.icon)}${esc(r.name)}</td>${r.months.map((v) => cell(v)).join('')}${cell(r.total, 'strong')}</tr>`;
  const net = a.income_totals.map((v, i) => v - a.expense_totals[i]);
  const sum = (arr) => arr.reduce((x, y) => x + y, 0);
  return `<table class="table grid-sheet" style="margin-top:12px">
    <thead><tr><th></th>${MONTHS.map((m) => `<th class="num">${m}</th>`).join('')}<th class="num">Total</th></tr></thead>
    <tbody>
      <tr><td colspan="14" class="strong pos" style="font-size:11px;text-transform:uppercase;letter-spacing:.08em">Income</td></tr>
      ${a.income.map(row).join('')}
      <tr><td class="strong">Total income</td>${a.income_totals.map((v) => cell(v, 'strong pos')).join('')}${cell(sum(a.income_totals), 'strong pos')}</tr>
      <tr><td colspan="14" class="strong neg" style="font-size:11px;text-transform:uppercase;letter-spacing:.08em">Expenses</td></tr>
      ${a.expense.map(row).join('')}
      <tr><td class="strong">Total expenses</td>${a.expense_totals.map((v) => cell(v, 'strong neg')).join('')}${cell(sum(a.expense_totals), 'strong neg')}</tr>
    </tbody>
    <tfoot><tr><td>Net</td>${net.map((v) => `<td class="num money ${v > 0 ? 'pos' : v < 0 ? 'neg' : 'faint'}">${v ? money(v, { whole: true, sign: true }) : '–'}</td>`).join('')}<td class="num money ${sum(net) >= 0 ? 'pos' : 'neg'}">${money(sum(net), { whole: true, sign: true })}</td></tr></tfoot>
  </table>`;
}
