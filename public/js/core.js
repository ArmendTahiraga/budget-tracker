import { icon, glyph } from './icons.js';

// Shared state, API client, formatting, DOM helpers, modals, toasts and chart setup.

export const state = { settings: {}, categories: [], counts: {}, month: '', today: '' };

// ------------------------------------------------------------------ API
async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}
export const api = {
  get: (u) => request('GET', u),
  post: (u, b = {}) => request('POST', u, b),
  put: (u, b = {}) => request('PUT', u, b),
  del: (u) => request('DELETE', u),
};
export function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== null && v !== undefined && v !== '') p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

export async function reloadBootstrap() {
  const b = await api.get('/api/bootstrap');
  state.settings = b.settings;
  state.categories = b.categories;
  state.counts = b.counts;
  state.today = b.today;
  return b;
}

// ------------------------------------------------------------------ formatting
const fmtCache = new Map();
function nf(opts) {
  const key = (state.settings.locale || 'en-IE') + JSON.stringify(opts);
  if (!fmtCache.has(key)) fmtCache.set(key, new Intl.NumberFormat(state.settings.locale || 'en-IE', opts));
  return fmtCache.get(key);
}
export function money(cents, { sign = false, compact = false, whole = false } = {}) {
  const v = (Number(cents) || 0) / 100;
  if (compact && Math.abs(v) >= 10000) {
    return nf({ style: 'currency', currency: 'EUR', notation: 'compact', maximumFractionDigits: 1, signDisplay: sign ? 'exceptZero' : 'auto' }).format(v);
  }
  const digits = whole || (compact && Math.abs(v) >= 1000) ? 0 : 2;
  return nf({ style: 'currency', currency: 'EUR', minimumFractionDigits: digits, maximumFractionDigits: digits, signDisplay: sign ? 'exceptZero' : 'auto' }).format(v);
}
export const decimalSep = () => nf({}).formatToParts(1.5).find((p) => p.type === 'decimal')?.value || '.';
export function moneyInput(cents) {
  if (cents === null || cents === undefined || cents === '') return '';
  return nf({ minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false }).format(Number(cents) / 100);
}
// Parses "1.234,56", "1,234.56", "12,5", "€ 40" -> cents. Returns null for empty, NaN for invalid.
export function parseMoney(input) {
  let s = String(input ?? '').trim().replace(/[€\s '’]/g, '');
  if (!s) return null;
  let neg = false;
  if (/^[-−]/.test(s)) { neg = true; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  // Money never has 3 decimals, so a lone separator followed by exactly 3 digits is a thousands separator
  // ("1.200" and "1,200" are both 1200), while "12,5" / "12.50" are decimals, whatever the locale.
  const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
  if (lc > -1 && ld > -1) {
    const d = lc > ld ? ',' : '.';
    s = s.split(d === ',' ? '.' : ',').join('').replace(d, '.');
  } else if (lc > -1 || ld > -1) {
    const sep = lc > -1 ? ',' : '.';
    const parts = s.split(sep);
    s = parts.length === 2 && parts[1].length !== 3 ? parts.join('.') : parts.join('');
  }
  if (!/^\d*\.?\d*$/.test(s) || s === '' || s === '.') return NaN;
  const c = Math.round(parseFloat(s) * 100);
  return neg ? -c : c;
}
export function number(n, max = 4) {
  return nf({ maximumFractionDigits: max }).format(Number(n) || 0);
}
// Full-precision number (quantities, unit prices, percentages). A single dot is always a decimal point.
export function parseNumber(input) {
  let s = String(input ?? '').trim().replace(/[€%\s '’]/g, '');
  if (!s) return null;
  const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
  if (lc > -1 && ld > -1) {
    const d = lc > ld ? ',' : '.';
    s = s.split(d === ',' ? '.' : ',').join('').replace(d, '.');
  } else if (lc > -1) {
    const parts = s.split(',');
    s = parts.length === 2 && (parts[1].length !== 3 || decimalSep() === ',') ? parts.join('.') : parts.join('');
  } else if (ld > -1 && s.split('.').length > 2) {
    s = s.split('.').join('');
  }
  if (!/^-?\d*\.?\d*$/.test(s) || s === '' || s === '.' || s === '-') return NaN;
  return parseFloat(s);
}
export function pct(x, digits = 0) {
  if (x === null || x === undefined || !Number.isFinite(x)) return '–';
  return `${(x * 100).toFixed(digits)}%`;
}
const pad = (n) => String(n).padStart(2, '0');
export function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function toDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d || 1);
}
export function monthLabel(m, short = false) {
  return toDate(`${m}-01`).toLocaleDateString(state.settings.locale || 'en-IE', { month: short ? 'short' : 'long', year: 'numeric' });
}
export function shortMonth(m) {
  return toDate(`${m}-01`).toLocaleDateString(state.settings.locale || 'en-IE', { month: 'short' });
}
export function shiftMonth(m, delta) {
  const d = toDate(`${m}-01`);
  d.setMonth(d.getMonth() + delta);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}
export function fmtDate(s, { year = 'auto', weekday = false } = {}) {
  if (!s) return '–';
  const d = toDate(s);
  const showYear = year === true || (year === 'auto' && d.getFullYear() !== new Date().getFullYear());
  return d.toLocaleDateString(state.settings.locale || 'en-IE', { day: 'numeric', month: 'short', ...(showYear ? { year: 'numeric' } : {}), ...(weekday ? { weekday: 'short' } : {}) });
}
export function daysBetween(a, b) {
  return Math.round((toDate(b) - toDate(a)) / 86400000);
}
export function relDays(s) {
  const n = daysBetween(todayStr(), s);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}
export function dayLabel(s) {
  const n = daysBetween(todayStr(), s);
  if (n === 0) return 'Today';
  if (n === -1) return 'Yesterday';
  return fmtDate(s, { weekday: true });
}
export function timeAgo(iso) {
  if (!iso) return 'never';
  const sec = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h ago`;
  return `${Math.round(sec / 86400)} days ago`;
}
// Replace {{cents}} placeholders from the server with formatted money (text is escaped first).
export function richText(s) {
  return esc(s).replace(/\{\{(-?\d+)\}\}/g, (_, c) => `<strong>${money(Number(c))}</strong>`);
}

// ------------------------------------------------------------------ DOM
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function debounce(fn, ms = 250) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export function changed() {
  window.dispatchEvent(new CustomEvent('moneta:changed'));
}
export function download(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ------------------------------------------------------------------ icons
export { icon, glyph } from './icons.js';

// ------------------------------------------------------------------ toast
export function toast(msg, kind = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon(kind === 'error' ? 'alert' : 'check')}<span>${esc(msg)}</span>`;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, kind === 'error' ? 5200 : 2800);
}

// ------------------------------------------------------------------ modal
let modalStack = 0;
export function openModal({ title, body, submitLabel = 'Save', cancelLabel = 'Cancel', wide = false, danger = false, onSubmit, onOpen, footLeft = '' }) {
  const root = $('#modal-root');
  const back = document.createElement('div');
  back.className = 'modal-backdrop';
  back.innerHTML = `
    <form class="modal ${wide ? 'wide' : ''}" novalidate>
      <div class="modal-head"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-close aria-label="Close">${icon('x')}</button></div>
      <div class="modal-body">${body}<div class="form-error"></div></div>
      <div class="modal-foot">
        ${footLeft ? `<div class="left">${footLeft}</div>` : ''}
        ${cancelLabel ? `<button type="button" class="btn btn-ghost" data-close>${esc(cancelLabel)}</button>` : ''}
        ${submitLabel ? `<button type="submit" class="btn ${danger ? 'btn-danger' : 'btn-primary'}">${esc(submitLabel)}</button>` : ''}
      </div>
    </form>`;
  root.appendChild(back);
  modalStack++;
  const form = $('form', back);
  const errEl = $('.form-error', back);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    modalStack--;
    document.removeEventListener('keydown', onKey, true);
    back.remove();
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && back === root.lastElementChild) { e.stopPropagation(); close(); }
  };
  document.addEventListener('keydown', onKey, true);
  let downOnBack = false;
  back.addEventListener('mousedown', (e) => { downOnBack = e.target === back; });
  back.addEventListener('click', (e) => { if (e.target === back && downOnBack) close(); });
  $$('[data-close]', back).forEach((b) => b.addEventListener('click', close));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!onSubmit) return close();
    const btn = $('button[type="submit"]', form);
    errEl.textContent = '';
    btn.disabled = true;
    try {
      const keepOpen = await onSubmit(form, { close, setError: (m) => { errEl.textContent = m; } });
      if (keepOpen !== false) close();
    } catch (err) {
      errEl.textContent = err.message || String(err);
    } finally {
      btn.disabled = false;
    }
  });
  if (onOpen) onOpen(form, { close, setError: (m) => { errEl.textContent = m; } });
  setTimeout(() => {
    const first = $('[autofocus]', form) || $('input:not([type="hidden"]):not([type="checkbox"]), select, textarea', form);
    first?.focus();
    if (first?.select && first.tagName === 'INPUT') first.select();
  }, 30);
  return { el: form, close };
}
export const isModalOpen = () => modalStack > 0;

