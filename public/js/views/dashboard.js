import {
  api, state, esc, $, icon, glyph, inlineIcon, money, pct, monthLabel, shortMonth, fmtDate, relDays, richText, progressBar, ring, avatar,
  chart, moneyAxis, plainAxis, tooltipMoney, areaGradient, PALETTE, emptyState, signedMoney, toast, changed, qs,
} from '../core.js';
import { openTransactionForm } from '../forms.js';

function greeting() {
  const h = new Date().getHours();
  const part = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  return state.settings.name ? `${part}, ${state.settings.name}` : part;
}

function onboarding() {
  const steps = [
    ['#/settings', 'Set your salary', 'Expected monthly income and current cash balance'],
    ['#/recurring', 'Add salary & bills', 'Rent, subscriptions and payday log themselves'],
    ['#/budget', 'Plan your budget', 'Category limits, 50/30/20 or zero-based'],
    ['#/goals', 'Create a savings goal', 'A trip, a gadget, an emergency fund'],
    ['#/investments', 'Track investments', 'ETFs, stocks and crypto with live prices'],
    ['#/import', 'Import bank CSV', 'Bring in past transactions in one go'],
  ];
  return `
    <div class="card glow fade-in" style="margin-bottom:18px">
      <div class="row wrap" style="gap:18px;align-items:flex-start">
        <div style="flex:1;min-width:260px">
          <div class="badge violet" style="margin-bottom:10px">${icon('sparkles', 'sm')} Welcome to Moneta</div>
          <h2 style="font-size:24px;letter-spacing:-0.02em">Let's get your money organised</h2>
          <p class="muted" style="margin:6px 0 0;max-width:560px">Everything is stored locally in a SQLite file on this computer. Start with the steps below, or load demo data to look around first (you can erase it later in Settings).</p>
        </div>
        <div class="row">
          <button class="btn" data-demo>${icon('sparkles', 'sm')} Explore with demo data</button>
          <button class="btn btn-primary" data-add>${icon('plus', 'sm')} Add first transaction</button>
        </div>
      </div>
      <div class="onboard">
        ${steps.map(([href, t, d], i) => `<a href="${href}"><span class="n">${i + 1}</span><span><div class="t">${t}</div><div class="d">${d}</div></span></a>`).join('')}
      </div>
    </div>`;
}

function kpi({ label, value, foot = '', tone = 'violet', ic = 'wallet', valueClass = '' }) {
  return `<div class="card kpi tone-${tone}">
    <div class="label"><span class="dot ${tone}">${icon(ic, 'sm')}</span>${label}</div>
    <div class="value money ${valueClass}">${value}</div>
    <div class="foot">${foot}</div>
  </div>`;
}

