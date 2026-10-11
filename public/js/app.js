// App shell: navigation, routing, month switcher, global shortcuts.
import {
  state, api, $, $$, icon, esc, money, monthLabel, shiftMonth, toast, reloadBootstrap, setupCharts, destroyCharts, isModalOpen,
} from './core.js';
import { openTransactionForm } from './forms.js';

const ROUTES = {
  dashboard: { title: 'Dashboard', icon: 'dashboard', month: true, load: () => import('./views/dashboard.js') },
  transactions: { title: 'Transactions', icon: 'transactions', month: true, load: () => import('./views/transactions.js') },
  budget: { title: 'Budget', icon: 'budget', month: true, load: () => import('./views/budget.js') },
  goals: { title: 'Savings goals', icon: 'goals', month: false, load: () => import('./views/goals.js') },
  investments: { title: 'Investments', icon: 'investments', month: false, load: () => import('./views/investments.js') },
  recurring: { title: 'Bills & income', icon: 'recurring', month: false, load: () => import('./views/recurring.js') },
  debts: { title: 'Debt payoff', icon: 'debts', month: false, load: () => import('./views/debts.js') },
  reports: { title: 'Reports', icon: 'reports', month: false, load: () => import('./views/reports.js') },
  import: { title: 'Import', icon: 'import', month: false, load: () => import('./views/import.js') },
  settings: { title: 'Settings', icon: 'settings', month: false, load: () => import('./views/settings.js') },
};
const NAV = [
  ['Overview', ['dashboard', 'transactions', 'budget']],
  ['Grow', ['goals', 'investments']],
  ['Plan', ['recurring', 'debts', 'reports']],
  ['Data', ['import', 'settings']],
];

let current = { name: null, params: {}, cleanup: null };
let renderToken = 0;

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [name, query = ''] = raw.split('?');
  return { name: ROUTES[name] ? name : 'dashboard', params: Object.fromEntries(new URLSearchParams(query)) };
}

function renderNav() {
  $('#nav').innerHTML = NAV.map(([section, items]) => `
    <div class="nav-section">${section}</div>
    ${items.map((n) => `<a href="#/${n}" data-route="${n}">${icon(ROUTES[n].icon)}<span>${ROUTES[n].title}</span><span class="badge-dot hidden" data-badge="${n}"></span></a>`).join('')}
  `).join('');
}

function setActiveNav(name) {
  $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
}

function updateMonthLabel() {
  $('#month-label').textContent = monthLabel(state.month);
}

async function refreshSidebar() {
  try {
    const nw = await api.get('/api/networth');
    $('#networth-mini').innerHTML = `
      <div class="label">Net worth</div>
      <div class="value money ${nw.net_worth_cents < 0 ? 'neg' : ''}">${money(nw.net_worth_cents)}</div>
      <div class="rows">
        <div><span>Cash</span><span class="money">${money(nw.cash_cents)}</span></div>
        <div><span>Savings</span><span class="money">${money(nw.goals_cents)}</span></div>
        <div><span>Investments</span><span class="money">${money(nw.investments_cents)}</span></div>
        ${nw.debts_cents ? `<div><span>Debts</span><span class="money neg">−${money(nw.debts_cents)}</span></div>` : ''}
      </div>`;
  } catch { /* sidebar is non-critical */ }
}

async function render({ keepScroll = false } = {}) {
  const { name, params } = parseHash();
  const route = ROUTES[name];
  const token = ++renderToken;
  const view = $('#view');
  const scroll = window.scrollY;
  setActiveNav(name);
  $('#page-title').textContent = route.title;
  $('#page-subtitle').textContent = '';
  $('#month-switch').classList.toggle('hidden', !route.month);
  document.title = `${route.title} · Moneta`;
  document.body.classList.remove('nav-open');
  view.classList.add('loading');
  try {
    const mod = await route.load();
    if (token !== renderToken) return;
    if (current.cleanup) { try { current.cleanup(); } catch { /* ignore */ } }
    destroyCharts();
    const container = document.createElement('div');
    container.className = keepScroll && current.name === name ? '' : 'fade-in';
    const cleanup = await mod.render(container, { params, month: state.month, setSubtitle: (s) => { $('#page-subtitle').textContent = s; } });
    if (token !== renderToken) { if (typeof cleanup === 'function') cleanup(); return; }
    view.replaceChildren(container);
    current = { name, params, cleanup: typeof cleanup === 'function' ? cleanup : null };
    window.scrollTo(0, keepScroll ? scroll : 0);
  } catch (err) {
    console.error(err);
    if (token === renderToken) {
      view.innerHTML = `<div class="card"><div class="empty"><div class="ic">${icon('alert', 'lg')}</div><h3>Couldn't load this page</h3><p>${esc(err.message)}</p><button class="btn" onclick="location.reload()">Reload</button></div></div>`;
    }
  } finally {
    if (token === renderToken) view.classList.remove('loading');
  }
}

