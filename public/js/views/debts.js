import {
  api, esc, $, $$, icon, money, moneyInput, pct, fmtDate, todayStr, emptyState, openModal, formData, requireMoney, parseMoney,
  parseNumber, toast, changed, confirmDialog, seg, wireSeg, chart, moneyAxis, plainAxis, tooltipMoney, areaGradient, avatar,
  monthLabel, shiftMonth, progressBar,
} from '../core.js';

const KIND = { loan: ['Loan', 'landmark'], credit_card: ['Credit card', 'card'], student: ['Student loan', 'grad'], car: ['Car loan', 'car'], mortgage: ['Mortgage', 'home'], personal: ['Personal / family', 'users'], other: ['Other', 'fileText'] };
const plan = { strategy: 'avalanche', extra: 5000 };

// Month-by-month payoff simulation. With rollover, freed-up minimums go to the next target debt.
export function simulate(debts, { extra = 0, strategy = 'avalanche', rollover = true } = {}) {
  const ds = debts.filter((d) => d.balance_cents > 0).map((d) => ({ id: d.id, name: d.name, bal: d.balance_cents, apr: d.apr, min: d.min_payment_cents, paidOff: null, interest: 0 }));
  const budget = ds.reduce((a, d) => a + d.min, 0) + extra;
  const series = [ds.reduce((a, d) => a + d.bal, 0)];
  let month = 0, totalInterest = 0, stuck = false;
  while (ds.some((d) => d.bal > 0.5) && month < 600) {
    month++;
    for (const d of ds) if (d.bal > 0) { const i = d.bal * (d.apr / 100 / 12); d.bal += i; d.interest += i; totalInterest += i; }
    let available = rollover ? budget : Infinity;
    for (const d of ds) {
      if (d.bal <= 0) continue;
      const pay = Math.min(d.min, d.bal, available);
      d.bal -= pay; available -= pay;
    }
    if (rollover) {
      const order = ds.filter((d) => d.bal > 0).sort(strategy === 'avalanche' ? (a, b) => b.apr - a.apr || a.bal - b.bal : (a, b) => a.bal - b.bal || b.apr - a.apr);
      for (const d of order) {
        if (available <= 0) break;
        const pay = Math.min(available, d.bal);
        d.bal -= pay; available -= pay;
      }
    }
    for (const d of ds) if (d.bal <= 0.5 && d.paidOff === null) { d.bal = 0; d.paidOff = month; }
    const total = ds.reduce((a, d) => a + d.bal, 0);
    series.push(Math.round(total));
    if (month === 24 && total >= series[0]) { stuck = true; break; }
  }
  return { months: stuck || month >= 600 ? null : month, interest: Math.round(totalInterest), series, debts: ds, budget };
}

