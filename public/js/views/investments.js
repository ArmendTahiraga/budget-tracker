import {
  api, state, esc, $, $$, icon, money, moneyInput, number, pct, fmtDate, todayStr, timeAgo, shortMonth, emptyState, openModal,
  formData, requireMoney, parseNumber, parseMoney, toast, changed, confirmDialog, chart, moneyAxis, plainAxis, tooltipMoney,
  areaGradient, PALETTE, seg, wireSeg, debounce, qs, avatar,
} from '../core.js';

const TYPE_LABEL = { etf: 'ETF', stock: 'Stock', crypto: 'Crypto', bond: 'Bond', fund: 'Fund', other: 'Other' };
const TYPE_ICON = { etf: 'layers', stock: 'building', crypto: 'bitcoin', bond: 'landmark', fund: 'briefcase', other: 'box' };
let lastAutoRefresh = 0;
let histRange = '1y';
const calc = { start: null, monthly: null, rate: 7, years: 15, inflation: 2, real: false };

export async function render(el, { setSubtitle }) {
  let data = await api.get('/api/investments');
  const items = data.items;
  const t = data.totals;
  setSubtitle(items.length ? `${items.length} holding${items.length > 1 ? 's' : ''} · prices in EUR` : 'Track ETFs, stocks and crypto with live prices');

  const thisMonth = data.monthly[data.monthly.length - 1]?.net_cents || 0;
  el.innerHTML = `
    <div class="row wrap" style="margin-bottom:18px">
      <span class="muted small" id="price-status">${items.length ? `${icon('refresh', 'sm')} Prices updated ${timeAgo(data.last_update)}` : ''}</span>
      <div class="spacer"></div>
      ${items.length ? `<button class="btn btn-sm" id="refresh">${icon('refresh', 'sm')} Refresh prices</button>` : ''}
      <button class="btn btn-sm btn-primary" id="add-holding">${icon('plus', 'sm')} Add holding</button>
    </div>

    <div class="grid cols-4">
      <div class="card kpi tone-violet"><div class="label"><span class="dot violet">${icon('investments', 'sm')}</span>Portfolio value</div><div class="value money">${money(t.value_cents)}</div><div class="foot">cost basis ${money(t.cost_cents, { whole: true })}</div></div>
      <div class="card kpi ${t.unrealized_cents >= 0 ? 'tone-green' : 'tone-red'}"><div class="label"><span class="dot ${t.unrealized_cents >= 0 ? 'green' : 'red'}">${icon(t.unrealized_cents >= 0 ? 'up' : 'down', 'sm')}</span>Total return</div><div class="value money ${t.unrealized_cents >= 0 ? 'pos' : 'neg'}">${money(t.unrealized_cents, { sign: true })}</div><div class="foot">${t.cost_cents ? `${t.unrealized_pct >= 0 ? '+' : ''}${t.unrealized_pct.toFixed(2)}% unrealised` : '–'}${t.realized_cents ? ` · realised ${money(t.realized_cents, { sign: true })}` : ''}${t.dividends_cents ? ` · dividends ${money(t.dividends_cents)}` : ''}</div></div>
      <div class="card kpi tone-cyan"><div class="label"><span class="dot cyan">${icon('calendar', 'sm')}</span>Today</div><div class="value money ${t.day_change_cents > 0 ? 'pos' : t.day_change_cents < 0 ? 'neg' : ''}">${money(t.day_change_cents, { sign: true })}</div><div class="foot">${t.value_cents ? `${((t.day_change_cents / Math.max(1, t.value_cents - t.day_change_cents)) * 100).toFixed(2)}% · market moves` : '–'}</div></div>
      <div class="card kpi tone-amber"><div class="label"><span class="dot amber">${icon('piggy', 'sm')}</span>Invested this month</div><div class="value money">${money(thisMonth)}</div><div class="foot">${data.plan_cents ? `plan ${money(data.plan_cents, { whole: true })} · ${thisMonth >= data.plan_cents ? '<span class="pos">${icon('check', 'sm')} done</span>' : `${money(data.plan_cents - thisMonth, { whole: true })} to go`}` : '<a class="card-link" href="#/settings">Set a monthly plan →</a>'}</div></div>
    </div>

    <div class="card flush mt">
      ${items.length ? `<div class="table-wrap"><table class="table">
        <thead><tr><th>Asset</th><th class="num">Quantity</th><th class="num">Avg cost</th><th class="num">Price</th><th class="num">Value</th><th class="num">Return</th><th class="num">Day</th><th></th></tr></thead>
        <tbody>${items.map(holdingRow).join('')}</tbody>
        <tfoot><tr><td>Total</td><td></td><td></td><td></td><td class="num money">${money(t.value_cents)}</td><td class="num money ${t.unrealized_cents >= 0 ? 'pos' : 'neg'}">${money(t.unrealized_cents, { sign: true })}</td><td class="num money ${t.day_change_cents >= 0 ? 'pos' : 'neg'}">${money(t.day_change_cents, { sign: true })}</td><td></td></tr></tfoot>
      </table></div>`
    : emptyState({ icon: 'trendingUp', title: 'No investments yet', text: 'Add an ETF, stock or crypto. Search by name or ticker (for example "VWCE", "Apple" or "Bitcoin"), then log your purchases. Prices update automatically when you are online.', action: `<button class="btn btn-primary btn-sm" data-empty-add>${icon('plus', 'sm')} Add your first holding</button>` })}
    </div>

    ${items.length ? `
    <div class="grid cols-3 mt">
      <div class="card">
        <div class="card-head"><h3>Allocation</h3></div>
        <div class="donut-box"><canvas id="c-alloc"></canvas><div class="donut-center"><div><div class="v money">${money(t.value_cents, { compact: true })}</div><div class="l">total</div></div></div></div>
        <div class="legend-list mt" id="alloc-legend"></div>
      </div>
      <div class="card span-2">
        <div class="card-head"><h3>Portfolio value</h3><span class="sub" id="hist-sub">vs money invested</span>
          <div class="actions">${seg([['6mo', '6M'], ['1y', '1Y'], ['2y', '2Y'], ['5y', '5Y']], histRange, { name: 'hist' })}</div></div>
        <div class="chart-box"><canvas id="c-value"></canvas></div>
      </div>
    </div>` : ''}

    <div class="grid cols-3 mt">
      <div class="card">
        <div class="card-head"><h3>Monthly investing</h3><span class="sub">net buys, 12 months</span></div>
        <div class="chart-box sm"><canvas id="c-monthly"></canvas></div>
      </div>
      <div class="card span-2" id="calc"></div>
    </div>`;

  // ---- wiring
  el.querySelector('#add-holding').addEventListener('click', () => holdingForm());
  el.querySelector('[data-empty-add]')?.addEventListener('click', () => holdingForm());
  const refreshBtn = el.querySelector('#refresh');
  const doRefresh = async (silent = false) => {
    if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.innerHTML = `${icon('refresh', 'sm spin')} Refreshing…`; }
    try {
      const r = await api.post('/api/prices/refresh');
      if (!silent || r.updated) {
        if (r.errors.length) toast(`Updated ${r.updated}. ${r.errors.length} failed: ${r.errors.map((e) => `${e.symbol} (${e.error})`).join(', ')}`, 'error');
        else if (!silent) toast(`Prices updated for ${r.updated} holding${r.updated === 1 ? '' : 's'}`);
      }
      changed();
    } catch (err) {
      if (!silent) toast(err.message, 'error');
      if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.innerHTML = `${icon('refresh', 'sm')} Refresh prices`; }
    }
  };
  refreshBtn?.addEventListener('click', () => doRefresh(false));
  if (data.stale && Date.now() - lastAutoRefresh > 5 * 60_000) {
    lastAutoRefresh = Date.now();
    $('#price-status', el).innerHTML = `${icon('refresh', 'sm spin')} Fetching latest prices…`;
    doRefresh(true);
  }
  $$('[data-h]', el).forEach((row) => {
    const h = items.find((x) => x.id === Number(row.dataset.h));
    row.querySelector('[data-trade]').addEventListener('click', (e) => { e.stopPropagation(); tradeForm(h); });
    row.querySelector('[data-edit]').addEventListener('click', (e) => { e.stopPropagation(); holdingEdit(h); });
    row.addEventListener('click', () => holdingHistory(h));
  });

  requestAnimationFrame(() => {
    drawCharts(el, data);
    drawCalculator(el.querySelector('#calc'), data);
  });
}

