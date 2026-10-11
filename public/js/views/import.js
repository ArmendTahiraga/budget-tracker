import {
  api, state, esc, $, $$, icon, money, fmtDate, catOptions, toast, changed, emptyState,
} from '../core.js';

// ---------------------------------------------------------------- CSV parsing (pure functions)
export function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 15);
  let best = ',', bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    const counts = lines.map((l) => splitLine(l, d).length);
    const mode = counts.sort((a, b) => counts.filter((x) => x === b).length - counts.filter((x) => x === a).length)[0];
    const score = mode > 1 ? counts.filter((c) => c === mode).length * mode : 0;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}
function splitLine(line, d) {
  return parseCSV(line, d)[0] || [];
}
export function parseCSV(text, d) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === d) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== ''));
}
const DATE_FORMATS = {
  'YYYY-MM-DD': /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/,
  'DD.MM.YYYY': /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})/,
  'DD/MM/YYYY': /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/,
  'MM/DD/YYYY': /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/,
  'DD-MM-YYYY': /^(\d{1,2})-(\d{1,2})-(\d{2,4})/,
};
export function parseDate(s, fmt) {
  const m = DATE_FORMATS[fmt]?.exec(String(s || '').trim());
  if (!m) return null;
  let y, mo, d;
  if (fmt === 'YYYY-MM-DD') [y, mo, d] = [m[1], m[2], m[3]];
  else if (fmt === 'MM/DD/YYYY') [mo, d, y] = [m[1], m[2], m[3]];
  else [d, mo, y] = [m[1], m[2], m[3]];
  y = Number(y); mo = Number(mo); d = Number(d);
  if (y < 100) y += 2000;
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
export function detectDateFormat(samples) {
  const vals = samples.filter(Boolean).slice(0, 50);
  const candidates = ['YYYY-MM-DD', 'DD.MM.YYYY', 'DD-MM-YYYY', 'DD/MM/YYYY', 'MM/DD/YYYY'];
  const ok = candidates.filter((f) => vals.length && vals.every((v) => parseDate(v, f)));
  if (ok.includes('DD/MM/YYYY') && ok.includes('MM/DD/YYYY')) return 'DD/MM/YYYY'; // ambiguous: prefer European order
  return ok[0] || 'YYYY-MM-DD';
}
export function detectDecimal(samples) {
  let comma = 0, dot = 0;
  for (const s of samples.filter(Boolean).slice(0, 80)) {
    if (/,\d{1,2}\s*-?$/.test(s.replace(/[^\d,.\s-]/g, ''))) comma++;
    else if (/\.\d{1,2}\s*-?$/.test(s.replace(/[^\d,.\s-]/g, ''))) dot++;
  }
  return comma > dot ? ',' : '.';
}
export function parseAmount(s, dec) {
  let str = String(s || '').trim();
  if (!str) return null;
  let neg = false;
  if (/^\(.*\)$/.test(str)) { neg = true; str = str.slice(1, -1); }
  if (/-\s*$/.test(str)) { neg = true; str = str.replace(/-\s*$/, ''); }
  if (/^\s*[-−]/.test(str)) { neg = true; }
  if (/\b(DR|D|S)\s*$/i.test(str)) neg = true;
  str = str.replace(/[^\d.,]/g, '');
  str = dec === ',' ? str.replace(/\./g, '').replace(',', '.') : str.replace(/,/g, '');
  if (!str || Number.isNaN(Number(str))) return null;
  const c = Math.round(Number(str) * 100);
  return neg ? -c : c;
}
const GUESS = {
  date: /date|datum|buchung|booking|valuta|fecha|data|time/i,
  desc: /desc|payee|merchant|name|beg[üu]nstigt|empf[äa]nger|auftraggeber|counterparty|details|memo|text|reference|verwendungszweck|title/i,
  amount: /amount|betrag|sum|value|importe|montant|bedrag|shuma/i,
  debit: /debit|withdraw|paid out|money out|soll|ausgang|outflow/i,
  credit: /credit|deposit|paid in|money in|haben|eingang|inflow/i,
};
function guessCol(headers, re, exclude = []) {
  const i = headers.findIndex((h, idx) => re.test(h) && !exclude.includes(idx));
  return i;
}

// ---------------------------------------------------------------- view
const S = { step: 1, fileName: '', text: '', rows: [], map: null, review: null };

export async function render(el, { setSubtitle }) {
  setSubtitle('Bring in transactions from your bank\'s CSV export');
  const draw = () => {
    el.innerHTML = `
      <div class="steps">${['Upload', 'Map columns', 'Review & import'].map((s, i) => `<div class="st ${S.step === i + 1 ? 'on' : S.step > i + 1 ? 'done' : ''}"><span class="n">${S.step > i + 1 ? icon('check', 'sm') : i + 1}</span>${s}</div>`).join('')}</div>
      <div id="step"></div>`;
    const box = $('#step', el);
    if (S.step === 1) step1(box);
    else if (S.step === 2) step2(box);
    else step3(box);
  };

  function step1(box) {
    box.innerHTML = `
      <div class="grid cols-3">
        <div class="span-2">
          <label class="dropzone" id="drop">
            <input type="file" accept=".csv,.txt,text/csv" hidden id="file">
            <div class="big-ic">${icon('upload', 'lg')}</div>
            <h3>Drop your CSV file here</h3>
            <p class="muted" style="margin:6px 0 14px">or click to choose a file · comma, semicolon and tab separated files all work</p>
            <span class="btn btn-sm">${icon('upload', 'sm')} Choose file</span>
          </label>
        </div>
        <div class="card">
          <div class="card-head"><h3>How to get the file</h3></div>
          <ol class="small muted" style="padding-left:18px;margin:0;display:grid;gap:8px">
            <li>Open your online banking (or app on the web).</li>
            <li>Go to your account's transaction list and choose <b>Export</b> or <b>Download</b>.</li>
            <li>Pick <b>CSV</b> and the date range you want.</li>
            <li>Drop the file here. Moneta guesses the columns, categorises with your rules and history, and skips duplicates.</li>
          </ol>
          <div class="divider"></div>
          <div class="small muted">Your file never leaves this computer. It's read by your browser and saved into your local database.</div>
        </div>
      </div>`;
    const input = $('#file', box);
    const drop = $('#drop', box);
    const load = async (file) => {
      if (!file) return;
      if (file.size > 15 * 1024 * 1024) { toast('That file is too large (max 15 MB)', 'error'); return; }
      let text = await file.text();
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      if (text.includes('�')) {
        // Probably not UTF-8 (common for older bank exports): retry as Windows-1252.
        text = new TextDecoder('windows-1252').decode(await file.arrayBuffer());
      }
      S.fileName = file.name;
      S.text = text;
      initMapping();
      if (!S.rows.length) { toast('No rows found in that file', 'error'); return; }
      S.step = 2;
      draw();
    };
    input.addEventListener('change', () => load(input.files[0]));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); load(e.dataTransfer.files[0]); });
  }

  function initMapping(delimiter) {
    const d = delimiter || detectDelimiter(S.text);
    const all = parseCSV(S.text, d);
    S.rows = all;
    // Banks often put title/account lines above the real header. The first row containing a date is the first
    // transaction; the row right above it (if it has text in several cells) is the header.
    const isDateLike = (s) => /^\d{1,4}[-./]\d{1,2}[-./]\d{1,4}/.test(s || '');
    const firstData = all.findIndex((r) => r.some(isDateLike));
    let headerIdx, looksLikeHeader;
    const prev = firstData > 0 ? all[firstData - 1] : null;
    if (prev && prev.filter(Boolean).length >= 2 && prev.some((c) => /\p{L}/u.test(c))) { headerIdx = firstData - 1; looksLikeHeader = true; }
    else if (firstData >= 0) { headerIdx = firstData; looksLikeHeader = false; }
    else { headerIdx = 0; looksLikeHeader = true; }
    const headers = all[headerIdx] || [];
    let dateCol = looksLikeHeader ? guessCol(headers, GUESS.date) : -1;
    if (dateCol < 0 && firstData >= 0) dateCol = all[firstData].findIndex(isDateLike);
    dateCol = Math.max(0, dateCol);
    const amountCol = guessCol(headers, GUESS.amount);
    const debitCol = guessCol(headers, GUESS.debit);
    const creditCol = guessCol(headers, GUESS.credit);
    let descCol = guessCol(headers, GUESS.desc, [dateCol, amountCol]);
    if (descCol < 0) descCol = headers.findIndex((_, i) => ![dateCol, amountCol, debitCol, creditCol].includes(i));
    const desc2Col = looksLikeHeader ? guessCol(headers, /verwendungszweck|purpose|memo|reference|details|description/i, [descCol, dateCol, amountCol]) : -1;
    const body = all.slice(headerIdx + (looksLikeHeader ? 1 : 0));
    const split = amountCol < 0 && debitCol >= 0 && creditCol >= 0;
    const amtCol = amountCol >= 0 ? amountCol : headers.findIndex((_, i) => body.slice(0, 10).every((r) => parseAmount(r[i], '.') !== null) && i !== dateCol);
    S.map = {
      delimiter: d, headerIdx, hasHeader: looksLikeHeader,
      date: dateCol, desc: Math.max(0, descCol), desc2: desc2Col,
      mode: split ? 'split' : 'single', amount: Math.max(0, amtCol), debit: Math.max(0, debitCol), credit: Math.max(0, creditCol),
      dateFormat: detectDateFormat(body.map((r) => r[dateCol])),
      decimal: detectDecimal(body.map((r) => r[split ? debitCol : amtCol] || r[creditCol])),
      flip: false,
    };
  }

  function mappedRows() {
    const m = S.map;
    const body = S.rows.slice(m.headerIdx + (m.hasHeader ? 1 : 0));
    return body.map((r) => {
      let amt;
      if (m.mode === 'single') amt = parseAmount(r[m.amount], m.decimal);
      else {
        const deb = parseAmount(r[m.debit], m.decimal), cred = parseAmount(r[m.credit], m.decimal);
        amt = cred ? Math.abs(cred) : deb ? -Math.abs(deb) : null;
      }
      if (amt !== null && m.flip) amt = -amt;
      const desc = [r[m.desc], m.desc2 >= 0 ? r[m.desc2] : ''].filter(Boolean).join(' · ').replace(/\s+/g, ' ').trim();
      return { date: parseDate(r[m.date], m.dateFormat), description: desc, amount_cents: amt };
    });
  }

  function step2(box) {
    const m = S.map;
    const headers = S.rows[m.headerIdx] || [];
    const colOpts = (sel, allowNone = false) => `${allowNone ? '<option value="-1">(none)</option>' : ''}${headers.map((h, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(m.hasHeader ? h || `Column ${i + 1}` : `Column ${i + 1} (${h.slice(0, 18)})`)}</option>`).join('')}`;
    const preview = mappedRows();
    const valid = preview.filter((r) => r.date && r.amount_cents);
    box.innerHTML = `
      <div class="grid cols-3">
        <div class="card">
          <div class="card-head"><h3>Columns</h3><span class="sub ellipsis">${esc(S.fileName)}</span></div>
          <div class="stack" style="gap:12px">
            <div class="field"><label>Date column</label><select class="select sm" data-k="date">${colOpts(m.date)}</select></div>
            <div class="field"><label>Date format</label><select class="select sm" data-k="dateFormat">${Object.keys(DATE_FORMATS).map((f) => `<option ${f === m.dateFormat ? 'selected' : ''}>${f}</option>`).join('')}</select></div>
            <div class="field"><label>Description column</label><select class="select sm" data-k="desc">${colOpts(m.desc)}</select></div>
            <div class="field"><label>Extra description <span class="faint">(optional, appended)</span></label><select class="select sm" data-k="desc2">${colOpts(m.desc2, true)}</select></div>
            <div class="field"><label>Amounts are in</label><select class="select sm" data-k="mode"><option value="single" ${m.mode === 'single' ? 'selected' : ''}>One column (negative = money out)</option><option value="split" ${m.mode === 'split' ? 'selected' : ''}>Two columns (money out / money in)</option></select></div>
            ${m.mode === 'single' ? `<div class="field"><label>Amount column</label><select class="select sm" data-k="amount">${colOpts(m.amount)}</select></div>`
    : `<div class="field"><label>Money out (debit) column</label><select class="select sm" data-k="debit">${colOpts(m.debit)}</select></div>
               <div class="field"><label>Money in (credit) column</label><select class="select sm" data-k="credit">${colOpts(m.credit)}</select></div>`}
            <div class="field"><label>Decimal separator</label><select class="select sm" data-k="decimal"><option value="." ${m.decimal === '.' ? 'selected' : ''}>Dot: 1,234.56</option><option value="," ${m.decimal === ',' ? 'selected' : ''}>Comma: 1.234,56</option></select></div>
            <div class="field"><label>Separator</label><select class="select sm" data-k="delimiter">${[[',', 'Comma ,'], [';', 'Semicolon ;'], ['\t', 'Tab'], ['|', 'Pipe |']].map(([v, l]) => `<option value="${esc(v)}" ${m.delimiter === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
            <label class="check"><input type="checkbox" data-k="hasHeader" ${m.hasHeader ? 'checked' : ''}><span class="small">First row is a header</span></label>
            <label class="check"><input type="checkbox" data-k="flip" ${m.flip ? 'checked' : ''}><span class="small">Flip signs <span class="muted">(if spending shows as positive)</span></span></label>
          </div>
        </div>
        <div class="card span-2 flush">
          <div class="card-head" style="padding:18px 20px 0"><h3>Preview</h3><span class="sub">${valid.length} of ${preview.length} rows readable</span></div>
          <div class="table-wrap"><table class="table compact" style="margin-top:12px">
            <thead><tr><th>Date</th><th>Description</th><th class="num">Amount</th></tr></thead>
            <tbody>${preview.slice(0, 12).map((r) => `<tr class="${r.date && r.amount_cents ? '' : 'err'}"><td class="nowrap">${r.date ? fmtDate(r.date, { year: true }) : '<span class="neg">?</span>'}</td><td class="ellipsis" style="max-width:380px">${esc(r.description) || '<span class="faint">–</span>'}</td><td class="num money ${r.amount_cents > 0 ? 'pos' : ''}">${r.amount_cents ? money(r.amount_cents, { sign: true }) : '<span class="neg">?</span>'}</td></tr>`).join('')}</tbody>
          </table></div>
          ${valid.length < preview.length ? `<div class="small warn-text" style="padding:12px 20px">${preview.length - valid.length} rows can't be read with these settings. Check the date format and amount column. Rows that are not transactions (totals, balances) can be ignored.</div>` : ''}
          <div class="row" style="padding:16px 20px;border-top:1px solid var(--border)">
            <button class="btn btn-ghost" data-back>${icon('left', 'sm')} Choose another file</button>
            <div class="spacer"></div>
            <span class="small muted">Expenses should show as <span class="strong" style="color:var(--text)">−</span>, income as <span class="pos strong">+</span></span>
            <button class="btn btn-primary" data-next ${valid.length ? '' : 'disabled'}>Continue ${icon('arrowRight', 'sm')}</button>
          </div>
        </div>
      </div>`;
    $$('[data-k]', box).forEach((inp) => inp.addEventListener('change', () => {
      const k = inp.dataset.k;
      if (k === 'delimiter') { initMapping(inp.value); draw(); return; }
      m[k] = inp.type === 'checkbox' ? inp.checked : ['date', 'desc', 'desc2', 'amount', 'debit', 'credit'].includes(k) ? Number(inp.value) : inp.value;
      draw();
    }));
    $('[data-back]', box).addEventListener('click', () => { S.step = 1; draw(); });
    $('[data-next]', box).addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const rows = mappedRows().filter((r) => r.date && r.amount_cents);
        const res = await api.post('/api/import/preview', { rows });
        S.review = res.rows.map((r) => ({ ...r, include: !r.duplicate && !r.errors.length, original_category: r.category_id }));
        S.step = 3;
        draw();
      } catch (err) { toast(err.message, 'error'); e.target.disabled = false; }
    });
  }

  function step3(box) {
    const rows = S.review;
    const count = () => rows.filter((r) => r.include).length;
    const dups = rows.filter((r) => r.duplicate).length;
    const uncategorised = rows.filter((r) => r.include && !r.category_id).length;
    box.innerHTML = `
      <div class="card flush">
        <div class="summary-strip">
          <div class="s"><div class="l">Rows</div><div class="v">${rows.length}</div></div>
          <div class="s"><div class="l">Selected</div><div class="v" id="sel-n">${count()}</div></div>
          <div class="s"><div class="l">Likely duplicates</div><div class="v ${dups ? 'warn-text' : ''}">${dups}</div></div>
          <div class="s"><div class="l">Auto-categorised</div><div class="v">${rows.filter((r) => r.category_id).length}</div></div>
          <div class="spacer"></div>
          <div class="row" style="gap:8px">
            <button class="btn btn-sm" data-all>Select all</button>
            <button class="btn btn-sm" data-none>Select none</button>
          </div>
        </div>
        <div class="table-wrap" style="max-height:60vh;overflow:auto"><table class="table compact">
          <thead><tr><th style="width:36px"></th><th>Date</th><th>Description</th><th style="width:230px">Category</th><th class="num">Amount</th><th></th></tr></thead>
          <tbody>${rows.map((r, i) => `<tr class="${r.duplicate ? 'dup' : ''}" data-i="${i}">
            <td><input type="checkbox" data-inc ${r.include ? 'checked' : ''} style="accent-color:var(--accent);width:16px;height:16px"></td>
            <td class="nowrap">${fmtDate(r.date, { year: true })}</td>
            <td class="ellipsis" style="max-width:340px" title="${esc(r.description)}">${esc(r.description) || '<span class="faint">–</span>'}</td>
            <td><select class="select sm" data-cat>${catOptions(r.type, r.category_id)}</select></td>
            <td class="num money strong ${r.type === 'income' ? 'pos' : ''}">${r.type === 'income' ? '+' : '−'}${money(r.amount_cents)}</td>
            <td>${r.duplicate ? '<span class="badge amber">duplicate?</span>' : ''}</td>
          </tr>`).join('')}</tbody>
        </table></div>
        <div class="row wrap" style="padding:16px 20px;border-top:1px solid var(--border);gap:14px">
          <button class="btn btn-ghost" data-back>${icon('left', 'sm')} Back</button>
          <label class="check"><input type="checkbox" id="learn" checked><span class="small"><span class="t">Learn from my category choices</span><div class="d">Creates rules so future imports are categorised automatically</div></span></label>
          <div class="spacer"></div>
          ${uncategorised ? `<span class="small muted">${uncategorised} without a category (you can fix them later)</span>` : ''}
          <button class="btn btn-primary" data-import>${icon('check', 'sm')} Import <span id="imp-n">${count()}</span> transactions</button>
        </div>
      </div>`;
    const refreshCount = () => { $('#sel-n', box).textContent = count(); $('#imp-n', box).textContent = count(); };
    $$('tr[data-i]', box).forEach((tr) => {
      const r = rows[Number(tr.dataset.i)];
      $('[data-inc]', tr).addEventListener('change', (e) => { r.include = e.target.checked; refreshCount(); });
      $('[data-cat]', tr).addEventListener('change', (e) => { r.category_id = e.target.value ? Number(e.target.value) : null; });
    });
    $('[data-all]', box).addEventListener('click', () => { rows.forEach((r) => { r.include = true; }); step3(box); });
    $('[data-none]', box).addEventListener('click', () => { rows.forEach((r) => { r.include = false; }); step3(box); });
    $('[data-back]', box).addEventListener('click', () => { S.step = 2; draw(); });
    $('[data-import]', box).addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      const chosen = rows.filter((r) => r.include);
      if (!chosen.length) { toast('Select at least one row', 'error'); return; }
      btn.disabled = true;
      const rules = [];
      if ($('#learn', box).checked) {
        const seen = new Set();
        for (const r of chosen) {
          if (!r.category_id || r.category_id === r.original_category) continue;
          const pattern = r.description.toLowerCase().replace(/\d+/g, ' ').replace(/[^\p{L}\s&]/gu, ' ').trim().split(/\s+/).slice(0, 2).join(' ');
          if (pattern.length >= 3 && !seen.has(pattern)) { seen.add(pattern); rules.push({ pattern, category_id: r.category_id }); }
        }
      }
      try {
        const res = await api.post('/api/import/commit', { rows: chosen.map(({ date, description, amount_cents, type, category_id }) => ({ date, description, amount_cents, type, category_id })), rules });
        S.step = 1; S.review = null; S.rows = []; S.text = '';
        box.innerHTML = `<div class="card">${emptyState({ icon: 'checkCircle', title: `Imported ${res.imported} transactions`, text: res.rules_added ? `${res.rules_added} new categorisation rule${res.rules_added > 1 ? 's' : ''} learned. Manage them in Settings.` : 'Review them any time in Transactions.', action: '<a class="btn btn-primary btn-sm" href="#/transactions">View transactions</a>' })}</div>`;
        toast(`Imported ${res.imported} transactions`);
        window.dispatchEvent(new CustomEvent('moneta:sidebar'));
      } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
    });
  }

  draw();
}