export async function render(el, { setSubtitle }) {
  const { debts } = await api.get('/api/debts');
  const active = debts.filter((d) => !d.archived && d.balance_cents > 0);
  const paidOff = debts.filter((d) => d.archived || d.balance_cents === 0);
  const total = active.reduce((a, d) => a + d.balance_cents, 0);
  const minimums = active.reduce((a, d) => a + d.min_payment_cents, 0);
  const avgApr = total ? active.reduce((a, d) => a + d.apr * d.balance_cents, 0) / total : 0;
  setSubtitle(active.length ? `${money(total)} across ${active.length} debt${active.length > 1 ? 's' : ''}` : 'Track loans and cards, and plan the fastest way out');

  el.innerHTML = `
    <div class="grid cols-4">
      <div class="card kpi tone-red"><div class="label"><span class="dot red">${icon('debts', 'sm')}</span>Total owed</div><div class="value money">${money(total)}</div><div class="foot">${active.length} active</div></div>
      <div class="card kpi tone-amber"><div class="label"><span class="dot amber">${icon('calendar', 'sm')}</span>Minimums / month</div><div class="value money">${money(minimums)}</div><div class="foot">required payments</div></div>
      <div class="card kpi tone-violet"><div class="label"><span class="dot violet">%</span>Average interest</div><div class="value">${avgApr.toFixed(2)}%</div><div class="foot">weighted by balance</div></div>
      <div class="card kpi tone-green"><div class="label"><span class="dot green">${icon('flame', 'sm')}</span>Debt-free</div><div class="value" id="kpi-free">–</div><div class="foot" id="kpi-free-foot">with your plan below</div></div>
    </div>

    <div class="row mt" style="margin-bottom:12px"><h3 style="font-size:15px">Your debts</h3><div class="spacer"></div><button class="btn btn-sm btn-primary" data-new>${icon('plus', 'sm')} Add debt</button></div>
    ${active.length ? `<div class="grid cols-3">${active.map(debtCard).join('')}</div>` : `<div class="card">${emptyState({ icon: 'checkCircle', title: 'No debts. Nice!', text: 'If you have a loan, credit card or money owed to family, add it here to plan the payoff.' })}</div>`}

    ${active.length ? `
    <div class="card mt">
      <div class="card-head"><h3>Payoff planner</h3><span class="sub">see how extra payments change the timeline</span></div>
      <div class="row wrap" style="gap:16px;margin-bottom:16px">
        ${seg([['avalanche', `${icon('mountain', 'sm')} Avalanche`], ['snowball', `${icon('snowflake', 'sm')} Snowball`]], plan.strategy, { name: 'strategy' })}
        <div class="row" style="gap:8px"><span class="muted small">Extra per month</span><div class="input-group" style="width:140px"><span class="prefix">€</span><input class="input sm money-in" id="extra" inputmode="decimal" value="${esc(moneyInput(plan.extra))}"></div></div>
        <span class="muted small" style="flex:1;min-width:240px">${plan.strategy === 'avalanche' ? 'Avalanche pays the highest interest rate first. It saves the most money.' : 'Snowball pays the smallest balance first. Quick wins keep you motivated.'}</span>
      </div>
      <div class="grid cols-3" id="plan-out"></div>
      <div class="chart-box mt"><canvas id="c-payoff"></canvas></div>
      <div class="table-wrap mt"><table class="table compact" id="payoff-order"></table></div>
    </div>` : ''}

    ${paidOff.length ? `<details class="more mt"><summary>${icon('right', 'sm')} Paid off / archived (${paidOff.length})</summary><div class="grid cols-3 mt">${paidOff.map(debtCard).join('')}</div></details>` : ''}`;

  el.querySelector('[data-new]').addEventListener('click', () => debtForm());
  $$('[data-debt]', el).forEach((card) => {
    const d = debts.find((x) => x.id === Number(card.dataset.debt));
    card.querySelector('[data-pay]')?.addEventListener('click', () => paymentForm(d));
    card.querySelector('[data-edit]').addEventListener('click', () => debtForm(d));
    card.querySelector('[data-history]').addEventListener('click', () => historyModal(d));
  });
  if (!active.length) return;

  let c = null;
  const update = () => {
    const extraRaw = parseMoney($('#extra', el).value);
    plan.extra = Number.isNaN(extraRaw) || extraRaw === null ? 0 : Math.max(0, extraRaw);
    const mine = simulate(active, { extra: plan.extra, strategy: plan.strategy });
    const other = simulate(active, { extra: plan.extra, strategy: plan.strategy === 'avalanche' ? 'snowball' : 'avalanche' });
    const base = simulate(active, { extra: 0, rollover: false });
    const freeDate = mine.months !== null ? `${shiftMonth(todayStr().slice(0, 7), mine.months)}` : null;
    $('#kpi-free', el).textContent = freeDate ? monthLabel(freeDate, true) : 'Never';
    $('#kpi-free-foot', el).textContent = freeDate ? `${mine.months} months · ${plan.strategy}` : 'payments do not cover the interest';
    const savedInterest = base.months !== null && mine.months !== null ? base.interest - mine.interest : null;
    $('#plan-out', el).innerHTML = `
      <div class="card" style="padding:16px"><div class="muted small">Debt-free in</div><div style="font-size:22px;font-weight:700">${mine.months !== null ? `${mine.months} months` : 'Never'}</div><div class="small muted">${freeDate ? monthLabel(freeDate) : 'Increase your payments, because the balance keeps growing'}</div></div>
      <div class="card" style="padding:16px"><div class="muted small">Total interest</div><div style="font-size:22px;font-weight:700" class="money">${money(mine.interest)}</div><div class="small muted">paying ${money(mine.budget)}/month</div></div>
      <div class="card" style="padding:16px"><div class="muted small">vs minimum payments only</div><div style="font-size:22px;font-weight:700" class="money ${savedInterest > 0 ? 'pos' : ''}">${savedInterest !== null ? `${money(savedInterest, { whole: true })} saved` : base.months === null ? 'Never paid off' : '–'}</div>
        <div class="small muted">${base.months !== null && mine.months !== null ? `${base.months - mine.months} months sooner` : ''}${other.months !== null && mine.months !== null && other.interest !== mine.interest ? ` · ${plan.strategy === 'avalanche' ? 'snowball' : 'avalanche'} would cost ${money(other.interest - mine.interest, { sign: true, whole: true })}` : ''}</div></div>`;
    const order = [...mine.debts].sort((a, b) => (a.paidOff ?? 1e9) - (b.paidOff ?? 1e9));
    $('#payoff-order', el).innerHTML = `<thead><tr><th>#</th><th>Debt</th><th class="num">APR</th><th class="num">Interest paid</th><th class="num">Paid off</th></tr></thead><tbody>
      ${order.map((d, i) => `<tr><td>${i + 1}</td><td>${esc(d.name)}</td><td class="num">${d.apr}%</td><td class="num money">${money(Math.round(d.interest))}</td><td class="num">${d.paidOff ? `${monthLabel(shiftMonth(todayStr().slice(0, 7), d.paidOff), true)} <span class="faint">(${d.paidOff} mo)</span>` : 'Never'}</td></tr>`).join('')}</tbody>`;
    const len = Math.max(mine.series.length, base.series.length > 600 ? 0 : base.series.length);
    const labels = Array.from({ length: len }, (_, i) => (i === 0 ? 'Now' : monthLabel(shiftMonth(todayStr().slice(0, 7), i), true)));
    const ds = [
      { label: `Your plan (${plan.strategy})`, data: mine.series, borderColor: '#34d399', backgroundColor: areaGradient('#34d399', 0.3), fill: true, tension: 0.25, pointRadius: 0, borderWidth: 2.5 },
      { label: 'Minimums only', data: base.series.slice(0, len), borderColor: 'rgba(251,113,133,.7)', borderDash: [5, 5], pointRadius: 0, borderWidth: 1.6, fill: false, tension: 0.25 },
    ];
    if (c) { c.data.labels = labels; c.data.datasets = ds; c.update('none'); }
    else c = chart($('#c-payoff', el), { type: 'line', data: { labels, datasets: ds }, options: { interaction: { mode: 'index', intersect: false }, plugins: { legend: { position: 'top', align: 'end' }, tooltip: { callbacks: { label: tooltipMoney } } }, scales: { x: plainAxis({ ticks: { maxTicksLimit: 10 } }), y: moneyAxis({ beginAtZero: true }) } } });
  };
  wireSeg($('.seg[data-name="strategy"]', el), (v) => { plan.strategy = v; changed(); });
  $('#extra', el).addEventListener('input', () => update());
  requestAnimationFrame(update);
}