function holdingRow(h) {
  const native = h.native_currency && h.native_currency !== 'EUR' ? `<div class="tiny faint">${number(h.native_price, 4)} ${esc(h.native_currency)}</div>` : '';
  const err = h.price_error ? `<div class="price-err" title="${esc(h.price_error)}">${icon('alert', 'sm')} price failed</div>` : '';
  return `<tr data-h="${h.id}" style="cursor:pointer">
    <td><div class="row" style="gap:12px">${avatar(TYPE_ICON[h.asset_type], PALETTE[h.id % PALETTE.length], 'sm')}
      <div style="min-width:0"><div class="strong">${esc(h.symbol)} <span class="badge gray">${TYPE_LABEL[h.asset_type]}</span>${h.price_source === 'manual' ? ' <span class="badge amber">manual</span>' : ''}</div>
      <div class="tiny muted ellipsis" style="max-width:260px">${esc(h.name || '')}</div>${err}</div></div></td>
    <td class="num">${number(h.quantity, 6)}</td>
    <td class="num money">${h.quantity ? money(Math.round(h.avg_cost * 100)) : '–'}</td>
    <td class="num money">${h.has_price ? money(Math.round(h.last_price * 100)) : '–'}${native}</td>
    <td class="num money strong">${money(h.value_cents)}</td>
    <td class="num money ${h.unrealized_cents >= 0 ? 'pos' : 'neg'}">${money(h.unrealized_cents, { sign: true })}<div class="tiny">${h.cost_cents ? `${h.unrealized_pct >= 0 ? '+' : ''}${h.unrealized_pct.toFixed(2)}%` : ''}</div></td>
    <td class="num ${h.day_change_pct > 0 ? 'pos' : h.day_change_pct < 0 ? 'neg' : 'muted'}">${typeof h.day_change_pct === 'number' ? `${h.day_change_pct >= 0 ? '+' : ''}${h.day_change_pct.toFixed(2)}%` : '–'}</td>
    <td class="num nowrap"><button class="btn btn-xs" data-trade>${icon('plus', 'sm')} Trade</button> <button class="icon-btn sm" data-edit title="Edit">${icon('edit', 'sm')}</button></td>
  </tr>`;
}