export function confirmDialog({ title = 'Are you sure?', message = '', confirmLabel = 'Delete', danger = true } = {}) {
  return new Promise((resolve) => {
    let ok = false;
    const m = openModal({
      title, body: `<p class="muted" style="margin:0">${message}</p>`, submitLabel: confirmLabel, danger,
      onSubmit: () => { ok = true; },
    });
    const obs = new MutationObserver(() => {
      if (!m.el.isConnected) { obs.disconnect(); resolve(ok); }
    });
    obs.observe($('#modal-root'), { childList: true });
  });
}

// Read named fields of a form into an object.
export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
    else out[el.name] = el.value;
  }
  return out;
}
export function requireMoney(value, label, { allowZero = false, allowNegative = false } = {}) {
  const c = parseMoney(value);
  if (c === null || Number.isNaN(c)) throw new Error(`Enter a valid ${label}`);
  if (!allowNegative && c < 0) throw new Error(`${label[0].toUpperCase() + label.slice(1)} cannot be negative`);
  if (!allowZero && c === 0) throw new Error(`${label[0].toUpperCase() + label.slice(1)} must be more than zero`);
  return c;
}

// segmented control wiring: <div class="seg" data-name="x"><button type="button" data-v="a">
export function wireSeg(seg, onChange) {
  $$('button', seg).forEach((b) => b.addEventListener('click', () => {
    $$('button', seg).forEach((x) => x.classList.toggle('on', x === b));
    seg.dataset.value = b.dataset.v;
    onChange?.(b.dataset.v);
  }));
}
export function seg(options, value, { cls = '', name = '' } = {}) {
  return `<div class="seg ${cls}" data-name="${esc(name)}" data-value="${esc(value)}">${options.map(([v, label]) => `<button type="button" data-v="${esc(v)}" class="${v === value ? 'on' : ''}">${label}</button>`).join('')}</div>`;
}

