import {
  api, esc, $, $$, icon, money, moneyInput, pct, fmtDate, todayStr, ring, emptyState, openModal, formData, requireMoney,
  toast, changed, confirmDialog, PALETTE, parseMoney, hexA, glyph,
} from '../core.js';
import { iconPicker, wireIconPicker } from '../icons.js';

const KINDS = { goal: ['Savings goal', 'violet'], sinking: ['Sinking fund', 'blue'], emergency: ['Emergency fund', 'green'] };
const STATUS = {
  done: ['Reached', 'green'], on_track: ['On track', 'green'], behind: ['Behind', 'amber'], overdue: ['Past date', 'red'],
  no_date: ['No deadline', 'gray'], no_target: ['Open-ended', 'gray'],
};
const TEMPLATES = [
  { icon: 'plane', name: 'Trip', kind: 'goal', color: '#22d3ee' },
  { icon: 'laptop', name: 'New laptop', kind: 'goal', color: '#a78bfa' },
  { icon: 'phone', name: 'New phone', kind: 'goal', color: '#818cf8' },
  { icon: 'car', name: 'Car', kind: 'goal', color: '#fb923c' },
  { icon: 'home', name: 'Home deposit', kind: 'goal', color: '#f472b6' },
  { icon: 'lifebuoy', name: 'Emergency fund', kind: 'emergency', color: '#34d399' },
  { icon: 'gift', name: 'Holiday gifts', kind: 'sinking', color: '#fb7185' },
  { icon: 'receipt', name: 'Annual bills', kind: 'sinking', color: '#fbbf24' },
  { icon: 'grad', name: 'Course', kind: 'goal', color: '#a3e635' },
];

export async function render(el, { setSubtitle }) {
  const { goals, emergency } = await api.get('/api/goals');
  const active = goals.filter((g) => !g.archived);
  const archived = goals.filter((g) => g.archived);
  const totalSaved = active.reduce((a, g) => a + g.saved_cents, 0);
  const totalTarget = active.reduce((a, g) => a + g.target_cents, 0);
  const monthly = active.reduce((a, g) => a + g.monthly_cents, 0);
  const thisMonth = active.reduce((a, g) => a + g.this_month_cents, 0);
  const hasEmergency = active.some((g) => g.kind === 'emergency');
  setSubtitle(active.length ? `${active.length} active goal${active.length > 1 ? 's' : ''}` : 'Save for the things that matter');

  el.innerHTML = `
    <div class="grid cols-4">
      <div class="card kpi tone-violet"><div class="label"><span class="dot violet">${icon('piggy', 'sm')}</span>Total saved</div><div class="value money">${money(totalSaved)}</div><div class="foot">${totalTarget ? `${pct(totalSaved / totalTarget)} of ${money(totalTarget, { whole: true })}` : 'across all goals'}</div></div>
      <div class="card kpi tone-cyan"><div class="label"><span class="dot cyan">${icon('calendar', 'sm')}</span>This month</div><div class="value money">${money(thisMonth)}</div><div class="foot">planned ${money(monthly, { whole: true })}/month</div></div>
      <div class="card kpi tone-green"><div class="label"><span class="dot green">${icon('goals', 'sm')}</span>Still to save</div><div class="value money">${money(Math.max(0, totalTarget - totalSaved))}</div><div class="foot">${active.filter((g) => g.status === 'done').length} goal(s) reached</div></div>
      <div class="card kpi tone-amber"><div class="label"><span class="dot amber">${icon('lifebuoy', 'sm')}</span>Emergency fund</div><div class="value money">${money(emergency.suggested_cents, { whole: true })}</div><div class="foot">suggested: ${emergency.months_target} months of ${emergency.monthly_essentials_cents ? 'essentials' : 'spending'}${emergency.monthly_essentials_cents || emergency.monthly_expenses_cents ? ` (${money(emergency.monthly_essentials_cents || emergency.monthly_expenses_cents, { whole: true })}/mo)` : ''}</div></div>
    </div>

    <div class="card mt">
      <div class="row wrap" style="gap:12px">
        <div style="flex:1;min-width:240px"><h3 style="font-size:15px">Start a new goal</h3><div class="muted small">Pick a template or start from scratch. Sinking funds are for known future costs, like yearly insurance or gifts.</div></div>
        <button class="btn btn-primary" data-new>${icon('plus', 'sm')} New goal</button>
      </div>
      <div class="template-chips mt">
        ${TEMPLATES.filter((t) => !(t.kind === 'emergency' && hasEmergency)).map((t, i) => `<button class="chip clickable" data-tpl="${i}">${icon(t.icon, 'sm')} ${esc(t.name)}</button>`).join('')}
      </div>
    </div>

    ${active.length ? `<div class="grid cols-3 mt">${active.map(goalCard).join('')}</div>`
    : `<div class="card mt">${emptyState({ icon: 'target', title: 'No goals yet', text: 'Create a goal for a trip, a new laptop or an emergency fund, then add money to it whenever you save.' })}</div>`}

    ${archived.length ? `<details class="more mt"><summary>${icon('right', 'sm')} Archived goals (${archived.length})</summary><div class="grid cols-3 mt">${archived.map(goalCard).join('')}</div></details>` : ''}`;

  el.querySelector('[data-new]').addEventListener('click', () => goalForm());
  $$('[data-tpl]', el).forEach((b) => b.addEventListener('click', () => {
    const t = TEMPLATES[Number(b.dataset.tpl)];
    goalForm({ ...t, target_cents: t.kind === 'emergency' ? emergency.suggested_cents : '' });
  }));
  $$('[data-goal]', el).forEach((card) => {
    const g = goals.find((x) => x.id === Number(card.dataset.goal));
    card.querySelector('[data-add]')?.addEventListener('click', () => entryForm(g, 1));
    card.querySelector('[data-withdraw]')?.addEventListener('click', () => entryForm(g, -1));
    card.querySelector('[data-history]')?.addEventListener('click', () => historyModal(g));
    card.querySelector('[data-edit]')?.addEventListener('click', () => goalForm(g));
  });
}

