// Shared forms used from several screens.
import {
  api, state, esc, $, openModal, formData, requireMoney, moneyInput, catOptions, seg, wireSeg, todayStr, toast, changed,
  confirmDialog, debounce, qs, icon,
} from './core.js';

export function openTransactionForm(tx = null, { type = 'expense', date = null } = {}) {
  const editing = !!tx;
  const t = tx || { type, date: date || todayStr(), amount_cents: '', category_id: '', description: '', notes: '' };
  let userPickedCategory = editing && !!t.category_id;
  const body = `
    <div class="row between" style="margin-bottom:16px">
      ${seg([['expense', `${icon('down', 'sm')} Expense`], ['income', `${icon('up', 'sm')} Income`]], t.type, { cls: 'type', name: 'type' })}
      ${editing && t.source && t.source !== 'manual' ? `<span class="badge gray">from ${esc(t.source)}</span>` : ''}
    </div>
    <div class="form-grid">
      <div class="field full">
        <label>Amount</label>
        <div class="input-group"><span class="prefix">€</span><input class="input money-in" name="amount" inputmode="decimal" autocomplete="off" placeholder="0${esc(state.settings.locale === 'de-DE' ? ',' : '.')}00" value="${esc(moneyInput(t.amount_cents))}" autofocus style="height:52px;font-size:22px;font-weight:700"></div>
      </div>
      <div class="field full">
        <label>Description</label>
        <input class="input" name="description" maxlength="200" autocomplete="off" placeholder="e.g. Lidl, Rent, Salary" value="${esc(t.description)}">
      </div>
      <div class="field">
        <label>Category</label>
        <select class="select" name="category_id">${catOptions(t.type, t.category_id)}</select>
      </div>
      <div class="field">
        <label>Date</label>
        <input class="input" type="date" name="date" value="${esc(t.date)}" required>
      </div>
      <div class="field full">
        <label>Notes <span class="faint">(optional)</span></label>
        <textarea class="input" name="notes" maxlength="2000" rows="2" placeholder="Anything to remember">${esc(t.notes)}</textarea>
      </div>
      ${editing ? '' : `<label class="check full"><input type="checkbox" name="again"><span><span class="t">Add another after saving</span></span></label>`}
    </div>`;

  const m = openModal({
    title: editing ? 'Edit transaction' : 'New transaction',
    body,
    submitLabel: editing ? 'Save changes' : 'Add transaction',
    footLeft: editing ? `<button type="button" class="btn btn-danger btn-sm" data-delete>${icon('trash', 'sm')} Delete</button>` : '',
    onOpen(form) {
      const segEl = $('.seg', form);
      const catSel = form.elements.category_id;
      wireSeg(segEl, (v) => {
        catSel.innerHTML = catOptions(v, null);
        userPickedCategory = false;
        suggest();
      });
      catSel.addEventListener('change', () => { userPickedCategory = !!catSel.value; });
      const suggest = debounce(async () => {
        if (userPickedCategory) return;
        const description = form.elements.description.value.trim();
        if (description.length < 2) return;
        try {
          const r = await api.get(`/api/suggest-category${qs({ description, type: segEl.dataset.value })}`);
          if (r.category_id && !userPickedCategory) catSel.value = String(r.category_id);
        } catch { /* suggestions are best-effort */ }
      }, 300);
      form.elements.description.addEventListener('input', suggest);
      form.querySelector('[data-delete]')?.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: 'Delete transaction?', message: 'This cannot be undone.' }))) return;
        await api.del(`/api/transactions/${t.id}`);
        toast('Transaction deleted');
        m.close();
        changed();
      });
    },
    async onSubmit(form) {
      const d = formData(form);
      const payload = {
        type: $('.seg', form).dataset.value,
        amount_cents: requireMoney(d.amount, 'amount'),
        description: d.description,
        category_id: d.category_id || null,
        date: d.date,
        notes: d.notes,
      };
      if (!payload.date) throw new Error('Pick a date');
      if (editing) await api.put(`/api/transactions/${t.id}`, payload);
      else await api.post('/api/transactions', payload);
      toast(editing ? 'Transaction updated' : 'Transaction added');
      changed();
      if (!editing && d.again) {
        form.elements.amount.value = '';
        form.elements.description.value = '';
        form.elements.notes.value = '';
        userPickedCategory = false;
        form.elements.amount.focus();
        return false;
      }
      return true;
    },
  });
  return m;
}
