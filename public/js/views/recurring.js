import {
  api, state, esc, $, $$, icon, money, moneyInput, fmtDate, relDays, todayStr, toDate, catOptions, seg, wireSeg, avatar,
  emptyState, openModal, formData, requireMoney, toast, changed, confirmDialog, signedMoney, monthLabel,
} from '../core.js';
import { iconPicker, wireIconPicker } from '../icons.js';

const FREQ = { weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly', quarterly: 'Quarterly', semiannual: 'Every 6 months', yearly: 'Yearly' };
const SUB_PRESETS = [
  ['Netflix', 'film', 1399], ['Spotify', 'headphones', 1099], ['YouTube Premium', 'play', 1299], ['Disney+', 'film', 999], ['Apple One', 'phone', 1995],
  ['iCloud+', 'cloud', 299], ['Amazon Prime', 'box', 899], ['ChatGPT / Claude', 'bot', 2000], ['Gym', 'dumbbell', 2990], ['Xbox / PlayStation', 'gamepad', 999],
];
let tab = 'all';

export async function render(el, { setSubtitle }) {
  const data = await api.get('/api/recurring');
  const { items, upcoming, totals } = data;
  setSubtitle('Salary, rent, bills and subscriptions, logged automatically if you like');
  const due = upcoming.filter((u) => u.is_next && !u.autopay && u.date <= todayStr());

  el.innerHTML = `
    <div class="grid cols-4">
      <div class="card kpi tone-green"><div class="label"><span class="dot green">${icon('up', 'sm')}</span>Recurring income</div><div class="value money">${money(totals.income_monthly_cents)}</div><div class="foot">per month</div></div>
      <div class="card kpi tone-red"><div class="label"><span class="dot red">${icon('down', 'sm')}</span>Bills</div><div class="value money">${money(totals.bills_monthly_cents)}</div><div class="foot">per month on average</div></div>
      <div class="card kpi tone-violet"><div class="label"><span class="dot violet">${icon('tv', 'sm')}</span>Subscriptions</div><div class="value money">${money(totals.subs_monthly_cents)}</div><div class="foot">${money(totals.subs_monthly_cents * 12, { whole: true })} per year</div></div>
      <div class="card kpi tone-cyan"><div class="label"><span class="dot cyan">${icon('wallet', 'sm')}</span>Left after fixed costs</div><div class="value money ${totals.income_monthly_cents - totals.bills_monthly_cents - totals.subs_monthly_cents < 0 ? 'neg' : ''}">${money(totals.income_monthly_cents - totals.bills_monthly_cents - totals.subs_monthly_cents)}</div><div class="foot">for spending, saving & investing</div></div>
    </div>

    ${due.length ? `<div class="card mt" style="border-color:rgba(251,191,36,.35)">
      <div class="card-head"><h3>Needs attention</h3><span class="badge amber">${due.length} due</span></div>
      <div class="list">${due.map((u) => upcomingRow(u, true)).join('')}</div>
    </div>` : ''}

    <div class="grid cols-3 mt">
      <div class="card span-2">
        <div class="card-head">
          ${seg([['all', 'All'], ['bills', 'Bills'], ['subs', 'Subscriptions'], ['income', 'Income']], tab, { name: 'tab' })}
          <div class="actions"><button class="btn btn-sm btn-primary" data-new>${icon('plus', 'sm')} Add recurring</button></div>
        </div>
        <div id="rec-list"></div>
      </div>
      <div class="card">
        <div class="card-head"><h3>Coming up</h3><span class="sub">next 45 days</span></div>
        ${upcoming.length ? `<div class="list">${upcoming.slice(0, 12).map((u) => upcomingRow(u, false)).join('')}</div>` : emptyState({ icon: 'calendar', title: 'Nothing scheduled' })}
      </div>
    </div>

    <div class="card mt">
      <div class="card-head"><h3>Bill calendar</h3><span class="sub">${monthLabel(state.today.slice(0, 7))}</span></div>
      ${calendar(upcoming, items)}
    </div>`;

  const list = $('#rec-list', el);
  const drawList = () => {
    const filtered = items.filter((r) => tab === 'all' || (tab === 'income' ? r.type === 'income' : tab === 'subs' ? r.subscription && r.type === 'expense' : r.type === 'expense' && !r.subscription));
    list.innerHTML = filtered.length ? `<div class="list">${filtered.map((r) => `
      <div class="list-item clickable" data-id="${r.id}" style="${r.active ? '' : 'opacity:.5'}">
        ${avatar(r.icon || r.category_icon || (r.type === 'income' ? 'banknote' : 'receipt'), r.category_color, '')}
        <div class="grow">
          <div class="title">${esc(r.name)} ${r.subscription ? '<span class="badge violet">sub</span>' : ''} ${r.autopay ? '<span class="badge blue">auto-log</span>' : ''} ${r.active ? '' : '<span class="badge gray">paused</span>'}</div>
          <div class="meta">${FREQ[r.frequency]} · next ${fmtDate(r.next_due)} (${relDays(r.next_due)})${r.category_name ? ` · ${esc(r.category_name)}` : ''}${r.last_paid ? ` · last logged ${fmtDate(r.last_paid)}` : ''}</div>
        </div>
        <div class="right"><div class="money strong ${r.type === 'income' ? 'pos' : ''}">${signedMoney(r.type, r.amount_cents)}</div>${r.frequency !== 'monthly' ? `<div class="tiny faint money">≈ ${money(r.monthly_cents)}/mo</div>` : ''}</div>
      </div>`).join('')}</div>`
      : emptyState({ icon: tab === 'income' ? 'briefcase' : tab === 'subs' ? 'tv' : 'receipt', title: tab === 'income' ? 'No recurring income' : tab === 'subs' ? 'No subscriptions' : 'Nothing here yet', text: tab === 'income' ? 'Add your salary so it is logged automatically each payday.' : 'Add rent, phone, insurance or subscriptions. They can be logged automatically on the due date.' });
    $$('[data-id]', list).forEach((row) => row.addEventListener('click', () => recurringForm(items.find((x) => x.id === Number(row.dataset.id)))));
  };
  wireSeg($('.seg[data-name="tab"]', el), (v) => { tab = v; drawList(); });
  drawList();

  el.querySelector('[data-new]').addEventListener('click', () => recurringForm(null, tab === 'income' ? 'income' : 'expense', tab === 'subs'));
  $$('[data-pay]', el).forEach((b) => b.addEventListener('click', () => payForm(items.find((x) => x.id === Number(b.dataset.pay)))));
  $$('[data-skip]', el).forEach((b) => b.addEventListener('click', async () => {
    const r = items.find((x) => x.id === Number(b.dataset.skip));
    if (!(await confirmDialog({ title: `Skip ${esc(r.name)}?`, message: `The ${fmtDate(r.next_due)} occurrence will be skipped without logging a transaction.`, confirmLabel: 'Skip', danger: false }))) return;
    await api.post(`/api/recurring/${r.id}/skip`);
    toast('Skipped');
    changed();
  }));
}

function upcomingRow(u, big) {
  return `<div class="list-item">
    ${avatar(u.icon || (u.type === 'income' ? 'banknote' : 'receipt'), u.color, 'sm')}
    <div class="grow"><div class="title">${esc(u.name)}</div>
      <div class="meta">${u.overdue ? '<span class="neg strong">Overdue</span> · ' : ''}${fmtDate(u.date)} · ${relDays(u.date)}${u.autopay ? ' · auto' : ''}</div></div>
    <span class="money strong ${u.type === 'income' ? 'pos' : ''}">${signedMoney(u.type, u.amount_cents)}</span>
    ${!u.autopay && u.is_next ? `<div class="row" style="gap:4px"><button class="btn btn-xs ${big ? 'btn-primary' : ''}" data-pay="${u.recurring_id}">${icon('check', 'sm')} ${u.type === 'income' ? 'Received' : 'Paid'}</button>${big ? `<button class="btn btn-xs btn-ghost" data-skip="${u.recurring_id}" title="Skip this one">${icon('skip', 'sm')}</button>` : ''}</div>` : ''}
  </div>`;
}

function calendar(upcoming, items) {
  const month = state.today.slice(0, 7);
  const first = toDate(`${month}-01`);
  const daysIn = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const offset = (first.getDay() + 6) % 7; // Monday first
  const events = {};
  // upcoming occurrences + already logged ones this month
  for (const u of upcoming) if (u.date.startsWith(month)) (events[u.date] ||= []).push(u);
  for (const r of items) {
    if (r.last_paid && r.last_paid.startsWith(month) && !(events[r.last_paid] || []).some((e) => e.recurring_id === r.id)) {
      (events[r.last_paid] ||= []).push({ name: r.name, type: r.type, amount_cents: r.amount_cents, done: true, recurring_id: r.id });
    }
  }
  const cells = [];
  ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach((d) => cells.push(`<div class="dow">${d}</div>`));
  for (let i = 0; i < offset; i++) cells.push('<div class="day out"></div>');
  for (let d = 1; d <= daysIn; d++) {
    const date = `${month}-${String(d).padStart(2, '0')}`;
    const ev = events[date] || [];
    cells.push(`<div class="day ${date === state.today ? 'today' : ''}"><span class="n">${d}</span>${ev.map((e) => `<span class="ev ${e.type === 'income' ? 'inc' : ''}" style="${e.done ? 'opacity:.55' : ''}" title="${esc(e.name)}: ${money(e.amount_cents)}">${esc(e.name)}</span>`).join('')}</div>`);
  }
  return `<div class="cal">${cells.join('')}</div>`;
}

function recurringForm(r = null, type = 'expense', subscription = false) {
  const editing = !!r;
  const v = r || { name: '', type, amount_cents: '', category_id: '', frequency: 'monthly', next_due: todayStr(), autopay: type === 'income' ? 1 : 0, subscription: subscription ? 1 : 0, active: 1, icon: '', notes: '' };
  const m = openModal({
    title: editing ? `Edit ${r.name}` : 'New recurring item',
    body: `
      <div class="row between" style="margin-bottom:14px">${seg([['expense', 'Bill / expense'], ['income', 'Income']], v.type, { cls: 'type', name: 'type' })}</div>
      ${editing ? '' : `<div class="template-chips" style="margin-bottom:14px" data-presets>${SUB_PRESETS.map(([n, ic], i) => `<button type="button" class="chip clickable" data-preset="${i}">${icon(ic, 'sm')} ${esc(n)}</button>`).join('')}</div>`}
      <div class="form-grid">
        <div class="field"><label>Name</label><input class="input" name="name" maxlength="80" value="${esc(v.name)}" placeholder="e.g. Rent, Salary, Netflix" autofocus></div>
        <div class="field"><label>Amount</label><div class="input-group"><span class="prefix">€</span><input class="input money-in" name="amount" inputmode="decimal" value="${esc(moneyInput(v.amount_cents))}"></div></div>
        <div class="field"><label>How often</label><select class="select" name="frequency">${Object.entries(FREQ).map(([k, l]) => `<option value="${k}" ${v.frequency === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field"><label>Next due date</label><input class="input" type="date" name="next_due" value="${esc(v.next_due)}"></div>
        <div class="field"><label>Category</label><select class="select" name="category_id">${catOptions(v.type, v.category_id)}</select></div>
        <div class="field full"><label>Icon <span class="faint">(optional, otherwise the category icon is used)</span></label>${iconPicker(v.icon)}</div>
        <label class="check full"><input type="checkbox" name="autopay" ${v.autopay ? 'checked' : ''}><span><span class="t">Log automatically on the due date</span><div class="d">Good for direct debits and salary. Otherwise it waits for you to mark it paid.</div></span></label>
        <label class="check full" data-sub-row><input type="checkbox" name="subscription" ${v.subscription ? 'checked' : ''}><span><span class="t">This is a subscription</span><div class="d">Counted in your yearly subscription total.</div></span></label>
        ${editing ? `<label class="check full"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}><span><span class="t">Active</span><div class="d">Untick to pause without deleting.</div></span></label>` : ''}
        <div class="field full"><label>Notes</label><input class="input" name="notes" maxlength="2000" value="${esc(v.notes)}"></div>
      </div>
      <p class="small muted" style="margin-bottom:0">If the first due date is in the past and auto-log is on, the missed occurrences are logged straight away.</p>`,
    submitLabel: editing ? 'Save' : 'Add',
    footLeft: editing ? `<button type="button" class="btn btn-danger btn-sm" data-delete>${icon('trash', 'sm')} Delete</button>` : '',
    onOpen(form) {
      const picker = wireIconPicker(form);
      const segEl = $('.seg', form);
      wireSeg(segEl, (t) => {
        form.elements.category_id.innerHTML = catOptions(t, null);
        form.querySelector('[data-sub-row]').classList.toggle('hidden', t === 'income');
        if (t === 'income') form.elements.subscription.checked = false;
      });
      form.querySelector('[data-sub-row]').classList.toggle('hidden', v.type === 'income');
      $$('[data-preset]', form).forEach((b) => b.addEventListener('click', () => {
        const [n, ic, amt] = SUB_PRESETS[Number(b.dataset.preset)];
        form.elements.name.value = n;
        picker.set(ic);
        form.elements.amount.value = moneyInput(amt);
        form.elements.subscription.checked = !['Gym'].includes(n);
        form.elements.autopay.checked = true;
        const subs = state.categories.find((c) => c.name === (n === 'Gym' ? 'Health' : 'Subscriptions') && c.kind === 'expense');
        if (subs) form.elements.category_id.value = String(subs.id);
        form.elements.amount.focus();
      }));
      form.querySelector('[data-delete]')?.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: `Delete ${esc(v.name)}?`, message: 'Transactions already logged from it are kept.' }))) return;
        await api.del(`/api/recurring/${v.id}`);
        toast('Deleted');
        m.close();
        changed();
      });
    },
    async onSubmit(form) {
      const d = formData(form);
      const payload = {
        name: d.name, type: $('.seg', form).dataset.value, amount_cents: requireMoney(d.amount, 'amount'), frequency: d.frequency,
        next_due: d.next_due, category_id: d.category_id || null, icon: d.icon, autopay: d.autopay, subscription: d.subscription, notes: d.notes,
        ...(editing ? { active: d.active } : {}),
      };
      if (!payload.name.trim()) throw new Error('Give it a name');
      if (!payload.next_due) throw new Error('Pick the next due date');
      const res = editing ? await api.put(`/api/recurring/${v.id}`, payload) : await api.post('/api/recurring', payload);
      toast(res.auto_posted ? `Saved, and ${res.auto_posted} past occurrence${res.auto_posted > 1 ? 's' : ''} logged` : 'Saved');
      changed();
    },
  });
}

function payForm(r) {
  openModal({
    title: `${r.type === 'income' ? 'Received' : 'Pay'}: ${r.name}`,
    body: `<div class="form-grid">
      <div class="field"><label>Amount</label><div class="input-group"><span class="prefix">€</span><input class="input money-in" name="amount" inputmode="decimal" value="${esc(moneyInput(r.amount_cents))}" autofocus></div><span class="hint">Change it if this one was different</span></div>
      <div class="field"><label>Date</label><input class="input" type="date" name="date" value="${esc(r.next_due <= todayStr() ? r.next_due : todayStr())}"></div>
    </div><p class="small muted" style="margin-bottom:0">A transaction will be logged and the next due date moves forward.</p>`,
    submitLabel: r.type === 'income' ? 'Log income' : 'Mark paid',
    async onSubmit(form) {
      const d = formData(form);
      await api.post(`/api/recurring/${r.id}/pay`, { amount_cents: requireMoney(d.amount, 'amount'), date: d.date });
      toast('Logged');
      changed();
    },
  });
}