function drawCharts(el, data) {
  if (!el.isConnected) return;
  const items = data.items.filter((h) => h.value_cents > 0);
  const alloc = el.querySelector('#c-alloc');
  if (alloc && items.length) {
    const total = items.reduce((a, h) => a + h.value_cents, 0);
    const colors = items.map((h) => PALETTE[h.id % PALETTE.length]);
    chart(alloc, {
      type: 'doughnut',
      data: { labels: items.map((h) => h.symbol), datasets: [{ data: items.map((h) => h.value_cents), backgroundColor: colors, borderColor: '#0f1118', borderWidth: 3 }] },
      options: { cutout: '74%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${money(c.parsed)} · ${pct(c.parsed / total, 1)}` } } } },
    });
    const byType = {};
    for (const h of items) byType[h.asset_type] = (byType[h.asset_type] || 0) + h.value_cents;
    el.querySelector('#alloc-legend').innerHTML = items.map((h, i) => `<div class="li"><span class="sw" style="background:${colors[i]}"></span><span class="ellipsis">${esc(h.symbol)}</span><span class="money">${money(h.value_cents, { whole: true })}</span><span class="pc">${pct(h.value_cents / total)}</span></div>`).join('')
      + `<div class="divider" style="margin:6px 0"></div>${Object.entries(byType).map(([k, v]) => `<div class="li"><span></span><span class="muted">${TYPE_LABEL[k]}</span><span class="money muted">${money(v, { whole: true })}</span><span class="pc">${pct(v / total)}</span></div>`).join('')}`;
  }
  const valueCanvas = el.querySelector('#c-value');
  if (valueCanvas) {
    let valueChart = null;
    const draw = (points, note) => {
      el.querySelector('#hist-sub').textContent = note;
      const labels = points.map((s) => fmtDate(s.date));
      const ds = [
        { label: 'Value', data: points.map((s) => s.value_cents), borderColor: '#8b5cf6', backgroundColor: areaGradient('#8b5cf6'), fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2.5 },
        { label: 'Invested', data: points.map((s) => s.cost_cents), borderColor: 'rgba(148,163,184,.6)', borderDash: [5, 5], pointRadius: 0, borderWidth: 1.5, fill: false, stepped: true },
      ];
      if (valueChart) { valueChart.data.labels = labels; valueChart.data.datasets = ds; valueChart.update(); return; }
      valueChart = chart(valueCanvas, {
        type: 'line', data: { labels, datasets: ds },
        options: { interaction: { mode: 'index', intersect: false }, plugins: { legend: { position: 'top', align: 'end' }, tooltip: { callbacks: { label: tooltipMoney } } }, scales: { x: plainAxis({ ticks: { maxTicksLimit: 8 } }), y: moneyAxis() } },
      });
    };
    const load = async () => {
      el.querySelector('#hist-sub').textContent = 'loading market history…';
      try {
        const h = await api.get(`/api/investments/history${qs({ range: histRange })}`);
        if (!el.isConnected) return;
        if (h.points.length >= 2) {
          draw(h.points, h.errors.length ? `history unavailable for ${h.errors.map((e) => e.symbol).join(', ')}, so trade prices are used` : 'weekly, from market prices');
          return;
        }
      } catch { /* offline: fall back to local snapshots */ }
      if (data.snapshots.length >= 2) draw(data.snapshots, 'daily snapshots (offline)');
      else el.querySelector('#hist-sub').textContent = 'history needs an internet connection';
    };
    wireSeg(el.querySelector('.seg[data-name="hist"]'), (v) => { histRange = v; load(); });
    load();
  }
  chart(el.querySelector('#c-monthly'), {
    type: 'bar',
    data: {
      labels: data.monthly.map((m) => shortMonth(m.month)),
      datasets: [
        { label: 'Invested', data: data.monthly.map((m) => m.net_cents), backgroundColor: data.monthly.map((m) => (m.net_cents >= 0 ? '#22d3ee' : '#fb7185')), borderRadius: 5, maxBarThickness: 18 },
        ...(data.plan_cents ? [{ type: 'line', label: 'Plan', data: data.monthly.map(() => data.plan_cents), borderColor: 'rgba(251,191,36,.7)', borderDash: [4, 4], pointRadius: 0, borderWidth: 1.5 }] : []),
      ],
    },
    options: { plugins: { legend: { display: false }, tooltip: { callbacks: { label: tooltipMoney } } }, scales: { x: plainAxis({ ticks: { maxTicksLimit: 12 } }), y: moneyAxis({ beginAtZero: true }) } },
  });
}

// ---------------------------------------------------------------- compound growth calculator
function drawCalculator(box, data) {
  if (!box) return;
  if (calc.start === null) calc.start = Math.round(data.totals.value_cents / 100);
  if (calc.monthly === null) calc.monthly = Math.round((data.plan_cents || 20000) / 100);
  box.innerHTML = `
    <div class="card-head"><h3>Growth calculator</h3><span class="sub">what steady investing could grow into</span></div>
    <div class="grid cols-5" style="gap:12px">
      <div class="field"><label>Start with (€)</label><input class="input sm" name="start" inputmode="decimal" value="${calc.start}"></div>
      <div class="field"><label>Monthly (€)</label><input class="input sm" name="monthly" inputmode="decimal" value="${calc.monthly}"></div>
      <div class="field"><label>Return / year (%)</label><input class="input sm" name="rate" inputmode="decimal" value="${calc.rate}"></div>
      <div class="field"><label>Years</label><input class="input sm" name="years" inputmode="numeric" value="${calc.years}"></div>
      <div class="field"><label>Inflation (%)</label><input class="input sm" name="inflation" inputmode="decimal" value="${calc.inflation}"></div>
    </div>
    <div class="row wrap mt" style="gap:26px" id="calc-out"></div>
    <div class="chart-box sm mt"><canvas id="c-calc"></canvas></div>
    <label class="check mt-s"><input type="checkbox" name="real" ${calc.real ? 'checked' : ''}><span class="small">Show in today's money (adjusted for inflation)</span></label>
    <p class="tiny faint" style="margin:8px 0 0">For illustration only, not financial advice. Real returns vary year to year and are never guaranteed. Broad world-index funds have historically averaged around 6–8% a year over long periods, with large swings along the way.</p>`;
  let c = null;
  const update = () => {
    const v = (n) => parseNumber(box.querySelector(`[name="${n}"]`).value);
    const start = Math.max(0, v('start') || 0), monthly = Math.max(0, v('monthly') || 0), rate = v('rate') || 0;
    const years = Math.min(60, Math.max(1, Math.round(v('years') || 1))), infl = v('inflation') || 0;
    const real = box.querySelector('[name="real"]').checked;
    Object.assign(calc, { start, monthly, rate, years, inflation: infl, real });
    const r = Math.pow(1 + rate / 100, 1 / 12) - 1;
    let bal = start, contrib = start;
    const labels = [], balances = [], contribs = [];
    for (let y = 0; y <= years; y++) {
      const deflate = real ? Math.pow(1 + infl / 100, y) : 1;
      labels.push(y === 0 ? 'Now' : `Y${y}`);
      balances.push(Math.round((bal / deflate) * 100));
      contribs.push(Math.round((contrib / deflate) * 100));
      for (let m = 0; m < 12 && y < years; m++) { bal = bal * (1 + r) + monthly; contrib += monthly; }
    }
    const fv = balances[balances.length - 1], tc = contribs[contribs.length - 1];
    box.querySelector('#calc-out').innerHTML = `
      <div><div class="muted small">Value after ${years} years</div><div style="font-size:24px;font-weight:750" class="money">${money(fv, { whole: true })}</div></div>
      <div><div class="muted small">You put in</div><div style="font-size:18px;font-weight:650" class="money">${money(tc, { whole: true })}</div></div>
      <div><div class="muted small">Growth</div><div style="font-size:18px;font-weight:650" class="money pos">${money(fv - tc, { sign: true, whole: true })}</div></div>`;
    const ds = [
      { label: 'Contributions', data: contribs, borderColor: '#22d3ee', backgroundColor: areaGradient('#22d3ee', 0.25), fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2 },
      { label: 'Total value', data: balances, borderColor: '#8b5cf6', backgroundColor: areaGradient('#8b5cf6', 0.3), fill: '-1', tension: 0.3, pointRadius: 0, borderWidth: 2.5 },
    ];
    if (c) { c.data.labels = labels; c.data.datasets.forEach((d, i) => { d.data = ds[i].data; }); c.update('none'); }
    else c = chart(box.querySelector('#c-calc'), { type: 'line', data: { labels, datasets: ds }, options: { interaction: { mode: 'index', intersect: false }, plugins: { legend: { position: 'top', align: 'end' }, tooltip: { callbacks: { label: tooltipMoney } } }, scales: { x: plainAxis({ ticks: { maxTicksLimit: 12 } }), y: moneyAxis({ beginAtZero: true }) } } });
  };
  box.querySelectorAll('input').forEach((i) => i.addEventListener('input', debounce(update, 150)));
  update();
}

// ---------------------------------------------------------------- forms
function holdingForm() {
  openModal({
    title: 'Add holding',
    wide: true,
    body: `
      <div class="field"><label>Search by name or ticker</label>
        <div class="input-group"><span class="prefix">${icon('search', 'sm')}</span><input class="input" id="sym-q" placeholder="e.g. VWCE, iShares Core MSCI World, Apple, Bitcoin" autocomplete="off" autofocus></div>
        <div class="results" id="sym-results"></div>
        <span class="hint" id="sym-hint">Results come from Yahoo Finance (stocks, ETFs, funds) and CoinGecko (crypto). For European ETFs prefer the listing on your exchange, such as <b>.DE</b> (Xetra) or <b>.AS</b> (Amsterdam).</span>
      </div>
      <div class="divider"></div>
      <div class="form-grid">
        <div class="field"><label>Ticker / symbol</label><input class="input" name="symbol" maxlength="30" placeholder="VWCE.DE"></div>
        <div class="field"><label>Name</label><input class="input" name="name" maxlength="120" placeholder="Vanguard FTSE All-World"></div>
        <div class="field"><label>Type</label><select class="select" name="asset_type">${Object.entries(TYPE_LABEL).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
        <div class="field"><label>Price source</label><select class="select" name="price_source">
          <option value="yahoo">Live: Yahoo Finance ticker</option><option value="coingecko">Live: CoinGecko coin</option><option value="manual">Manual: I'll enter the price</option></select></div>
        <div class="field" data-show="coingecko"><label>CoinGecko coin id</label><input class="input" name="source_id" maxlength="80" placeholder="bitcoin"></div>
        <div class="field" data-show="manual"><label>Current price per unit (€)</label><input class="input" name="manual_price" inputmode="decimal"></div>
      </div>
      <div class="divider"></div>
      <div class="label-text" style="margin-bottom:10px">First purchase <span class="faint">(optional, you can add more trades later)</span></div>
      <div class="grid cols-4" style="gap:12px">
        <div class="field"><label>Quantity</label><input class="input" name="qty" inputmode="decimal" placeholder="e.g. 1.5"></div>
        <div class="field"><label>Price per unit (€)</label><input class="input" name="price" inputmode="decimal"></div>
        <div class="field"><label>Fees (€)</label><input class="input" name="fees" inputmode="decimal" placeholder="0"></div>
        <div class="field"><label>Date</label><input class="input" type="date" name="date" value="${todayStr()}"></div>
      </div>`,
    submitLabel: 'Add holding',
    onOpen(form) {
      const src = form.elements.price_source;
      const toggle = () => $$('[data-show]', form).forEach((f) => f.classList.toggle('hidden', f.dataset.show !== src.value));
      src.addEventListener('change', toggle);
      toggle();
      const results = $('#sym-results', form);
      let found = [];
      const search = debounce(async (q) => {
        if (q.length < 2) { results.innerHTML = ''; return; }
        results.innerHTML = `<div class="r muted">${icon('refresh', 'sm spin')} Searching…</div>`;
        try {
          const r = await api.get(`/api/symbol-search${qs({ q })}`);
          found = r.results;
          if (r.offline) results.innerHTML = '<div class="r muted">You seem to be offline. Enter the details manually below.</div>';
          else if (!found.length) results.innerHTML = '<div class="r muted">No matches. Try another name or enter it manually.</div>';
          else results.innerHTML = found.map((f, i) => `<div class="r" data-i="${i}"><span class="sym">${esc(f.symbol.toUpperCase())}</span><span class="grow ellipsis" style="flex:1">${esc(f.name)}</span><span class="badge gray">${esc(TYPE_LABEL[f.asset_type] || f.asset_type)}</span><span class="tiny faint">${esc(f.exchange)}</span></div>`).join('');
        } catch (err) { results.innerHTML = `<div class="r muted">${esc(err.message)}</div>`; }
      }, 350);
      $('#sym-q', form).addEventListener('input', (e) => search(e.target.value.trim()));
      results.addEventListener('click', (e) => {
        const r = e.target.closest('[data-i]');
        if (!r) return;
        const f = found[Number(r.dataset.i)];
        form.elements.symbol.value = f.symbol.toUpperCase();
        form.elements.name.value = f.name;
        form.elements.asset_type.value = f.asset_type;
        src.value = f.source;
        form.elements.source_id.value = f.source_id || '';
        toggle();
        $$('.r', results).forEach((x) => x.classList.toggle('on', x === r));
        form.elements.qty.focus();
      });
    },
    async onSubmit(form) {
      const d = formData(form);
      if (!d.symbol.trim()) throw new Error('Pick a result or enter a ticker');
      const manual = d.price_source === 'manual' ? parseNumber(d.manual_price) : null;
      if (d.price_source === 'manual' && (manual === null || Number.isNaN(manual) || manual < 0)) throw new Error('Enter the current price for a manual holding');
      const qty = parseNumber(d.qty);
      const price = parseNumber(d.price);
      if (qty !== null && (Number.isNaN(qty) || qty <= 0)) throw new Error('Quantity must be a positive number');
      if (qty && (price === null || Number.isNaN(price) || price < 0)) throw new Error('Enter the price you paid per unit');
      const h = await api.post('/api/holdings', { symbol: d.symbol, name: d.name, asset_type: d.asset_type, price_source: d.price_source, source_id: d.source_id, manual_price: manual });
      if (qty) {
        const fees = d.fees.trim() ? requireMoney(d.fees, 'fees', { allowZero: true }) : 0;
        await api.post('/api/investment-tx', { holding_id: h.id, kind: 'buy', quantity: qty, price, fees_cents: fees, date: d.date });
      }
      if (h.price_error) toast(`Added ${h.symbol}, but the live price failed: ${h.price_error}. Check the ticker.`, 'error');
      else toast(`${h.symbol} added`);
      changed();
    },
  });
}

function tradeForm(h, kind = 'buy') {
  openModal({
    title: `Trade ${h.symbol}`,
    body: `
      <div style="margin-bottom:16px">${seg([['buy', 'Buy'], ['sell', 'Sell'], ['dividend', 'Dividend']], kind, { name: 'kind' })}</div>
      <div class="form-grid">
        <div class="field" data-trade-field><label>Quantity</label><input class="input" name="qty" inputmode="decimal" autofocus placeholder="${h.quantity ? `you hold ${number(h.quantity, 6)}` : ''}"></div>
        <div class="field" data-trade-field><label>Price per unit (€)</label><input class="input" name="price" inputmode="decimal" value="${h.has_price ? esc(String(+h.last_price.toFixed(4)).replace('.', state.settings.locale === 'de-DE' ? ',' : '.')) : ''}"></div>
        <div class="field" data-trade-field><label>Fees (€)</label><input class="input" name="fees" inputmode="decimal" placeholder="0"></div>
        <div class="field hidden" data-div-field><label>Dividend received (€)</label><input class="input money-in" name="amount" inputmode="decimal"></div>
        <div class="field"><label>Date</label><input class="input" type="date" name="date" value="${todayStr()}"></div>
        <div class="field full"><label>Note</label><input class="input" name="note" maxlength="200" placeholder="optional"></div>
      </div>
      <div class="card mt" style="padding:14px 16px"><div class="row between"><span class="muted">Total</span><span class="money strong" id="trade-total" style="font-size:18px">–</span></div></div>`,
    submitLabel: 'Save trade',
    onOpen(form) {
      const segEl = $('.seg', form);
      const sync = () => {
        const k = segEl.dataset.value;
        $$('[data-trade-field]', form).forEach((f) => f.classList.toggle('hidden', k === 'dividend'));
        $$('[data-div-field]', form).forEach((f) => f.classList.toggle('hidden', k !== 'dividend'));
        total();
      };
      const total = () => {
        const k = segEl.dataset.value;
        let c;
        if (k === 'dividend') c = parseMoney(form.elements.amount.value);
        else {
          const q = parseNumber(form.elements.qty.value), p = parseNumber(form.elements.price.value), f = parseMoney(form.elements.fees.value) || 0;
          c = q && p ? Math.round(q * p * 100) + (k === 'buy' ? f : -f) : null;
        }
        $('#trade-total', form).textContent = c && !Number.isNaN(c) ? money(c) : '–';
      };
      wireSeg(segEl, sync);
      form.addEventListener('input', total);
      sync();
    },
    async onSubmit(form) {
      const d = formData(form);
      const k = $('.seg', form).dataset.value;
      if (k === 'dividend') {
        await api.post('/api/investment-tx', { holding_id: h.id, kind: k, total_cents: requireMoney(d.amount, 'dividend amount'), date: d.date, note: d.note });
      } else {
        const q = parseNumber(d.qty), p = parseNumber(d.price);
        if (!q || Number.isNaN(q) || q <= 0) throw new Error('Enter a quantity');
        if (p === null || Number.isNaN(p) || p < 0) throw new Error('Enter the price per unit');
        const fees = d.fees.trim() ? requireMoney(d.fees, 'fees', { allowZero: true }) : 0;
        await api.post('/api/investment-tx', { holding_id: h.id, kind: k, quantity: q, price: p, fees_cents: fees, date: d.date, note: d.note });
      }
      toast(k === 'buy' ? `Bought ${h.symbol}` : k === 'sell' ? `Sold ${h.symbol}` : 'Dividend logged');
      changed();
    },
  });
}

async function holdingHistory(h) {
  const txs = await api.get(`/api/holdings/${h.id}/tx`);
  const m = openModal({
    title: `${h.symbol}: trades`,
    wide: true,
    submitLabel: null,
    cancelLabel: 'Close',
    footLeft: `<button type="button" class="btn btn-sm btn-primary" data-trade>${icon('plus', 'sm')} New trade</button>`,
    body: `<div class="muted small" style="margin-bottom:12px">${esc(h.name || '')}</div>
      ${txs.length ? `<div class="table-wrap"><table class="table compact"><thead><tr><th>Date</th><th>Type</th><th class="num">Quantity</th><th class="num">Price</th><th class="num">Fees</th><th class="num">Total</th><th></th></tr></thead><tbody>
      ${txs.map((t) => `<tr><td class="nowrap">${fmtDate(t.date, { year: true })}</td><td><span class="badge ${t.kind === 'buy' ? 'blue' : t.kind === 'sell' ? 'amber' : 'green'}">${t.kind}</span>${t.note ? ` <span class="tiny faint">${esc(t.note)}</span>` : ''}</td>
        <td class="num">${t.kind === 'dividend' ? '–' : number(t.quantity, 6)}</td><td class="num money">${t.kind === 'dividend' ? '–' : money(Math.round(t.price * 100))}</td>
        <td class="num money">${t.fees_cents ? money(t.fees_cents) : '–'}</td><td class="num money strong">${money(t.total_cents)}</td>
        <td class="num"><button class="icon-btn sm danger" data-del="${t.id}" title="Delete trade">${icon('trash', 'sm')}</button></td></tr>`).join('')}
      </tbody></table></div>` : emptyState({ icon: 'receipt', title: 'No trades yet', text: 'Log a purchase to start tracking this holding.' })}`,
    onOpen(form) {
      form.querySelector('[data-trade]').addEventListener('click', () => { m.close(); tradeForm(h); });
      $$('[data-del]', form).forEach((b) => b.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: 'Delete this trade?', message: 'Your quantity and cost basis will be recalculated.' }))) return;
        try {
          await api.del(`/api/investment-tx/${b.dataset.del}`);
          toast('Trade deleted');
          m.close();
          changed();
        } catch (err) { toast(err.message, 'error'); }
      }));
    },
  });
}