// ------------------------------------------------------------------ categories & small components
export const catById = (id) => state.categories.find((c) => c.id === Number(id));
export function catOptions(kind, selected, { none = 'Uncategorized', includeArchived = false } = {}) {
  const list = state.categories.filter((c) => (!kind || c.kind === kind) && (includeArchived || !c.archived || c.id === Number(selected)));
  return `${none !== null ? `<option value="">${esc(none)}</option>` : ''}${list.map((c) => `<option value="${c.id}" ${c.id === Number(selected) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}`;
}
export function catChip(name, color) {
  if (!name) return '<span class="chip"><span class="cdot" style="background:#52525b"></span>Uncategorized</span>';
  return `<span class="chip"><span class="cdot" style="background:${esc(color || '#7c5cff')}"></span>${esc(name)}</span>`;
}
// Tinted rounded tile with a coloured line icon (the KPI-card style).
export function avatar(iconName, color, size = '') {
  const c = color || '#8b5cf6';
  return `<span class="avatar ${size}" style="background:${hexA(c, 0.14)};color:${esc(c)}">${glyph(iconName)}</span>`;
}
// Small coloured icon to put in front of a label inside text/tables.
export function inlineIcon(iconName, color) {
  return `<span class="ii" style="color:${esc(color || '#8a90a0')}">${glyph(iconName, 'sm')}</span>`;
}
export function hexA(hex, a) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || '');
  if (!m) return `rgba(139,92,246,${a})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}