function debtCard(d) {
  const [label, kindIcon] = KIND[d.kind] || KIND.other;
  return `<div class="card goal-card" data-debt="${d.id}">
    <div class="top">${avatar(kindIcon, '#fb7185', 'lg')}
      <div style="min-width:0;flex:1"><div class="row" style="gap:6px"><span class="badge red">${label}</span>${d.balance_cents === 0 ? '<span class="badge green">Paid off</span>' : ''}</div>
        <h3 style="font-size:16px;margin-top:6px" class="ellipsis">${esc(d.name)}</h3>
        <div class="money" style="font-size:20px;font-weight:700">${money(d.balance_cents)}</div></div>
    </div>
    <div>${progressBar(d.original_cents - d.balance_cents, d.original_cents, { invert: true })}<div class="row between tiny muted mt-s"><span>${pct(d.progress)} paid off</span><span>of ${money(d.original_cents, { whole: true })}</span></div></div>
    <div class="stats">
      <div class="stat"><div class="l">Interest</div><div class="v">${d.apr}%</div></div>
      <div class="stat"><div class="l">Minimum</div><div class="v money">${money(d.min_payment_cents, { whole: true })}</div></div>
      <div class="stat"><div class="l">Last paid</div><div class="v">${d.last_payment ? fmtDate(d.last_payment) : '–'}</div></div>
    </div>
    <div class="actions">
      ${d.balance_cents > 0 ? `<button class="btn btn-sm btn-primary" data-pay>${icon('check', 'sm')} Log payment</button>` : ''}
      <div class="spacer"></div>
      <button class="icon-btn" data-history title="Payments">${icon('history', 'sm')}</button>
      <button class="icon-btn" data-edit title="Edit">${icon('edit', 'sm')}</button>
    </div>
  </div>`;
}

