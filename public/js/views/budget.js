import {
  api, state, esc, $, $$, icon, money, moneyInput, parseMoney, pct, monthLabel, progressBar, seg, wireSeg, qs, toast,
  changed, openModal, formData, requireMoney, parseNumber, reloadBootstrap, avatar, confirmDialog,
} from '../core.js';

const METHODS = [
  ['limits', 'Category limits'],
  ['503020', '50 / 30 / 20'],
  ['zero', 'Zero-based'],
];
const METHOD_HELP = {
  limits: 'Give each category a monthly limit and watch what is left as you spend.',
  '503020': 'Split income into needs, wants and savings. Each category belongs to one group.',
  zero: 'Give every euro of income a job (bills, spending, goals, investing) until nothing is left to assign.',
};
const GROUPS = { needs: ['Needs', '#60a5fa'], wants: ['Wants', '#f472b6'], savings: ['Savings & debt', '#34d399'] };

export async function render(el, { month, setSubtitle }) {
  setSubtitle(monthLabel(month));
  let data = await api.get(`/api/budget${qs({ month })}`);

  async function reload() {
    const active = document.activeElement;
    const focusKey = active?.dataset?.key;
    data = await api.get(`/api/budget${qs({ month })}`);
    draw();
    if (focusKey) {
      const next = el.querySelector(`[data-key="${CSS.escape(focusKey)}"]`);
      next?.focus();
    }
  }

  function draw() {
    const method = data.method;
    el.innerHTML = `
      <div class="row wrap" style="gap:10px">
        ${seg(METHODS, method, { name: 'method' })}
        <div class="spacer"></div>
        <button class="btn btn-sm" data-act="copy" title="Copy the most recent month's budget">${icon('history', 'sm')} Copy last month</button>
        <button class="btn btn-sm" data-act="avg" title="Set each category to its 3-month average spend">${icon('sparkles', 'sm')} Use 3-month average</button>
        <button class="btn btn-sm btn-ghost" data-act="clear" title="Remove all limits for this month">${icon('trash', 'sm')} Clear</button>
      </div>
      <p class="muted small" style="margin:10px 0 18px">${METHOD_HELP[method]}</p>
      ${incomeCard()}
      ${method === 'limits' ? limitsSummary() : method === '503020' ? splitSummary() : zeroSummary()}
      ${method === 'zero' ? savingsPlanCard() : ''}
      <div class="card flush mt">
        <div class="bud-row head"><span>Category</span><span class="right">Budget</span><span>Progress</span><span class="right">Spent</span><span class="right">Left</span></div>
        ${method === '503020' ? groupedRows() : data.categories.map(rowHtml).join('')}
        ${data.uncategorized_cents ? `<div class="bud-row"><div class="name">${avatar('help', '#71717a', 'sm')}<div><div class="t">Uncategorized</div><div class="s"><a href="#/transactions?uncategorized=1&month=${month}" class="card-link">Categorise →</a></div></div></div><span></span><span></span><span class="right money">${money(data.uncategorized_cents)}</span><span></span></div>` : ''}
      </div>
      <p class="muted small mt">Tip: type an amount and press <kbd>Enter</kbd> or <kbd>Tab</kbd> to save. Leave it empty to remove a limit.</p>`;
    wire();
  }

  function incomeCard() {
    const basisLabel = data.plan_basis === 'actual' ? 'actual income received' : 'expected salary';
    return `<div class="grid cols-4">
      <div class="card kpi tone-green">
        <div class="label"><span class="dot green">${icon('up', 'sm')}</span>Planned income</div>
        <div class="value money">${money(data.plan_income_cents)}</div>
        <div class="foot">Based on ${basisLabel} · <a class="card-link" href="#" data-act="income">${icon('edit', 'sm')} Edit</a></div>
      </div>
      <div class="card kpi tone-cyan">
        <div class="label"><span class="dot cyan">${icon('wallet', 'sm')}</span>Received so far</div>
        <div class="value money">${money(data.income_actual_cents)}</div>
        <div class="foot">${data.income_expected_cents ? `${pct(data.income_actual_cents / data.income_expected_cents)} of expected ${money(data.income_expected_cents, { whole: true })}` : 'Set your expected salary →'}</div>
      </div>
      <div class="card kpi tone-red">
        <div class="label"><span class="dot red">${icon('down', 'sm')}</span>Spent</div>
        <div class="value money">${money(data.totals.spent_cents)}</div>
        <div class="foot">${data.totals.unbudgeted_spent_cents ? `${money(data.totals.unbudgeted_spent_cents)} outside the budget` : 'All spending is budgeted'}</div>
      </div>
      <div class="card kpi tone-violet">
        <div class="label"><span class="dot violet">${icon('piggy', 'sm')}</span>Saved & invested</div>
        <div class="value money">${money(data.saved_actual_cents + data.invested_actual_cents)}</div>
        <div class="foot">Plan: ${money(data.goals_planned_cents + data.invest_planned_cents, { whole: true })}/month</div>
      </div>
    </div>`;
  }

  function limitsSummary() {
    const t = data.totals;
    const used = t.budget_cents - t.remaining_cents;
    const unassigned = data.plan_income_cents - t.budget_cents - data.goals_planned_cents - data.invest_planned_cents;
    return `<div class="card mt">
      <div class="row wrap between" style="gap:18px">
        <div><div class="muted small">Budgeted</div><div style="font-size:24px;font-weight:700" class="money">${money(t.budget_cents)}</div></div>
        <div><div class="muted small">Used</div><div style="font-size:24px;font-weight:700" class="money">${money(used)}</div></div>
        <div><div class="muted small">${t.remaining_cents >= 0 ? 'Left' : 'Over budget'}</div><div style="font-size:24px;font-weight:700" class="money ${t.remaining_cents < 0 ? 'neg' : 'pos'}">${money(Math.abs(t.remaining_cents))}</div></div>
        <div><div class="muted small">Income not budgeted</div><div style="font-size:24px;font-weight:700" class="money ${unassigned < 0 ? 'neg' : ''}">${money(unassigned)}</div><div class="tiny faint">after goals & investing plans</div></div>
      </div>
      <div class="mt">${progressBar(used, t.budget_cents, { size: 'thick', marker: data.is_current ? data.day_of_month / data.days_in_month : null })}</div>
      ${data.is_current ? `<div class="tiny faint mt-s">The white marker shows how far through the month you are (day ${data.day_of_month} of ${data.days_in_month}).</div>` : ''}
    </div>`;
  }

  function splitSummary() {
    const s = data.split;
    const card = (key) => {
      const [label, color] = GROUPS[key];
      const g = s[key];
      const isSave = key === 'savings';
      const diff = g.target_cents - g.actual_cents;
      return `<div class="card split-card">
        <div class="row between"><span class="badge" style="background:${color}22;color:${color}">${label} · ${g.pct}%</span><span class="muted small">target ${money(g.target_cents, { whole: true })}</span></div>
        <div class="big money mt-s">${money(g.actual_cents)}</div>
        <div class="mt-s">${isSave ? progressBar(g.actual_cents, g.target_cents, { invert: true }) : progressBar(g.actual_cents, g.target_cents)}</div>
        <div class="small mt-s ${isSave ? (diff <= 0 ? 'pos' : 'muted') : (diff < 0 ? 'neg' : 'muted')}">
          ${isSave ? (diff <= 0 ? `Target reached, ${money(-diff)} extra` : `${money(diff)} to go`) : (diff < 0 ? `${money(-diff)} over` : `${money(diff)} left`)}
        </div>
        ${isSave ? '<div class="tiny faint mt-s">Goal contributions + net investing + "savings" categories</div>' : ''}
      </div>`;
    };
    return `<div class="grid cols-3 mt">${card('needs')}${card('wants')}${card('savings')}</div>
      <div class="row mt-s"><button class="btn btn-sm btn-ghost" data-act="split">${icon('edit', 'sm')} Change percentages (${s.needs.pct}/${s.wants.pct}/${s.savings.pct})</button></div>`;
  }

  function zeroSummary() {
    const z = data.zero;
    const left = z.left_to_assign_cents;
    const tone = left === 0 ? 'pos' : left > 0 ? '' : 'neg';
    return `<div class="card glow mt">
      <div class="left-to-assign">
        <div>
          <div class="muted small strong" style="text-transform:uppercase;letter-spacing:.07em">${left >= 0 ? 'Left to assign' : 'Over-assigned'}</div>
          <div class="amount money ${tone}">${money(Math.abs(left))}</div>
          <div class="small muted">${left === 0 ? 'Every euro has a job.' : left > 0 ? 'Give these euros a job below: spending, goals or investing.' : 'You have planned more than your income. Trim something.'}</div>
        </div>
        <div class="spacer"></div>
        <div style="min-width:280px">
          <div class="stat-line"><span class="l">Income</span><span class="v">${money(z.income_cents)}</span></div>
          <div class="stat-line"><span class="l">− Spending categories</span><span class="v">${money(data.totals.budget_cents)}</span></div>
          <div class="stat-line"><span class="l">− Savings goals</span><span class="v">${money(data.goals_planned_cents)}</span></div>
          <div class="stat-line"><span class="l">− Investing</span><span class="v">${money(data.invest_planned_cents)}</span></div>
          <div class="divider" style="margin:6px 0"></div>
          <div class="stat-line"><span class="l strong" style="color:var(--text)">= Left</span><span class="v ${tone}">${money(left)}</span></div>
        </div>
      </div>
      <div class="mt">${progressBar(z.assigned_cents, z.income_cents, left < 0 ? { size: 'thick' } : { size: 'thick', invert: true })}</div>
    </div>`;
  }

  function savingsPlanCard() {
    return `<div class="card mt">
      <div class="card-head"><h3>Savings & investing plan</h3><span class="sub">monthly amounts, which also count as assigned</span></div>
      <div class="list">
        ${data.goals.map((g) => `
          <div class="list-item">
            ${avatar(g.icon, g.color, 'sm')}
            <div class="grow"><div class="title">${esc(g.name)}</div><div class="meta">Savings goal</div></div>
            <input class="input sm money-in" style="width:130px" data-goal="${g.id}" data-key="goal-${g.id}" inputmode="decimal" value="${esc(moneyInput(g.monthly_cents || ''))}" placeholder="0">
          </div>`).join('')}
        <div class="list-item">
          ${avatar('trendingUp', '#22d3ee', 'sm')}
          <div class="grow"><div class="title">Investing</div><div class="meta">Monthly amount you plan to invest</div></div>
          <input class="input sm money-in" style="width:130px" data-invest data-key="invest" inputmode="decimal" value="${esc(moneyInput(data.invest_planned_cents || ''))}" placeholder="0">
        </div>
        ${data.goals.length ? '' : '<div class="small muted mt-s">No savings goals yet. <a class="card-link" href="#/goals">Create one →</a></div>'}
      </div>
    </div>`;
  }

  function rowHtml(c) {
    const ratio = c.budget_cents > 0 ? c.spent_cents / c.budget_cents : 0;
    const marker = data.is_current && c.budget_cents > 0 ? data.day_of_month / data.days_in_month : null;
    const groupSel = data.method === '503020'
      ? `<select class="select sm" data-grp="${c.id}" data-key="grp-${c.id}" style="width:auto;height:24px;font-size:11px;padding:0 24px 0 8px;background-position:right 6px center;margin-top:2px">${Object.entries(GROUPS).map(([k, [l]]) => `<option value="${k}" ${c.grp === k ? 'selected' : ''}>${l}</option>`).join('')}</select>`
      : `<div class="s">${c.avg3_cents ? `3-mo avg ${money(c.avg3_cents, { whole: true })}` : 'No recent spending'}</div>`;
    return `<div class="bud-row">
      <div class="name">${avatar(c.icon, c.color, 'sm')}<div style="min-width:0"><div class="t">${esc(c.name)}${c.archived ? ' <span class="badge gray">archived</span>' : ''}</div>${groupSel}</div></div>
      <input class="input sm money-in" data-cat="${c.id}" data-key="cat-${c.id}" inputmode="decimal" placeholder="–" value="${esc(c.budget_cents ? moneyInput(c.budget_cents) : '')}">
      <div class="bar-cell">${c.budget_cents > 0 ? `${progressBar(c.spent_cents, c.budget_cents, { size: 'thin', marker })}<div class="pct"><span>${pct(ratio)} used</span>${data.method === '503020' && c.avg3_cents ? `<span>avg ${money(c.avg3_cents, { whole: true })}</span>` : ''}</div>` : `<span class="tiny faint">${c.spent_cents ? 'Not budgeted' : ''}</span>`}</div>
      <span class="right money ${c.spent_cents ? '' : 'faint'}">${money(c.spent_cents)}</span>
      <span class="right money strong ${c.budget_cents === 0 ? 'faint' : c.remaining_cents < 0 ? 'neg' : 'pos'}">${c.budget_cents === 0 ? '–' : money(c.remaining_cents)}</span>
    </div>`;
  }

  function groupedRows() {
    return Object.entries(GROUPS).map(([key, [label, color]]) => {
      const rows = data.categories.filter((c) => (c.grp || 'wants') === key);
      const spent = rows.reduce((a, c) => a + c.spent_cents, 0);
      const budget = rows.reduce((a, c) => a + c.budget_cents, 0);
      return `<div class="bud-group-title"><span class="cdot" style="width:8px;height:8px;border-radius:50%;background:${color}"></span>${label}<span class="spacer"></span><span class="money muted" style="text-transform:none;letter-spacing:0">${money(spent, { whole: true })} spent · ${money(budget, { whole: true })} budgeted</span></div>
        ${rows.length ? rows.map(rowHtml).join('') : '<div class="bud-row"><span class="muted small">No categories in this group</span></div>'}`;
    }).join('');
  }

  function wire() {
    wireSeg($('.seg[data-name="method"]', el), async (v) => {
      await api.put('/api/settings', { budget_method: v });
      await reloadBootstrap();
      await reload();
    });
    $$('input[data-cat]', el).forEach((inp) => {
      const save = async () => {
        const raw = inp.value.trim();
        const c = raw === '' ? null : parseMoney(raw);
        if (c !== null && (Number.isNaN(c) || c < 0)) { inp.classList.add('invalid'); toast('Enter a valid amount', 'error'); return; }
        inp.classList.remove('invalid');
        const cat = data.categories.find((x) => x.id === Number(inp.dataset.cat));
        if ((c || 0) === (cat?.budget_cents || 0)) return;
        await api.put(`/api/budget/${month}/${inp.dataset.cat}`, { amount_cents: c });
        await reload();
      };
      inp.addEventListener('change', save);
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
      inp.addEventListener('focus', () => inp.select());
    });
    $$('select[data-grp]', el).forEach((s) => s.addEventListener('change', async () => {
      await api.put(`/api/categories/${s.dataset.grp}`, { grp: s.value });
      await reloadBootstrap();
      await reload();
    }));
    $$('input[data-goal]', el).forEach((inp) => {
      inp.addEventListener('change', async () => {
        const c = inp.value.trim() === '' ? 0 : parseMoney(inp.value);
        if (Number.isNaN(c) || c < 0) { inp.classList.add('invalid'); return; }
        await api.put(`/api/goals/${inp.dataset.goal}`, { monthly_cents: c });
        await reload();
      });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
    });
    const inv = $('input[data-invest]', el);
    inv?.addEventListener('change', async () => {
      const c = inv.value.trim() === '' ? 0 : parseMoney(inv.value);
      if (Number.isNaN(c) || c < 0) { inv.classList.add('invalid'); return; }
      await api.put('/api/settings', { monthly_invest_plan_cents: c });
      await reloadBootstrap();
      await reload();
    });
    inv?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inv.blur(); } });

    el.querySelector('[data-act="copy"]').addEventListener('click', async () => {
      try {
        const r = await api.post(`/api/budget/${month}/copy-previous`);
        toast(`Copied ${r.copied} limits from ${monthLabel(r.from)}`);
        await reload();
      } catch (err) { toast(err.message, 'error'); }
    });
    el.querySelector('[data-act="avg"]').addEventListener('click', async () => {
      try {
        const r = await api.post(`/api/budget/${month}/from-average`);
        toast(`Set ${r.set} categories from your 3-month average`);
        await reload();
      } catch (err) { toast(err.message, 'error'); }
    });
    el.querySelector('[data-act="clear"]').addEventListener('click', async () => {
      if (!(await confirmDialog({ title: `Clear ${monthLabel(month)} budget?`, message: 'All category limits for this month will be removed. Transactions are not affected.', confirmLabel: 'Clear budget' }))) return;
      await api.post(`/api/budget/${month}/clear`);
      toast('Budget cleared');
      await reload();
    });
    el.querySelector('[data-act="income"]').addEventListener('click', (e) => { e.preventDefault(); editIncome(); });
    el.querySelector('[data-act="split"]')?.addEventListener('click', editSplit);
  }

  function editIncome() {
    const s = state.settings;
    openModal({
      title: 'Planned income',
      body: `
        <div class="form-grid">
          <div class="field full"><label>Expected monthly income (after tax)</label>
            <div class="input-group"><span class="prefix">€</span><input class="input money-in" name="expected" inputmode="decimal" value="${esc(moneyInput(s.expected_income_cents || ''))}" placeholder="e.g. 2400"></div>
            <span class="hint">Your take-home salary plus any regular side income.</span></div>
          <div class="field full"><label>Plan the budget with</label>
            <select class="select" name="basis">
              <option value="expected" ${s.plan_basis !== 'actual' ? 'selected' : ''}>Expected income (plan before payday)</option>
              <option value="actual" ${s.plan_basis === 'actual' ? 'selected' : ''}>Actual income received this month</option>
            </select></div>
        </div>`,
      async onSubmit(form) {
        const d = formData(form);
        const expected = d.expected.trim() === '' ? 0 : requireMoney(d.expected, 'income', { allowZero: true });
        await api.put('/api/settings', { expected_income_cents: expected, plan_basis: d.basis });
        await reloadBootstrap();
        toast('Income updated');
        await reload();
      },
    });
  }

  function editSplit() {
    const s = state.settings;
    openModal({
      title: 'Budget split',
      body: `<p class="muted" style="margin-top:0">The classic rule is 50% needs, 30% wants, 20% savings. Adjust it to fit your life. The three must add up to 100%.</p>
        <div class="grid cols-3">
          <div class="field"><label>Needs %</label><input class="input" name="needs" inputmode="decimal" value="${esc(s.split_needs)}"></div>
          <div class="field"><label>Wants %</label><input class="input" name="wants" inputmode="decimal" value="${esc(s.split_wants)}"></div>
          <div class="field"><label>Savings %</label><input class="input" name="savings" inputmode="decimal" value="${esc(s.split_savings)}"></div>
        </div>`,
      async onSubmit(form) {
        const d = formData(form);
        const [n, w, sv] = [d.needs, d.wants, d.savings].map(parseNumber);
        if ([n, w, sv].some((x) => x === null || Number.isNaN(x) || x < 0)) throw new Error('Enter valid percentages');
        await api.put('/api/settings', { split_needs: n, split_wants: w, split_savings: sv });
        await reloadBootstrap();
        toast('Split updated');
        await reload();
      },
    });
  }

  draw();
}
