// Live prices: Yahoo Finance (stocks/ETFs/funds, unofficial chart endpoint) and CoinGecko (crypto, keyless).
// Everything is converted to EUR. Failures are recorded per holding and never crash the app.

// Yahoo rate-limits full browser user-agent strings more aggressively than a plain one.
const UAS = ['Mozilla/5.0', 'Mozilla/5.0 (compatible; Moneta/1.0)'];
const TIMEOUT = 10_000;

// Some exchanges quote in minor units.
const MINOR_UNITS = { GBp: ['GBP', 100], GBX: ['GBP', 100], ZAc: ['ZAR', 100], ILA: ['ILS', 100] };

async function getJson(url, ua = UAS[0]) {
  const res = await fetch(url, { headers: { 'User-Agent': ua, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!res.ok) {
    const err = new Error(res.status === 404 ? 'Symbol not found' : res.status === 429 ? 'Rate limited, try again in a minute' : `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Try both Yahoo hosts / user agents before giving up (429s are common).
async function yahooJson(path) {
  let lastErr;
  for (const [host, ua] of [['query1', UAS[0]], ['query2', UAS[0]], ['query2', UAS[1]]]) {
    try {
      return await getJson(`https://${host}.finance.yahoo.com${path}`, ua);
    } catch (e) {
      lastErr = e;
      if (e.status !== 429 && e.status < 500) throw e;
    }
  }
  throw lastErr;
}

export async function yahooQuote(symbol) {
  const data = await yahooJson(`/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`);
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(data?.chart?.error?.description || 'Symbol not found');
  const meta = result.meta;
  const price = meta.regularMarketPrice;
  if (typeof price !== 'number') throw new Error('No price available');
  let currency = meta.currency || 'EUR';
  const closes = result.indicators?.quote?.[0]?.close?.filter((x) => typeof x === 'number') || [];
  const prev = closes.length >= 2 ? closes[closes.length - 2] : meta.chartPreviousClose;
  const changePct = typeof meta.regularMarketChangePercent === 'number'
    ? meta.regularMarketChangePercent
    : prev ? ((price - prev) / prev) * 100 : null;
  let nativePrice = price;
  if (MINOR_UNITS[currency]) {
    const [major, div] = MINOR_UNITS[currency];
    nativePrice = price / div;
    currency = major;
  }
  return { nativePrice, currency, changePct, name: meta.longName || meta.shortName || '' };
}

const fxCache = new Map(); // currency -> { rate, at }

export async function fxToEur(currency) {
  if (!currency || currency === 'EUR') return 1;
  const hit = fxCache.get(currency);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.rate;
  const data = await yahooJson(`/v8/finance/chart/${currency}EUR=X?interval=1d&range=1d`);
  const rate = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (typeof rate !== 'number' || rate <= 0) throw new Error(`No FX rate for ${currency}`);
  fxCache.set(currency, { rate, at: Date.now() });
  return rate;
}

export async function coingeckoPrices(ids) {
  if (!ids.length) return {};
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids.map(encodeURIComponent).join(',')}&vs_currencies=eur&include_24hr_change=true`;
  return getJson(url);
}

// Refresh all non-manual holdings. Returns { updated, errors: [{symbol, error}] }.
export async function refreshPrices(db) {
  const holdings = db.prepare("SELECT * FROM holdings WHERE archived = 0 AND price_source != 'manual'").all();
  const now = new Date().toISOString();
  const ok = db.prepare(`UPDATE holdings SET last_price = ?, native_price = ?, native_currency = ?, day_change_pct = ?,
                         price_updated_at = ?, price_error = NULL WHERE id = ?`);
  const fail = db.prepare('UPDATE holdings SET price_error = ? WHERE id = ?');
  let updated = 0;
  const errors = [];
  const recordError = (h, e) => {
    const msg = String(e?.name === 'TimeoutError' ? 'Timed out (offline?)' : e?.message || e);
    fail.run(msg, h.id);
    errors.push({ symbol: h.symbol, error: msg });
  };

  const yahoo = holdings.filter((h) => h.price_source === 'yahoo');
  await Promise.all(yahoo.map(async (h) => {
    try {
      const q = await yahooQuote(h.symbol);
      const rate = await fxToEur(q.currency);
      ok.run(q.nativePrice * rate, q.nativePrice, q.currency, q.changePct, now, h.id);
      if (!h.name && q.name) db.prepare('UPDATE holdings SET name = ? WHERE id = ?').run(q.name, h.id);
      updated++;
    } catch (e) {
      recordError(h, e);
    }
  }));

  const cg = holdings.filter((h) => h.price_source === 'coingecko');
  if (cg.length) {
    try {
      const ids = [...new Set(cg.map((h) => h.source_id || h.symbol.toLowerCase()))];
      const data = await coingeckoPrices(ids);
      for (const h of cg) {
        const row = data[h.source_id || h.symbol.toLowerCase()];
        if (row && typeof row.eur === 'number') {
          ok.run(row.eur, row.eur, 'EUR', row.eur_24h_change ?? null, now, h.id);
          updated++;
        } else {
          recordError(h, new Error('Coin id not found on CoinGecko'));
        }
      }
    } catch (e) {
      for (const h of cg) recordError(h, e);
    }
  }
  return { updated, errors };
}

// ---- historical prices (EUR), as [['YYYY-MM-DD', price], ...] oldest first
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

export async function yahooHistory(symbol, range) {
  const data = await yahooJson(`/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1wk&range=${range}`);
  const r = data?.chart?.result?.[0];
  if (!r) throw new Error('No history');
  let currency = r.meta.currency || 'EUR';
  let div = 1;
  if (MINOR_UNITS[currency]) [currency, div] = MINOR_UNITS[currency];
  const rate = await fxToEur(currency);
  const closes = r.indicators?.quote?.[0]?.close || [];
  return (r.timestamp || []).map((t, i) => [dayOf(t * 1000), closes[i]]).filter(([, p]) => typeof p === 'number').map(([d, p]) => [d, (p / div) * rate]);
}

export async function coingeckoHistory(id, days) {
  const data = await getJson(`https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart?vs_currency=eur&days=${days}&interval=daily`);
  return (data.prices || []).map(([ms, p]) => [dayOf(ms), p]);
}

const TYPE_MAP = { ETF: 'etf', EQUITY: 'stock', MUTUALFUND: 'fund', CRYPTOCURRENCY: 'crypto', INDEX: 'other', BOND: 'bond' };

export async function searchSymbols(q) {
  const results = [];
  const [yahoo, cg] = await Promise.allSettled([
    yahooJson(`/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&listsCount=0`),
    getJson(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(q)}`),
  ]);
  if (yahoo.status === 'fulfilled') {
    for (const r of yahoo.value.quotes || []) {
      if (!r.symbol || r.quoteType === 'CRYPTOCURRENCY') continue;
      results.push({
        source: 'yahoo', symbol: r.symbol, source_id: '', name: r.longname || r.shortname || r.symbol,
        asset_type: TYPE_MAP[r.quoteType] || 'other', exchange: r.exchDisp || r.exchange || '',
      });
    }
  }
  if (cg.status === 'fulfilled') {
    for (const c of (cg.value.coins || []).slice(0, 5)) {
      results.push({ source: 'coingecko', symbol: c.symbol, source_id: c.id, name: c.name, asset_type: 'crypto', exchange: 'Crypto' });
    }
  }
  return { results, offline: yahoo.status === 'rejected' && cg.status === 'rejected' };
}