function goalCard(g) {
  const [kindLabel, kindTone] = KINDS[g.kind] || KINDS.goal;
  const [statusLabel, statusTone] = STATUS[g.status] || STATUS.no_target;
  const needed = g.needed_monthly_cents;
  return `<div class="card goal-card" data-goal="${g.id}" style="${g.archived ? 'opacity:.6' : ''};background:radial-gradient(120% 90% at 100% 0%, ${hexA(g.color, 0.14)}, transparent 60%), var(--panel)">
    <div class="top">
      ${ring(g.progress, { size: 76, stroke: 7, color: g.color, label: `<span style="color:${esc(g.color)};display:grid">${glyph(g.icon)}</span>` })}
      <div style="min-width:0;flex:1">
        <div class="row" style="gap:6px;flex-wrap:wrap"><span class="badge ${kindTone}">${kindLabel}</span><span class="badge ${statusTone}">${statusLabel}</span></div>
        <h3 style="font-size:17px;margin-top:6px" class="ellipsis">${esc(g.name)}</h3>
        <div class="money" style="font-size:20px;font-weight:700">${money(g.saved_cents)}${g.target_cents ? `<span class="muted" style="font-size:13px;font-weight:500"> / ${money(g.target_cents, { whole: true })}</span>` : ''}</div>
      </div>
    </div>
    <div class="stats">
      <div class="stat"><div class="l">${g.target_cents ? 'Progress' : 'Saved'}</div><div class="v">${g.target_cents ? pct(g.progress) : money(g.saved_cents, { whole: true })}</div></div>
      <div class="stat"><div class="l">Target date</div><div class="v">${g.target_date ? fmtDate(g.target_date, { year: true }) : '–'}</div></div>
      <div class="stat"><div class="l">${needed !== null ? 'Needed / mo' : 'Plan / mo'}</div><div class="v money ${needed !== null && g.status === 'behind' ? 'warn-text' : ''}">${needed !== null ? money(needed, { whole: true }) : g.monthly_cents ? money(g.monthly_cents, { whole: true }) : '–'}</div></div>
    </div>
    ${g.status !== 'done' && g.target_cents ? `<div class="small muted">${g.projected_date ? `At ${money(g.monthly_cents || g.avg_monthly_cents, { whole: true })}/month you'll get there around <span class="strong" style="color:var(--text)">${fmtDate(g.projected_date, { year: true })}</span>.` : 'Set a monthly amount or add money to see when you will reach it.'}</div>` : ''}
    ${g.notes ? `<div class="small faint">${esc(g.notes)}</div>` : ''}
    <div class="actions">
      <button class="btn btn-sm btn-primary" data-add>${icon('plus', 'sm')} Add money</button>
      <button class="btn btn-sm" data-withdraw ${g.saved_cents <= 0 ? 'disabled' : ''}>${icon('minus', 'sm')} Withdraw</button>
      <div class="spacer"></div>
      <button class="icon-btn" data-history title="History">${icon('history', 'sm')}</button>
      <button class="icon-btn" data-edit title="Edit">${icon('edit', 'sm')}</button>
    </div>
  </div>`;
}