export function progressBar(value, max, { size = '', marker = null, invert = false, plain = false } = {}) {
  const ratio = max > 0 ? value / max : (value > 0 ? 1.01 : 0);
  let cls = 'ok';
  if (!plain) {
    if (invert) cls = ratio >= 1 ? 'ok' : '';
    else cls = ratio > 1 ? 'over' : ratio > 0.85 ? 'warn' : 'ok';
  } else cls = '';
  const w = Math.max(0, Math.min(100, ratio * 100));
  const mk = marker !== null && marker >= 0 && marker <= 1 ? `<i class="marker" style="left:${(marker * 100).toFixed(1)}%"></i>` : '';
  return `<div class="progress ${size} ${cls}"><span style="width:${w.toFixed(1)}%"></span>${mk}</div>`;
}
export function ring(progress, { size = 64, stroke = 7, color = '#8b5cf6', label = '', sub = '' } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, progress || 0));
  const id = `rg${Math.random().toString(36).slice(2, 8)}`;
  return `<div class="ring" style="width:${size}px;height:${size}px">
    <svg width="${size}" height="${size}">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${esc(color)}"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="rgba(255,255,255,0.07)" stroke-width="${stroke}" fill="none"/>
      <circle cx="${size / 2}" cy="${size / 2}" r="${r}" stroke="url(#${id})" stroke-width="${stroke}" fill="none" stroke-linecap="round"
        stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${(c * (1 - p)).toFixed(2)}" style="transition:stroke-dashoffset .8s cubic-bezier(.2,.8,.2,1)"/>
    </svg>
    <div class="ring-label">${label}${sub ? `<small>${sub}</small>` : ''}</div>
  </div>`;
}
export function emptyState({ icon: ic = 'sparkles', title, text = '', action = '' }) {
  return `<div class="empty"><div class="ic">${glyph(ic, 'lg')}</div><h3>${esc(title)}</h3>${text ? `<p>${text}</p>` : ''}${action}</div>`;
}
export const amountClass = (type) => (type === 'income' ? 'pos' : '');
export const signedMoney = (type, cents) => (type === 'income' ? `+${money(cents)}` : `−${money(cents)}`);

// ------------------------------------------------------------------ charts
export const PALETTE = ['#8b5cf6', '#22d3ee', '#34d399', '#fbbf24', '#fb7185', '#60a5fa', '#f472b6', '#a3e635', '#fb923c', '#c084fc', '#2dd4bf', '#94a3b8'];
const charts = new Set();
export function setupCharts() {
  if (!window.Chart) return;
  const C = window.Chart;
  C.defaults.color = '#8a90a0';
  C.defaults.font.family = getComputedStyle(document.body).fontFamily;
  C.defaults.font.size = 12;
  C.defaults.borderColor = 'rgba(255,255,255,0.06)';
  C.defaults.maintainAspectRatio = false;
  C.defaults.animation.duration = 700;
  C.defaults.plugins.legend.labels.usePointStyle = true;
  C.defaults.plugins.legend.labels.pointStyle = 'circle';
  C.defaults.plugins.legend.labels.boxWidth = 7;
  C.defaults.plugins.legend.labels.boxHeight = 7;
  C.defaults.plugins.legend.labels.padding = 16;
  Object.assign(C.defaults.plugins.tooltip, {
    backgroundColor: 'rgba(20,23,33,0.96)', borderColor: 'rgba(255,255,255,0.12)', borderWidth: 1,
    titleColor: '#e9ebf1', bodyColor: '#b9bdc9', padding: 12, cornerRadius: 12, boxPadding: 5, usePointStyle: true,
    titleFont: { weight: '600' },
  });
}
export function chart(canvas, config) {
  if (!window.Chart || !canvas) return null;
  const c = new window.Chart(canvas, config);
  charts.add(c);
  return c;
}
export function destroyCharts() {
  charts.forEach((c) => c.destroy());
  charts.clear();
}
export const moneyTick = (v) => money(v, { compact: true });
export const tooltipMoney = (ctx) => ` ${ctx.dataset.label ? `${ctx.dataset.label}: ` : ''}${money(ctx.parsed.y ?? ctx.parsed)}`;
export function areaGradient(color, alpha = 0.35) {
  return (ctx) => {
    const { chart: c } = ctx;
    const { ctx: g, chartArea } = c;
    if (!chartArea) return hexA(color, alpha * 0.4);
    const grad = g.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    grad.addColorStop(0, hexA(color, alpha));
    grad.addColorStop(1, hexA(color, 0));
    return grad;
  };
}
export function moneyAxis(extra = {}) {
  return { grid: { color: 'rgba(255,255,255,0.05)', drawTicks: false }, border: { display: false }, ticks: { callback: moneyTick, padding: 8, maxTicksLimit: 6 }, ...extra };
}
export const plainAxis = (extra = {}) => ({ grid: { display: false }, border: { display: false }, ticks: { padding: 6 }, ...extra });