function setMonth(m) {
  state.month = m;
  try { sessionStorage.setItem('moneta.month', m); } catch { /* storage may be unavailable */ }
  updateMonthLabel();
  if (ROUTES[parseHash().name].month) render();
}

async function init() {
  setupCharts();
  try {
    await reloadBootstrap();
  } catch (err) {
    $('#view').innerHTML = `<div class="card"><div class="empty"><div class="ic">${icon('plug', 'lg')}</div><h3>Can't reach the Moneta server</h3><p>Start it with <kbd>npm start</kbd> in the project folder, then reload this page.</p></div></div>`;
    return;
  }
  let saved = null;
  try { saved = sessionStorage.getItem('moneta.month'); } catch { /* ignore */ }
  state.month = /^\d{4}-\d{2}$/.test(saved || '') ? saved : state.today.slice(0, 7);

  renderNav();
  $('#menu-btn').innerHTML = icon('menu');
  $('#quick-add').innerHTML = `${icon('plus')}<span class="label">Add transaction</span>`;
  $('[data-month="-1"]').innerHTML = icon('left');
  $('[data-month="1"]').innerHTML = icon('right');
  updateMonthLabel();

  $('#quick-add').addEventListener('click', () => openTransactionForm(null, { date: defaultDate() }));
  $$('[data-month]').forEach((b) => b.addEventListener('click', () => setMonth(shiftMonth(state.month, Number(b.dataset.month)))));
  $('#month-label').addEventListener('click', () => setMonth(state.today.slice(0, 7)));
  $('#menu-btn').addEventListener('click', () => document.body.classList.toggle('nav-open'));
  document.addEventListener('click', (e) => {
    if (document.body.classList.contains('nav-open') && !e.target.closest('#sidebar') && !e.target.closest('#menu-btn')) document.body.classList.remove('nav-open');
  });

  window.addEventListener('hashchange', () => render());
  window.addEventListener('moneta:changed', async () => {
    await reloadBootstrap().catch(() => {});
    render({ keepScroll: true });
    refreshSidebar();
  });
  // Data changed but the current view keeps its own state (e.g. the import result screen).
  window.addEventListener('moneta:sidebar', async () => {
    await reloadBootstrap().catch(() => {});
    refreshSidebar();
  });

  document.addEventListener('keydown', (e) => {
    if (isModalOpen() || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable) return;
    if (e.key === 'n') { e.preventDefault(); openTransactionForm(null, { date: defaultDate() }); }
    else if (e.key === 'i') { e.preventDefault(); openTransactionForm(null, { type: 'income', date: defaultDate() }); }
    else if (e.key === 'ArrowLeft' && ROUTES[parseHash().name].month) setMonth(shiftMonth(state.month, -1));
    else if (e.key === 'ArrowRight' && ROUTES[parseHash().name].month) setMonth(shiftMonth(state.month, 1));
    else if (/^[1-9]$/.test(e.key)) { const names = NAV.flatMap(([, i]) => i); const n = names[Number(e.key) - 1]; if (n) location.hash = `#/${n}`; }
  });

  if (!location.hash) history.replaceState(null, '', '#/dashboard');
  await render();
  refreshSidebar();
}

// New transactions default to today, or the 1st of the viewed month when browsing another month.
function defaultDate() {
  const cur = state.today.slice(0, 7);
  return state.month === cur ? state.today : `${state.month}-01`;
}

window.addEventListener('unhandledrejection', (e) => {
  console.error(e.reason);
  toast(e.reason?.message || 'Something went wrong', 'error');
});

init();
