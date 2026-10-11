import {
  api, state, esc, $, $$, icon, money, monthLabel, dayLabel, catOptions, seg, wireSeg, debounce, qs, avatar, signedMoney,
  emptyState, toast, changed, confirmDialog, download, catChip,
} from '../core.js';
import { openTransactionForm } from '../forms.js';

const PAGE = 200;
// Filters persist while the app is open (survive re-renders after edits).
const filters = { q: '', type: '', category: '', scope: 'month' };
let lastParamsKey = '';

export async function render(el, { params, month, setSubtitle }) {
  const key = JSON.stringify(params);
  if (key !== lastParamsKey) {
    lastParamsKey = key;
    if (params.uncategorized) { filters.category = 'none'; filters.type = ''; }
    if (params.category) filters.category = params.category;
    if (params.q) filters.q = params.q;
  }
  if (params.month && /^\d{4}-\d{2}$/.test(params.month) && params.month !== month) {
    month = params.month;
  }
  let items = [];
  let total = 0;
  const selected = new Set();

  el.innerHTML = `
    <div class="toolbar">
      <div class="search">${icon('search', 'sm')}<input class="input" id="tx-q" placeholder="Search description or notes" value="${esc(filters.q)}"></div>
      ${seg([['', 'All'], ['expense', 'Expenses'], ['income', 'Income']], filters.type, { name: 'type' })}
      <select class="select" id="tx-cat" style="width:200px">
        <option value="">All categories</option>
        <option value="none" ${filters.category === 'none' ? 'selected' : ''}>Uncategorized</option>
        ${catOptions(null, filters.category === 'none' ? null : filters.category, { none: null, includeArchived: true })}
      </select>
      ${seg([['month', monthLabel(month, true)], ['all', 'All time']], filters.scope, { name: 'scope' })}
      <div class="spacer"></div>
      <button class="btn btn-sm" id="tx-export" title="Download the filtered list as CSV">${icon('download', 'sm')} Export</button>
      <button class="btn btn-sm btn-primary" id="tx-add">${icon('plus', 'sm')} Add</button>
    </div>
    <div class="bulk-bar hidden" id="bulk">
      <span class="strong" id="bulk-n"></span>
      <select class="select sm" id="bulk-cat" style="width:210px"><option value="">Set category…</option><option value="__none">Clear category</option>${catOptions(null, null, { none: null })}</select>
      <button class="btn btn-sm btn-danger" id="bulk-del">${icon('trash', 'sm')} Delete</button>
      <div class="spacer"></div>
      <button class="btn btn-sm btn-ghost" id="bulk-clear">Clear selection</button>
    </div>
    <div class="card flush">
      <div class="summary-strip" id="tx-summary"></div>
      <div id="tx-list"><div class="skeleton" style="height:240px;margin:16px"></div></div>
    </div>
    <div class="center mt"><button class="btn hidden" id="tx-more">Load more</button></div>`;

  const query = (offset = 0) => ({
    month: filters.scope === 'month' ? month : '',
    q: filters.q,
    type: filters.type,
    category: filters.category === 'none' ? '' : filters.category,
    uncategorized: filters.category === 'none' ? '1' : '',
    limit: PAGE,
    offset,
  });

  async function load(append = false) {
    const r = await api.get(`/api/transactions${qs(query(append ? items.length : 0))}`);
    items = append ? items.concat(r.items) : r.items;
    total = r.total;
    if (!append) selected.clear();
    $('#tx-summary', el).innerHTML = `
      <div class="s"><div class="l">Transactions</div><div class="v">${total.toLocaleString()}</div></div>
      <div class="s"><div class="l">Income</div><div class="v money pos">${money(r.income_cents)}</div></div>
      <div class="s"><div class="l">Expenses</div><div class="v money neg">${money(r.expense_cents)}</div></div>
      <div class="s"><div class="l">Net</div><div class="v money ${r.income_cents - r.expense_cents >= 0 ? 'pos' : 'neg'}">${money(r.income_cents - r.expense_cents, { sign: true })}</div></div>`;
    drawList();
    $('#tx-more', el).classList.toggle('hidden', items.length >= total);
    setSubtitle(filters.scope === 'month' ? monthLabel(month) : 'All time');
  }

  function drawList() {
    const list = $('#tx-list', el);
    if (!items.length) {
      const filtered = filters.q || filters.type || filters.category;
      list.innerHTML = emptyState(filtered
        ? { icon: 'search', title: 'No matches', text: 'Try a different search or filter.' }
        : { icon: 'inbox', title: 'No transactions yet', text: 'Add one manually (press <kbd>N</kbd>) or import a CSV from your bank.', action: '<a class="btn btn-sm" href="#/import">Import CSV</a>' });
      return;
    }
    const groups = [];
    for (const t of items) {
      const g = groups[groups.length - 1];
      if (g && g.date === t.date) g.items.push(t);
      else groups.push({ date: t.date, items: [t] });
    }
    list.innerHTML = groups.map((g) => {
      const net = g.items.reduce((a, t) => a + (t.type === 'income' ? t.amount_cents : -t.amount_cents), 0);
      return `<div class="tx-day"><span>${dayLabel(g.date)}</span><span class="money">${money(net, { sign: true })}</span></div>
        ${g.items.map((t) => `
          <div class="tx-row ${selected.has(t.id) ? 'selected' : ''}" data-id="${t.id}">
            <input type="checkbox" data-check ${selected.has(t.id) ? 'checked' : ''} aria-label="Select">
            ${avatar(t.category_icon || (t.type === 'income' ? 'banknote' : 'help'), t.category_color || '#71717a', 'sm')}
            <div style="min-width:0">
              <div class="desc">${esc(t.description || t.category_name || 'Transaction')}</div>
              <div class="sub">${t.notes ? esc(t.notes) : t.source !== 'manual' ? `via ${esc(t.source)}` : '&nbsp;'}</div>
            </div>
            <div>${catChip(t.category_name, t.category_color)}</div>
            <div class="amt ${t.type === 'income' ? 'pos' : ''}">${signedMoney(t.type, t.amount_cents)}</div>
            <div class="row-actions"><button class="icon-btn sm danger" data-del title="Delete">${icon('trash', 'sm')}</button></div>
          </div>`).join('')}`;
    }).join('');
    updateBulk();
  }

  function updateBulk() {
    $('#bulk', el).classList.toggle('hidden', selected.size === 0);
    $('#bulk-n', el).textContent = `${selected.size} selected`;
  }

  // events
  $('#tx-list', el).addEventListener('click', async (e) => {
    const row = e.target.closest('.tx-row');
    if (!row) return;
    const id = Number(row.dataset.id);
    const t = items.find((x) => x.id === id);
    if (e.target.matches('[data-check]')) {
      if (e.target.checked) selected.add(id); else selected.delete(id);
      row.classList.toggle('selected', e.target.checked);
      updateBulk();
      return;
    }
    if (e.target.closest('[data-del]')) {
      if (!(await confirmDialog({ title: 'Delete transaction?', message: `${esc(t.description || 'This transaction')} · ${signedMoney(t.type, t.amount_cents)}` }))) return;
      await api.del(`/api/transactions/${id}`);
      toast('Transaction deleted');
      changed();
      return;
    }
    openTransactionForm(t);
  });
  $('#tx-q', el).addEventListener('input', debounce((e) => { filters.q = e.target.value.trim(); load(); }, 250));
  wireSeg($('.seg[data-name="type"]', el), (v) => { filters.type = v; load(); });
  wireSeg($('.seg[data-name="scope"]', el), (v) => { filters.scope = v; load(); });
  $('#tx-cat', el).addEventListener('change', (e) => { filters.category = e.target.value; load(); });
  $('#tx-add', el).addEventListener('click', () => openTransactionForm(null, { date: month === state.today.slice(0, 7) ? state.today : `${month}-01` }));
  $('#tx-more', el).addEventListener('click', () => load(true));
  $('#tx-export', el).addEventListener('click', () => {
    const { limit, offset, ...q } = query();
    download(`/api/transactions/export.csv${qs(q)}`);
  });
  $('#bulk-clear', el).addEventListener('click', () => { selected.clear(); drawList(); });
  $('#bulk-del', el).addEventListener('click', async () => {
    if (!(await confirmDialog({ title: `Delete ${selected.size} transactions?`, message: 'This cannot be undone.' }))) return;
    const r = await api.post('/api/transactions/bulk', { action: 'delete', ids: [...selected] });
    toast(`Deleted ${r.changed} transactions`);
    changed();
  });
  $('#bulk-cat', el).addEventListener('change', async (e) => {
    const v = e.target.value;
    if (!v) return;
    const r = await api.post('/api/transactions/bulk', { action: 'categorize', ids: [...selected], category_id: v === '__none' ? null : Number(v) });
    toast(r.skipped ? `Updated ${r.changed}. ${r.skipped} skipped (income/expense mismatch)` : `Updated ${r.changed} transactions`);
    changed();
  });

  await load();
}