export async function render(el, { month, setSubtitle }) {
  const d = await api.get(`/api/dashboard${qs({ month })}`);
  const k = d.kpis;
  const isEmpty = !state.counts.transactions && !state.counts.goals && !state.counts.holdings;
  setSubtitle(`${greeting()} · ${monthLabel(month)}${d.is_current ? ` · ${d.days_left} day${d.days_left === 1 ? '' : 's'} left` : ''}`);

  const savedTotal = k.saved_cents + k.invested_cents;
  const budgetFoot = k.budget_cents <= 0
    ? '<a class="card-link" href="#/budget">Set a budget →</a>'
    : k.budget_remaining_cents < 0
      ? `<span class="neg strong">${money(-k.budget_remaining_cents)} over</span> your ${money(k.budget_cents, { whole: true })} budget`
      : `${money(k.budget_cents - k.budget_remaining_cents)} of ${money(k.budget_cents)} used${k.safe_daily_cents !== null ? ` · <span class="strong" style="color:var(--text)">${money(k.safe_daily_cents)}/day</span> for ${d.days_left} days` : ''}`;
  const keptText = k.savings_rate === null ? ''
    : k.savings_rate < 0 ? ' · <span class="warn-text">spent more than earned so far</span>'
      : ` · <span class="strong" style="color:var(--text)">${pct(k.savings_rate)}</span> of income kept`;

  el.innerHTML = `
    ${isEmpty ? onboarding() : ''}
    <div class="grid cols-5">
      ${kpi({ label: 'Income', value: money(k.income_cents), tone: 'green', ic: 'up', foot: k.income_cents || k.expense_cents ? `Net after saving <span class="${k.net_cents >= 0 ? 'pos' : 'neg'} strong">${money(k.net_cents, { sign: true })}</span>` : 'Nothing logged yet' })}
      ${kpi({ label: 'Spent', value: money(k.expense_cents), tone: 'red', ic: 'down', foot: `${d.by_category.length} categor${d.by_category.length === 1 ? 'y' : 'ies'}` })}
      ${kpi({ label: 'Saved & invested', value: money(savedTotal), tone: 'violet', ic: 'piggy', foot: `${money(k.saved_cents)} goals · ${money(k.invested_cents)} invested${keptText}` })}
      ${kpi({ label: 'Left to spend', value: k.budget_cents > 0 ? money(k.budget_remaining_cents) : '–', tone: k.budget_remaining_cents < 0 ? 'red' : 'cyan', ic: 'wallet', valueClass: k.budget_remaining_cents < 0 ? 'neg' : '', foot: budgetFoot })}
      ${kpi({ label: 'Net worth', value: money(d.net_worth.net_worth_cents), tone: 'amber', ic: 'coins', valueClass: d.net_worth.net_worth_cents < 0 ? 'neg' : '', foot: `Portfolio ${money(d.portfolio.value_cents, { compact: true })}${d.portfolio.cost_cents ? ` <span class="${d.portfolio.unrealized_cents >= 0 ? 'pos' : 'neg'}">${money(d.portfolio.unrealized_cents, { sign: true, compact: true })}</span>` : ''}` })}
    </div>

    <div class="grid cols-3 mt">
      <div class="card span-2">
        <div class="card-head"><h3>Cash flow</h3><span class="sub">last 6 months</span><div class="actions"><a class="card-link" href="#/reports">Reports ${icon('arrowRight', 'sm')}</a></div></div>
        <div class="chart-box"><canvas id="c-cashflow"></canvas></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Where it went</h3><span class="sub">${monthLabel(month, true)}</span></div>
        ${d.by_category.length ? `
          <div class="donut-box" style="height:170px"><canvas id="c-donut"></canvas><div class="donut-center"><div><div class="v money">${money(k.expense_cents, { compact: true })}</div><div class="l">spent</div></div></div></div>
          <div class="legend-list mt-s" id="donut-legend"></div>` : emptyState({ icon: 'receipt', title: 'No spending yet', text: 'Expenses for this month will show up here.' })}
      </div>
    </div>

    <div class="grid cols-3 mt">
      <div class="card span-2">
        <div class="card-head"><h3>Spending pace</h3><span class="sub">cumulative, vs last month and budget</span></div>
        <div class="chart-box lg"><canvas id="c-pace"></canvas></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Insights</h3><span class="sub">${icon('sparkles', 'sm')}</span></div>
        ${d.insights.length ? d.insights.slice(0, 5).map((i) => `<${i.link ? `a href="${esc(i.link)}"` : 'div'} class="insight ${i.level}"><span class="ic">${glyph(i.icon)}</span><span class="tx">${richText(i.text)}</span></${i.link ? 'a' : 'div'}>`).join('')
    : emptyState({ icon: 'checkCircle', title: 'All calm', text: 'Insights appear as you add transactions, budgets and goals.' })}
      </div>
    </div>

    <div class="grid cols-3 mt">
      <div class="card">${budgetCard(d)}</div>
      <div class="card">
        <div class="card-head"><h3>Savings goals</h3><div class="actions"><a class="card-link" href="#/goals">All goals ${icon('arrowRight', 'sm')}</a></div></div>
        ${d.goals.length ? `<div class="list">${d.goals.slice(0, 5).map((g) => `
          <a class="list-item clickable" href="#/goals">
            ${ring(g.progress, { size: 44, stroke: 5, color: g.color, label: `<span style="color:${esc(g.color)};display:grid">${glyph(g.icon, 'sm')}</span>` })}
            <div class="grow">
              <div class="title">${esc(g.name)}</div>
              <div class="meta money">${money(g.saved_cents, { whole: true })}${g.target_cents ? ` of ${money(g.target_cents, { whole: true })}` : ''}${g.target_date ? ` · ${fmtDate(g.target_date)}` : ''}</div>
            </div>
            <span class="strong">${g.target_cents ? pct(g.progress) : ''}</span>
          </a>`).join('')}</div>`
    : emptyState({ icon: 'target', title: 'No goals yet', text: 'Saving for a trip or something special?', action: '<a class="btn btn-sm" href="#/goals">Create a goal</a>' })}
      </div>
      <div class="card">
        <div class="card-head"><h3>Upcoming</h3><span class="sub">next 14 days</span><div class="actions"><a class="card-link" href="#/recurring">Bills ${icon('arrowRight', 'sm')}</a></div></div>
        ${d.upcoming.length ? `<div class="list">${d.upcoming.map((u) => `
          <div class="list-item">
            ${avatar(u.icon || (u.type === 'income' ? 'banknote' : 'receipt'), u.color, 'sm')}
            <div class="grow">
              <div class="title">${esc(u.name)}</div>
              <div class="meta">${u.overdue ? '<span class="neg">Overdue</span> · ' : ''}${fmtDate(u.date)} · ${relDays(u.date)}${u.autopay ? ' · auto' : ''}</div>
            </div>
            <span class="money strong ${u.type === 'income' ? 'pos' : ''}">${signedMoney(u.type, u.amount_cents)}</span>
            ${!u.autopay && u.is_next ? `<button class="btn btn-xs" data-pay="${u.recurring_id}" title="Mark as paid">${icon('check', 'sm')}</button>` : ''}
          </div>`).join('')}</div>`
    : emptyState({ icon: 'calendar', title: 'Nothing due soon', text: 'Add your salary, rent and subscriptions to see them here.', action: '<a class="btn btn-sm" href="#/recurring">Add a bill</a>' })}
      </div>
    </div>

    <div class="card mt">
      <div class="card-head"><h3>Recent transactions</h3><span class="sub">${monthLabel(month, true)}</span><div class="actions"><a class="card-link" href="#/transactions">View all ${icon('arrowRight', 'sm')}</a></div></div>
      ${d.recent.length ? `<div class="list">${d.recent.map((t) => `
        <div class="list-item clickable" data-tx='${esc(JSON.stringify(t))}'>
          ${avatar(t.category_icon || (t.type === 'income' ? 'banknote' : 'help'), t.category_color || '#71717a', 'sm')}
          <div class="grow"><div class="title">${esc(t.description || t.category_name || 'Transaction')}</div><div class="meta">${esc(t.category_name || 'Uncategorized')} · ${fmtDate(t.date)}</div></div>
          <span class="money strong ${t.type === 'income' ? 'pos' : ''}">${signedMoney(t.type, t.amount_cents)}</span>
        </div>`).join('')}</div>`
    : emptyState({ icon: 'coins', title: 'No transactions this month', text: 'Press <kbd>N</kbd> anywhere to add one quickly.' })}
    </div>`;

  el.querySelector('[data-demo]')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api.post('/api/demo');
      toast('Demo data loaded. Erase it any time in Settings');
      changed();
    } catch (err) { toast(err.message, 'error'); e.target.disabled = false; }
  });
  el.querySelector('[data-add]')?.addEventListener('click', () => openTransactionForm());
  el.querySelectorAll('[data-tx]').forEach((row) => row.addEventListener('click', () => openTransactionForm(JSON.parse(row.dataset.tx))));
  el.querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      await api.post(`/api/recurring/${b.dataset.pay}/pay`, {});
      toast('Marked as paid and logged');
      changed();
    } catch (err) { toast(err.message, 'error'); b.disabled = false; }
  }));

  // charts render after the element is attached
  requestAnimationFrame(() => drawCharts(el, d));
}