function holdingEdit(h) {
  const m = openModal({
    title: `Edit ${h.symbol}`,
    body: `<div class="form-grid">
      <div class="field"><label>Ticker / symbol</label><input class="input" name="symbol" value="${esc(h.symbol)}"></div>
      <div class="field"><label>Name</label><input class="input" name="name" value="${esc(h.name)}"></div>
      <div class="field"><label>Type</label><select class="select" name="asset_type">${Object.entries(TYPE_LABEL).map(([k, l]) => `<option value="${k}" ${h.asset_type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label>Price source</label><select class="select" name="price_source">
        ${[['yahoo', 'Live: Yahoo Finance'], ['coingecko', 'Live: CoinGecko'], ['manual', 'Manual']].map(([v, l]) => `<option value="${v}" ${h.price_source === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="field"><label>CoinGecko coin id</label><input class="input" name="source_id" value="${esc(h.source_id)}" placeholder="only for CoinGecko"></div>
      <div class="field"><label>Set price manually (€)</label><input class="input" name="manual_price" inputmode="decimal" placeholder="${h.has_price ? number(h.last_price, 4) : ''}"><span class="hint">Overrides the last price until the next refresh (for live sources).</span></div>
      <div class="field full"><label>Notes</label><textarea class="input" name="notes" rows="2">${esc(h.notes)}</textarea></div>
      <label class="check full"><input type="checkbox" name="archived" ${h.archived ? 'checked' : ''}><span><span class="t">Archive</span><div class="d">Hide a holding you have fully sold.</div></span></label>
    </div>`,
    footLeft: `<button type="button" class="btn btn-danger btn-sm" data-delete>${icon('trash', 'sm')} Delete</button>`,
    onOpen(form) {
      form.querySelector('[data-delete]').addEventListener('click', async () => {
        if (!(await confirmDialog({ title: `Delete ${esc(h.symbol)}?`, message: 'The holding and all of its trades will be deleted.' }))) return;
        await api.del(`/api/holdings/${h.id}`);
        toast('Holding deleted');
        m.close();
        changed();
      });
    },
    async onSubmit(form) {
      const d = formData(form);
      const mp = parseNumber(d.manual_price);
      if (mp !== null && (Number.isNaN(mp) || mp < 0)) throw new Error('Enter a valid price');
      await api.put(`/api/holdings/${h.id}`, { ...d, manual_price: mp });
      toast('Holding updated');
      changed();
    },
  });
}