function goalForm(g = null) {
  const editing = !!(g && g.id);
  const v = { name: '', icon: 'target', color: PALETTE[0], kind: 'goal', target_cents: '', target_date: '', monthly_cents: '', notes: '', ...(g || {}) };
  const m = openModal({
    title: editing ? 'Edit goal' : 'New savings goal',
    body: `
      <div class="form-grid">
        <div class="field full"><label>Name</label><input class="input" name="name" maxlength="60" value="${esc(v.name)}" placeholder="e.g. Trip to Japan" autofocus></div>
        <div class="field full"><label>Icon</label>${iconPicker(v.icon)}</div>
        <div class="field"><label>Type</label>
          <select class="select" name="kind">${Object.entries(KINDS).map(([k, [l]]) => `<option value="${k}" ${v.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <span class="hint">Emergency funds are counted in the safety-net insight.</span></div>
        <div class="field"><label>Target amount</label><div class="input-group"><span class="prefix">€</span><input class="input money-in" name="target" inputmode="decimal" value="${esc(moneyInput(v.target_cents || ''))}" placeholder="optional"></div></div>
        <div class="field"><label>Target date</label><input class="input" type="date" name="target_date" value="${esc(v.target_date || '')}"></div>
        <div class="field"><label>Plan to save per month</label><div class="input-group"><span class="prefix">€</span><input class="input money-in" name="monthly" inputmode="decimal" value="${esc(moneyInput(v.monthly_cents || ''))}" placeholder="optional"></div>
          <span class="hint" id="needed-hint"></span></div>
        ${editing ? '' : `<div class="field"><label>Already saved</label><div class="input-group"><span class="prefix">€</span><input class="input money-in" name="initial" inputmode="decimal" placeholder="0"></div></div>`}
        <div class="field full"><label>Colour</label><div class="swatches">${PALETTE.slice(0, 10).map((c) => `<button type="button" data-color="${c}" class="${c === v.color ? 'on' : ''}" style="background:${c}"></button>`).join('')}</div><input type="hidden" name="color" value="${esc(v.color)}"></div>
        <div class="field full"><label>Notes</label><textarea class="input" name="notes" rows="2" maxlength="2000">${esc(v.notes)}</textarea></div>
        ${editing ? `<label class="check full"><input type="checkbox" name="archived" ${v.archived ? 'checked' : ''}><span><span class="t">Archive this goal</span><div class="d">Hides it from the dashboard but keeps the history.</div></span></label>` : ''}
      </div>`,
    submitLabel: editing ? 'Save goal' : 'Create goal',
    footLeft: editing ? `<button type="button" class="btn btn-danger btn-sm" data-delete>${icon('trash', 'sm')} Delete</button>` : '',
    onOpen(form) {
      wireIconPicker(form);
      $$('[data-color]', form).forEach((b) => b.addEventListener('click', () => {
        $$('[data-color]', form).forEach((x) => x.classList.toggle('on', x === b));
        form.elements.color.value = b.dataset.color;
      }));
      const hint = () => {
        const target = parseMoney(form.elements.target.value) || 0;
        const initial = form.elements.initial ? parseMoney(form.elements.initial.value) || 0 : (g?.saved_cents || 0);
        const date = form.elements.target_date.value;
        const h = $('#needed-hint', form);
        if (!target || !date) { h.textContent = ''; return; }
        const [ty, tm] = date.split('-').map(Number);
        const now = new Date();
        const months = Math.max(1, (ty - now.getFullYear()) * 12 + (tm - (now.getMonth() + 1)));
        h.textContent = `To hit the target you need about ${money(Math.ceil(Math.max(0, target - initial) / months), { whole: true })}/month for ${months} months.`;
      };
      ['target', 'target_date', 'initial'].forEach((n) => form.elements[n]?.addEventListener('input', hint));
      hint();
      form.querySelector('[data-delete]')?.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: `Delete "${esc(v.name)}"?`, message: 'The goal and all its contribution history will be removed. Consider archiving instead.' }))) return;
        await api.del(`/api/goals/${v.id}`);
        toast('Goal deleted');
        m.close();
        changed();
      });
    },
    async onSubmit(form) {
      const d = formData(form);
      const optMoney = (x, label) => (x.trim() === '' ? 0 : requireMoney(x, label, { allowZero: true }));
      const payload = {
        name: d.name, icon: d.icon || 'target', kind: d.kind, color: d.color,
        target_cents: optMoney(d.target, 'target'), target_date: d.target_date || null,
        monthly_cents: optMoney(d.monthly, 'monthly amount'), notes: d.notes,
      };
      if (!payload.name.trim()) throw new Error('Give your goal a name');
      if (editing) {
        await api.put(`/api/goals/${v.id}`, { ...payload, archived: d.archived });
      } else {
        await api.post('/api/goals', { ...payload, initial_cents: optMoney(d.initial || '', 'starting amount') });
      }
      toast(editing ? 'Goal saved' : 'Goal created');
      changed();
    },
  });
}

function entryForm(g, direction) {
  const adding = direction > 0;
  openModal({
    title: `${adding ? 'Add money to' : 'Withdraw from'} ${g.name}`,
    body: `
      <div class="form-grid">
        <div class="field full"><label>Amount</label><div class="input-group"><span class="prefix">€</span><input class="input money-in" name="amount" inputmode="decimal" autofocus style="height:52px;font-size:22px;font-weight:700" value="${adding && g.monthly_cents ? esc(moneyInput(g.monthly_cents)) : ''}"></div>
          <span class="hint">${adding ? (g.remaining_cents ? `${money(g.remaining_cents)} to go` : '') : `${money(g.saved_cents)} available`}</span></div>
        <div class="field"><label>Date</label><input class="input" type="date" name="date" value="${todayStr()}"></div>
        <div class="field"><label>Note</label><input class="input" name="note" maxlength="200" placeholder="${adding ? 'e.g. Payday transfer' : 'e.g. Booked flights'}"></div>
      </div>
      <p class="small muted" style="margin-bottom:0">${adding ? 'This moves money from your cash into the goal. It is not counted as spending.' : 'Withdrawn money goes back into your cash. If you spent it, also log the purchase as an expense.'}</p>`,
    submitLabel: adding ? 'Add money' : 'Withdraw',
    async onSubmit(form) {
      const d = formData(form);
      const c = requireMoney(d.amount, 'amount');
      await api.post(`/api/goals/${g.id}/entries`, { amount_cents: adding ? c : -c, date: d.date, note: d.note });
      toast(adding ? `${money(c)} added to ${g.name}` : `${money(c)} withdrawn`);
      changed();
    },
  });
}

async function historyModal(g) {
  const entries = await api.get(`/api/goals/${g.id}/entries`);
  const m = openModal({
    title: `${g.name}: history`,
    wide: true,
    submitLabel: null,
    cancelLabel: 'Close',
    body: entries.length ? `<div class="table-wrap"><table class="table compact"><thead><tr><th>Date</th><th>Note</th><th class="num">Amount</th><th></th></tr></thead><tbody>
      ${entries.map((e) => `<tr><td class="nowrap">${fmtDate(e.date, { year: true })}</td><td>${esc(e.note || '–')}</td><td class="num money ${e.amount_cents < 0 ? 'neg' : 'pos'}">${money(e.amount_cents, { sign: true })}</td>
        <td class="num"><button class="icon-btn sm danger" data-del="${e.id}" title="Delete entry">${icon('trash', 'sm')}</button></td></tr>`).join('')}
      </tbody></table></div>` : emptyState({ icon: 'coins', title: 'No contributions yet' }),
    onOpen(form) {
      $$('[data-del]', form).forEach((b) => b.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: 'Delete this entry?', message: 'The goal balance will be adjusted.' }))) return;
        await api.del(`/api/goal-entries/${b.dataset.del}`);
        toast('Entry deleted');
        m.close();
        changed();
      }));
    },
  });
}