function budgetCard(d) {
  const method = d.method;
  if (method === '503020') {
    const s = d.split;
    const row = (key, label, color) => `
      <div style="margin-bottom:14px">
        <div class="row between small"><span class="strong">${label} <span class="faint">${s[key].pct}%</span></span><span class="money">${money(s[key].actual_cents, { whole: true })} <span class="faint">/ ${money(s[key].target_cents, { whole: true })}</span></span></div>
        <div class="mt-s">${key === 'savings' ? progressBar(s[key].actual_cents, s[key].target_cents, { invert: true }) : progressBar(s[key].actual_cents, s[key].target_cents)}</div>
      </div>`;
    return `<div class="card-head"><h3>50/30/20 split</h3><div class="actions"><a class="card-link" href="#/budget">Budget ${icon('arrowRight', 'sm')}</a></div></div>
      ${row('needs', 'Needs')}${row('wants', 'Wants')}${row('savings', 'Savings & debt')}`;
  }
  return `<div class="card-head"><h3>Budget</h3>${method === 'zero' ? '<span class="badge violet">zero-based</span>' : ''}<div class="actions"><a class="card-link" href="#/budget">Plan ${icon('arrowRight', 'sm')}</a></div></div>
    <div id="budget-mini">${d.kpis.budget_cents > 0 ? '<div class="skeleton" style="height:160px"></div>' : emptyState({ icon: 'calculator', title: 'No budget this month', text: 'Set limits per category to see progress here.', action: '<a class="btn btn-sm" href="#/budget">Set up budget</a>' })}</div>`;
}