function debtForm(d = null) {
  const editing = !!d;
  const v = d || { name: '', kind: 'loan', balance_cents: '', original_cents: '', apr: '', min_payment_cents: '', due_day: '', notes: '' };
  const m = openModal({
    title: editing ? `Edit ${d.name}` : 'Add a debt',
    body: `<div class="form-grid">
      <div class="field"><label>Name</label><input class="input" name="name" maxlength="80" value="${esc(v.name)}" placeholder="e.g. Visa card" autofocus></div>
      <div class="field"><label>Type</label><select class="select" name="kind">${Object.entries(KIND).map(([k, [l]]) => `<option value="${k}" ${v.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label>Current balance</label><div class="input-group"><span class="prefix">€</span><input class="input money-in" name="balance" inputmode="decimal" value="${esc(moneyInput(v.balance_cents))}"></div></div>
      <div class="field"><label>Original amount <span class="faint">(for progress)</span></label><div class="input-group"><span class="prefix">€</span><input class="input money-in" name="original" inputmode="decimal" value="${esc(moneyInput(v.original_cents || ''))}" placeholder="same as balance"></div></div>
      <div class="field"><label>Interest rate (APR %)</label><input class="input" name="apr" inputmode="decimal" value="${esc(v.apr)}" placeholder="e.g. 18.9"></div>
      <div class="field"><label>Minimum monthly payment</label><div class="input-group"><span class="prefix">€</span><input class="input money-in" name="min" inputmode="decimal" value="${esc(moneyInput(v.min_payment_cents))}"></div></div>
      <div class="field"><label>Due day of month</label><input class="input" name="due_day" inputmode="numeric" value="${esc(v.due_day || '')}" placeholder="1–31"></div>
      <div class="field"><label>Notes</label><input class="input" name="notes" value="${esc(v.notes)}"></div>
      ${editing ? `<label class="check full"><input type="checkbox" name="archived" ${v.archived ? 'checked' : ''}><span><span class="t">Archive</span></span></label>` : ''}
    </div>
    <p class="small muted" style="margin-bottom:0">Tip: when your statement shows interest was added, update the balance here so the plan stays accurate.</p>`,
    submitLabel: editing ? 'Save' : 'Add debt',
    footLeft: editing ? `<button type="button" class="btn btn-danger btn-sm" data-delete>${icon('trash', 'sm')} Delete</button>` : '',
    onOpen(form) {
      form.querySelector('[data-delete]')?.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: `Delete ${esc(v.name)}?`, message: 'Payment history for this debt is deleted too (logged expenses stay).' }))) return;
        await api.del(`/api/debts/${v.id}`);
        toast('Debt deleted');
        m.close();
        changed();
      });
    },
    async onSubmit(form) {
      const f = formData(form);
      const apr = f.apr.trim() ? parseNumber(f.apr) : 0;
      if (Number.isNaN(apr) || apr < 0) throw new Error('Enter a valid interest rate');
      const payload = {
        name: f.name, kind: f.kind, balance_cents: requireMoney(f.balance, 'balance', { allowZero: true }),
        original_cents: f.original.trim() ? requireMoney(f.original, 'original amount', { allowZero: true }) : 0,
        apr, min_payment_cents: f.min.trim() ? requireMoney(f.min, 'minimum payment', { allowZero: true }) : 0,
        due_day: f.due_day ? Number(f.due_day) : null, notes: f.notes, ...(editing ? { archived: f.archived } : {}),
      };
      if (!payload.name.trim()) throw new Error('Give it a name');
      if (editing) await api.put(`/api/debts/${v.id}`, payload); else await api.post('/api/debts', payload);
      toast(editing ? 'Debt updated' : 'Debt added');
      changed();
    },
  });
}

function paymentForm(d) {
  openModal({
    title: `Payment: ${d.name}`,
    body: `<div class="form-grid">
      <div class="field"><label>Amount</label><div class="input-group"><span class="prefix">€</span><input class="input money-in" name="amount" inputmode="decimal" value="${esc(moneyInput(Math.min(d.min_payment_cents || d.balance_cents, d.balance_cents)))}" autofocus></div><span class="hint">Balance ${money(d.balance_cents)}</span></div>
      <div class="field"><label>Date</label><input class="input" type="date" name="date" value="${todayStr()}"></div>
      <label class="check full"><input type="checkbox" name="log" checked><span><span class="t">Also log it as an expense</span><div class="d">Adds a "Debt payments" transaction so your budget and cash stay accurate.</div></span></label>
    </div>`,
    submitLabel: 'Log payment',
    async onSubmit(form) {
      const f = formData(form);
      await api.post(`/api/debts/${d.id}/payments`, { amount_cents: requireMoney(f.amount, 'amount'), date: f.date, log_expense: f.log });
      toast('Payment logged');
      changed();
    },
  });
}

async function historyModal(d) {
  const pays = await api.get(`/api/debts/${d.id}/payments`);
  const m = openModal({
    title: `${d.name}: payments`, wide: true, submitLabel: null, cancelLabel: 'Close',
    body: pays.length ? `<table class="table compact"><thead><tr><th>Date</th><th class="num">Amount</th><th>Logged as expense</th><th></th></tr></thead><tbody>
      ${pays.map((p) => `<tr><td>${fmtDate(p.date, { year: true })}</td><td class="num money">${money(p.amount_cents)}</td><td>${p.transaction_id ? '<span class="badge green">yes</span>' : '<span class="badge gray">no</span>'}</td>
        <td class="num"><button class="icon-btn sm danger" data-del="${p.id}" title="Undo payment">${icon('trash', 'sm')}</button></td></tr>`).join('')}</tbody></table>`
      : emptyState({ icon: 'receipt', title: 'No payments logged yet' }),
    onOpen(form) {
      $$('[data-del]', form).forEach((b) => b.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: 'Undo this payment?', message: 'The amount is added back to the balance and the linked expense is removed.', confirmLabel: 'Undo payment' }))) return;
        await api.del(`/api/debt-payments/${b.dataset.del}`);
        toast('Payment removed');
        m.close();
        changed();
      }));
    },
  });
}
