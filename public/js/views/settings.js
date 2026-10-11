import {
  api, state, esc, $, $$, icon, money, moneyInput, parseNumber, openModal, formData, requireMoney, toast, changed,
  confirmDialog, catOptions, avatar, download, reloadBootstrap, PALETTE, inlineIcon,
} from '../core.js';
import { iconPicker, wireIconPicker } from '../icons.js';

const LOCALES = [['en-IE', '€1,234.56 (English, Ireland)'], ['de-DE', '1.234,56 € (German style)'], ['fr-FR', '1 234,56 € (French style)'], ['nl-NL', '€ 1.234,56 (Dutch style)'], ['sq-AL', '1 234,56 € (Albanian style)'], ['en-GB', '€1,234.56 (English, UK)'], ['en-US', '€1,234.56 (English, US)']];
const GROUPS = { needs: 'Needs', wants: 'Wants', savings: 'Savings & debt' };

export async function render(el, { setSubtitle }) {
  setSubtitle('Your money basics, categories and data');
  const s = state.settings;
  const rules = await api.get('/api/rules');
  const expense = state.categories.filter((c) => c.kind === 'expense');
  const income = state.categories.filter((c) => c.kind === 'income');

  el.innerHTML = `
    <div class="grid cols-2">
      <form class="card" id="money-form" novalidate>
        <div class="card-head"><h3>Money basics</h3></div>
        <div class="form-grid">
          <div class="field"><label>Your name <span class="faint">(for the greeting)</span></label><input class="input" name="name" maxlength="60" value="${esc(s.name)}"></div>
          <div class="field"><label>Number format</label><select class="select" name="locale">${LOCALES.map(([v, l]) => `<option value="${v}" ${s.locale === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="field"><label>Expected monthly income (net)</label><div class="input-group"><span class="prefix">€</span><input class="input money-in" name="expected" inputmode="decimal" value="${esc(moneyInput(Number(s.expected_income_cents) || ''))}" placeholder="your take-home salary"></div><span class="hint">Used to plan budgets before payday.</span></div>
          <div class="field"><label>Plan budgets with</label><select class="select" name="plan_basis"><option value="expected" ${s.plan_basis !== 'actual' ? 'selected' : ''}>Expected income</option><option value="actual" ${s.plan_basis === 'actual' ? 'selected' : ''}>Actual income received</option></select></div>
          <div class="field"><label>Cash balance on start date</label><div class="input-group"><span class="prefix">€</span><input class="input money-in" name="start_bal" inputmode="decimal" value="${esc(moneyInput(Number(s.starting_balance_cents) || ''))}" placeholder="0.00"></div><span class="hint">What's in your bank account(s) on the start date.</span></div>
          <div class="field"><label>Start date</label><input class="input" type="date" name="start_date" value="${esc(s.starting_balance_date)}"><span class="hint">Transactions from this date on adjust your cash.</span></div>
          <div class="field"><label>Monthly investing plan</label><div class="input-group"><span class="prefix">€</span><input class="input money-in" name="invest" inputmode="decimal" value="${esc(moneyInput(Number(s.monthly_invest_plan_cents) || ''))}" placeholder="0"></div></div>
          <div class="field"><label>Emergency fund target (months)</label><input class="input" name="emergency" inputmode="numeric" value="${esc(s.emergency_months_target)}"><span class="hint">3–6 months of essential costs is the usual advice.</span></div>
        </div>
        <div class="row mt"><div class="spacer"></div><button class="btn btn-primary" type="submit">${icon('check', 'sm')} Save</button></div>
      </form>

      <div class="stack">
        <form class="card" id="method-form" novalidate>
          <div class="card-head"><h3>Budget method</h3></div>
          <div class="field"><select class="select" name="budget_method">
            <option value="limits" ${s.budget_method === 'limits' ? 'selected' : ''}>Category limits: a monthly cap per category</option>
            <option value="503020" ${s.budget_method === '503020' ? 'selected' : ''}>50/30/20: needs, wants and savings split</option>
            <option value="zero" ${s.budget_method === 'zero' ? 'selected' : ''}>Zero-based: give every euro a job</option>
          </select></div>
          <div class="grid cols-3 mt" style="gap:10px">
            <div class="field"><label>Needs %</label><input class="input" name="split_needs" inputmode="decimal" value="${esc(s.split_needs)}"></div>
            <div class="field"><label>Wants %</label><input class="input" name="split_wants" inputmode="decimal" value="${esc(s.split_wants)}"></div>
            <div class="field"><label>Savings %</label><input class="input" name="split_savings" inputmode="decimal" value="${esc(s.split_savings)}"></div>
          </div>
          <div class="row mt"><span class="small muted">Percentages are used by 50/30/20 and the savings-rate insight.</span><div class="spacer"></div><button class="btn btn-primary btn-sm" type="submit">Save</button></div>
        </form>

        <div class="card">
          <div class="card-head"><h3>Your data</h3><span class="sub">${icon('database', 'sm')} stored locally in <code>data/moneta.db</code></span></div>
          <div class="grid cols-2" style="gap:10px">
            <button class="btn" data-backup>${icon('download', 'sm')} Download backup</button>
            <label class="btn" style="cursor:pointer">${icon('upload', 'sm')} Restore backup<input type="file" accept=".json,application/json" hidden data-restore></label>
            <button class="btn" data-export>${icon('download', 'sm')} Export transactions CSV</button>
            ${state.counts.transactions ? '' : `<button class="btn" data-demo>${icon('sparkles', 'sm')} Load demo data</button>`}
          </div>
          <div class="divider"></div>
          <div class="row"><div><div class="strong">Erase everything</div><div class="small muted">Deletes all transactions, goals, investments and settings. Download a backup first.</div></div><div class="spacer"></div><button class="btn btn-danger btn-sm" data-reset>${icon('trash', 'sm')} Erase</button></div>
        </div>

        <div class="card">
          <div class="card-head"><h3>Keyboard shortcuts</h3></div>
          <div class="grid cols-2 small" style="gap:8px">
            <div><kbd>N</kbd> new expense</div><div><kbd>I</kbd> new income</div>
            <div><kbd>←</kbd> <kbd>→</kbd> change month</div><div><kbd>1</kbd>–<kbd>9</kbd> jump to page</div>
            <div><kbd>Esc</kbd> close dialog</div><div><kbd>Enter</kbd> save dialog</div>
          </div>
        </div>
      </div>
    </div>

    <div class="grid cols-2 mt">
      <div class="card">
        <div class="card-head"><h3>Expense categories</h3><span class="sub">${expense.filter((c) => !c.archived).length} active</span><div class="actions"><button class="btn btn-sm" data-newcat="expense">${icon('plus', 'sm')} Add</button></div></div>
        <div class="list">${expense.map(catRow).join('')}</div>
      </div>
      <div class="stack">
        <div class="card">
          <div class="card-head"><h3>Income categories</h3><div class="actions"><button class="btn btn-sm" data-newcat="income">${icon('plus', 'sm')} Add</button></div></div>
          <div class="list">${income.map(catRow).join('')}</div>
        </div>
        <div class="card">
          <div class="card-head"><h3>Auto-categorise rules</h3><span class="sub">${icon('tag', 'sm')} if the description contains…</span><div class="actions"><button class="btn btn-sm" data-newrule>${icon('plus', 'sm')} Add rule</button></div></div>
          ${rules.length ? `<div class="list">${rules.map((r) => `<div class="list-item"><code class="strong" style="font-family:var(--mono);font-size:12.5px">${esc(r.pattern)}</code><span class="muted">→</span><span class="grow">${inlineIcon(r.category_icon)}${esc(r.category_name)}</span><button class="icon-btn sm danger" data-delrule="${r.id}" title="Delete rule">${icon('trash', 'sm')}</button></div>`).join('')}</div>`
    : '<div class="small muted">No rules yet. They are created when you import a CSV and fix categories, or add them here. Moneta also learns from your past transactions with the same description.</div>'}
        </div>
      </div>
    </div>`;

  // ---- money basics
  $('#money-form', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const d = formData(e.target);
      const opt = (v, label, o) => (v.trim() === '' ? 0 : requireMoney(v, label, { allowZero: true, ...o }));
      const months = parseNumber(d.emergency);
      if (!months || Number.isNaN(months) || months < 1 || months > 24) throw new Error('Emergency months must be between 1 and 24');
      await api.put('/api/settings', {
        name: d.name, locale: d.locale, expected_income_cents: opt(d.expected, 'income'), plan_basis: d.plan_basis,
        starting_balance_cents: opt(d.start_bal, 'balance', { allowNegative: true }), starting_balance_date: d.start_date,
        monthly_invest_plan_cents: opt(d.invest, 'investing plan'), emergency_months_target: months,
      });
      toast('Settings saved');
      changed();
    } catch (err) { toast(err.message, 'error'); }
  });
  $('#method-form', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const d = formData(e.target);
      const nums = ['split_needs', 'split_wants', 'split_savings'].map((k) => parseNumber(d[k]));
      if (nums.some((n) => n === null || Number.isNaN(n))) throw new Error('Enter valid percentages');
      await api.put('/api/settings', { budget_method: d.budget_method, split_needs: nums[0], split_wants: nums[1], split_savings: nums[2] });
      toast('Budget method saved');
      changed();
    } catch (err) { toast(err.message, 'error'); }
  });

  // ---- categories
  $$('[data-newcat]', el).forEach((b) => b.addEventListener('click', () => categoryForm({ kind: b.dataset.newcat })));
  $$('[data-cat]', el).forEach((row) => row.addEventListener('click', () => categoryForm(state.categories.find((c) => c.id === Number(row.dataset.cat)))));

  // ---- rules
  $('[data-newrule]', el).addEventListener('click', ruleForm);
  $$('[data-delrule]', el).forEach((b) => b.addEventListener('click', async () => {
    await api.del(`/api/rules/${b.dataset.delrule}`);
    toast('Rule deleted');
    changed();
  }));

  // ---- data
  $('[data-backup]', el).addEventListener('click', () => download('/api/backup'));
  $('[data-export]', el).addEventListener('click', () => download('/api/transactions/export.csv'));
  $('[data-demo]', el)?.addEventListener('click', async () => {
    try { await api.post('/api/demo'); toast('Demo data loaded'); changed(); } catch (err) { toast(err.message, 'error'); }
  });
  $('[data-restore]', el).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    let json;
    try { json = JSON.parse(await file.text()); } catch { toast('That file is not valid JSON', 'error'); return; }
    if (json.app !== 'moneta') { toast('That file is not a Moneta backup', 'error'); return; }
    if (!(await confirmDialog({ title: 'Restore this backup?', message: `Everything currently in Moneta will be replaced with the backup from <b>${esc(json.exported_at?.slice(0, 10) || 'unknown date')}</b>.`, confirmLabel: 'Replace my data' }))) return;
    try { await api.post('/api/restore', json); toast('Backup restored'); await reloadBootstrap(); changed(); } catch (err) { toast(err.message, 'error'); }
  });
  $('[data-reset]', el).addEventListener('click', () => {
    openModal({
      title: 'Erase all data?',
      danger: true,
      submitLabel: 'Erase everything',
      body: `<p class="muted" style="margin-top:0">This permanently deletes every transaction, budget, goal, investment, bill, debt, rule and setting. It cannot be undone.</p>
        <div class="field"><label>Type <b>DELETE</b> to confirm</label><input class="input" name="confirm" autocomplete="off" autofocus></div>`,
      async onSubmit(form) {
        const v = form.elements.confirm.value.trim();
        if (v !== 'DELETE') throw new Error('Type DELETE in capitals to confirm');
        await api.post('/api/reset', { confirm: v });
        toast('All data erased. Fresh start');
        await reloadBootstrap();
        location.hash = '#/dashboard';
        changed();
      },
    });
  });
}

function catRow(c) {
  return `<div class="list-item clickable" data-cat="${c.id}" style="${c.archived ? 'opacity:.5' : ''}">
    ${avatar(c.icon, c.color, 'sm')}
    <div class="grow"><div class="title">${esc(c.name)}</div>${c.kind === 'expense' ? `<div class="meta">${GROUPS[c.grp] || 'Wants'}${c.archived ? ' · archived' : ''}</div>` : c.archived ? '<div class="meta">archived</div>' : ''}</div>
    <span class="cdot" style="width:10px;height:10px;border-radius:50%;background:${esc(c.color)}"></span>
    ${icon('right', 'sm')}
  </div>`;
}

function categoryForm(c) {
  const editing = !!c.id;
  const v = { name: '', icon: '', color: PALETTE[Math.floor(Math.random() * PALETTE.length)], grp: 'wants', ...c };
  const m = openModal({
    title: editing ? `Edit ${c.name}` : `New ${c.kind} category`,
    body: `<div class="form-grid">
      <div class="field"><label>Name</label><input class="input" name="name" maxlength="40" value="${esc(v.name)}" autofocus></div>
      <div class="field full"><label>Icon</label>${iconPicker(v.icon || 'tag')}</div>
      ${v.kind === 'expense' ? `<div class="field"><label>Group (for 50/30/20)</label><select class="select" name="grp">${Object.entries(GROUPS).map(([k, l]) => `<option value="${k}" ${v.grp === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>` : ''}
      <div class="field"><label>Colour</label><input type="color" name="color" value="${esc(v.color)}"></div>
      ${editing ? `<label class="check full"><input type="checkbox" name="archived" ${v.archived ? 'checked' : ''}><span><span class="t">Archived</span><div class="d">Hidden from pickers, history kept.</div></span></label>` : ''}
    </div>`,
    submitLabel: editing ? 'Save' : 'Add category',
    footLeft: editing ? `<button type="button" class="btn btn-danger btn-sm" data-delete>${icon('trash', 'sm')} Delete</button>` : '',
    onOpen(form) {
      wireIconPicker(form);
      form.querySelector('[data-delete]')?.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: `Delete ${esc(v.name)}?`, message: 'If transactions use it, it is archived instead so your history stays intact.' }))) return;
        const r = await api.del(`/api/categories/${v.id}`);
        toast(r.message || 'Category deleted');
        m.close();
        changed();
      });
    },
    async onSubmit(form) {
      const d = formData(form);
      if (!d.name.trim()) throw new Error('Name is required');
      if (editing) await api.put(`/api/categories/${v.id}`, { name: d.name, icon: d.icon, color: d.color, grp: d.grp, archived: d.archived });
      else await api.post('/api/categories', { name: d.name, icon: d.icon, color: d.color, grp: d.grp, kind: v.kind });
      toast(editing ? 'Category saved' : 'Category added');
      changed();
    },
  });
}

function ruleForm() {
  openModal({
    title: 'New auto-categorise rule',
    body: `<div class="form-grid">
      <div class="field full"><label>When the description contains</label><input class="input" name="pattern" maxlength="60" placeholder="e.g. lidl, netflix, shell" autofocus><span class="hint">Not case-sensitive. Longer, more specific rules win.</span></div>
      <div class="field full"><label>Set the category to</label><select class="select" name="category_id">${catOptions(null, null, { none: 'Choose…' })}</select></div>
      <label class="check full"><input type="checkbox" name="apply" checked><span><span class="t">Apply to existing uncategorised transactions</span></span></label>
    </div>`,
    submitLabel: 'Add rule',
    async onSubmit(form) {
      const d = formData(form);
      if (d.pattern.trim().length < 2) throw new Error('Enter at least 2 characters');
      if (!d.category_id) throw new Error('Pick a category');
      const r = await api.post('/api/rules', { pattern: d.pattern, category_id: Number(d.category_id), apply_existing: d.apply });
      toast(r.applied ? `Rule added and applied to ${r.applied} transaction${r.applied > 1 ? 's' : ''}` : 'Rule added');
      changed();
    },
  });
}