async function drawCharts(el, d) {
  if (!el.isConnected) return;
  const labels = d.cashflow.map((c) => shortMonth(c.month));
  chart(el.querySelector('#c-cashflow'), {
    type: 'bar',
    data: {
      labels,
      datasets: [
        { label: 'Income', data: d.cashflow.map((c) => c.income_cents), backgroundColor: '#34d399', borderRadius: 6, maxBarThickness: 22 },
        { label: 'Expenses', data: d.cashflow.map((c) => c.expense_cents), backgroundColor: '#fb7185', borderRadius: 6, maxBarThickness: 22 },
        { label: 'Saved & invested', data: d.cashflow.map((c) => c.saved_cents), backgroundColor: '#8b5cf6', borderRadius: 6, maxBarThickness: 22 },
      ],
    },
    options: {
      plugins: { legend: { position: 'top', align: 'end' }, tooltip: { callbacks: { label: tooltipMoney } } },
      scales: { x: plainAxis(), y: moneyAxis({ beginAtZero: true }) },
    },
  });

  if (d.by_category.length) {
    const top = d.by_category.slice(0, 7);
    const rest = d.by_category.slice(7).reduce((a, c) => a + c.spent_cents, 0);
    const items = rest > 0 ? [...top, { name: 'Other', icon: 'box', color: '#52525b', spent_cents: rest }] : top;
    const total = items.reduce((a, c) => a + c.spent_cents, 0);
    chart(el.querySelector('#c-donut'), {
      type: 'doughnut',
      data: { labels: items.map((c) => c.name), datasets: [{ data: items.map((c) => c.spent_cents), backgroundColor: items.map((c, i) => c.color || PALETTE[i % PALETTE.length]), borderColor: '#0f1118', borderWidth: 3, hoverOffset: 6 }] },
      options: { cutout: '74%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => ` ${money(ctx.parsed)} · ${pct(ctx.parsed / total)}` } } } },
    });
    el.querySelector('#donut-legend').innerHTML = items.slice(0, 6).map((c) => `
      <div class="li"><span class="sw" style="background:${esc(c.color)}"></span><span class="ellipsis">${esc(c.name)}</span><span class="money">${money(c.spent_cents, { whole: true })}</span><span class="pc">${pct(c.spent_cents / total)}</span></div>`).join('');
  }

  const days = d.days_in_month;
  const dayLabels = Array.from({ length: days }, (_, i) => String(i + 1));
  const datasets = [
    { label: 'This month', data: d.pace.current, borderColor: '#8b5cf6', backgroundColor: areaGradient('#8b5cf6', 0.35), fill: true, tension: 0.35, pointRadius: 0, borderWidth: 2.5 },
    { label: 'Last month', data: d.pace.previous.slice(0, days), borderColor: 'rgba(148,163,184,0.55)', borderDash: [5, 5], pointRadius: 0, borderWidth: 1.6, tension: 0.35, fill: false },
  ];
  if (d.pace.budget_cents > 0) {
    datasets.push({ label: 'Budget pace', data: dayLabels.map((_, i) => Math.round((d.pace.budget_cents * (i + 1)) / days)), borderColor: 'rgba(251,191,36,0.6)', borderDash: [2, 4], pointRadius: 0, borderWidth: 1.6, fill: false });
  }
  chart(el.querySelector('#c-pace'), {
    type: 'line',
    data: { labels: dayLabels, datasets },
    options: {
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'top', align: 'end' }, tooltip: { callbacks: { title: (items) => `Day ${items[0].label}`, label: tooltipMoney } } },
      scales: { x: plainAxis({ ticks: { maxTicksLimit: 10 } }), y: moneyAxis({ beginAtZero: true }) },
    },
  });

  // mini budget list (top budgeted categories by usage)
  const mini = el.querySelector('#budget-mini');
  if (mini && d.kpis.budget_cents > 0) {
    const b = await api.get(`/api/budget${qs({ month: d.month })}`);
    const rows = b.categories.filter((c) => c.budget_cents > 0).sort((a, z) => z.spent_cents / z.budget_cents - a.spent_cents / a.budget_cents).slice(0, 5);
    mini.innerHTML = `
      <div style="margin-bottom:16px">
        <div class="row between small"><span class="muted">Total</span><span class="money"><span class="strong">${money(b.totals.spent_cents - b.totals.unbudgeted_spent_cents, { whole: true })}</span> <span class="faint">/ ${money(b.totals.budget_cents, { whole: true })}</span></span></div>
        <div class="mt-s">${progressBar(b.totals.spent_cents - b.totals.unbudgeted_spent_cents, b.totals.budget_cents, { size: 'thick', marker: d.is_current ? d.day_of_month / d.days_in_month : null })}</div>
      </div>
      ${rows.map((c) => `
        <div style="margin-bottom:12px">
          <div class="row between small"><span>${inlineIcon(c.icon, c.color)}${esc(c.name)}</span><span class="money ${c.spent_cents > c.budget_cents ? 'neg' : 'muted'}">${money(c.spent_cents, { whole: true })} / ${money(c.budget_cents, { whole: true })}</span></div>
          <div class="mt-s">${progressBar(c.spent_cents, c.budget_cents, { size: 'thin' })}</div>
        </div>`).join('')}`;
  }
}
