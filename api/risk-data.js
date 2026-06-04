// /api/risk-data  — Vercel serverless function (Node 18+)
//
// Databronnen (geen Finnhub meer):
//  ✅ Stooq quote    → WTI (cl.f), DXY (dx.f)                      [geen key]
//  ✅ FRED API       → VIX, 10Y yield, HY spread, Nasdaq history    [FRED_API_KEY]
//  ✅ Yahoo Finance  → SMH (semis), breadth-mandje quotes           [geen key]
//  ✅ CoinGecko      → BTC trend                                     [geen key]

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const num  = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };
const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

async function getText(url, ms = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
  finally { clearTimeout(t); }
}

// ── Stooq quote (werkt voor futures: cl.f, dx.f) ────────────────────────────
async function stooqQuote(symbols) {
  for (const s of symbols) {
    const txt = await getText(`https://stooq.com/q/l/?s=${s}&f=sd2t2ohlcv&h&e=csv`);
    if (!txt) continue;
    const lines = txt.trim().split('\n');
    if (lines.length < 2) continue;
    const cols  = lines[1].split(',');
    const close = num(cols[6]);
    if (close !== null) return { value: close, symbol: s };
  }
  return null;
}

// ── FRED: enkel laatste getal (VIX, 10Y, HY spread) ─────────────────────────
async function fredLatest(series) {
  const key = process.env.FRED_API_KEY;
  if (!key) return null;
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${series}&api_key=${key}&sort_order=desc&limit=5&file_type=json`;
  const txt = await getText(url, 8000);
  if (!txt) return null;
  try {
    const d = JSON.parse(txt);
    for (const obs of d.observations || []) {
      const v = num(obs.value);
      if (v !== null) return { value: v, symbol: `FRED:${series}` };
    }
  } catch { /* val */ }
  return null;
}

// ── FRED: historische reeks → MA50 + MA200 (voor Nasdaq Composite trend) ─────
async function fredHistory(series) {
  const key = process.env.FRED_API_KEY;
  if (!key) return null;
  const from = new Date();
  from.setDate(from.getDate() - 420);
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${series}&api_key=${key}&observation_start=${from.toISOString().slice(0, 10)}&sort_order=asc&file_type=json`;
  const txt = await getText(url, 9000);
  if (!txt) return null;
  try {
    const d = JSON.parse(txt);
    const closes = (d.observations || []).map(o => num(o.value)).filter(v => v !== null);
    if (closes.length < 50) return null;
    return {
      value:  closes[closes.length - 1],
      ma50:   mean(closes.slice(-50)),
      ma200:  closes.length >= 200 ? mean(closes.slice(-200)) : mean(closes),
      symbol: `FRED:${series}`,
    };
  } catch { return null; }
}

// ── Yahoo Finance: current quote + 50d/200d MA voor meerdere symbolen ────────
// Haalt twoHundredDayAverage en fiftyDayAverage op uit de quote API (geen key)
async function yahooQuotes(symbols) {
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols.join(',')}`;
  const txt = await getText(url, 9000);
  if (!txt) return {};
  try {
    const d = JSON.parse(txt);
    const result = {};
    for (const q of (d.quoteResponse?.result || [])) {
      if (q.regularMarketPrice && q.twoHundredDayAverage) {
        result[q.symbol] = {
          value:  q.regularMarketPrice,
          ma50:   q.fiftyDayAverage || null,
          ma200:  q.twoHundredDayAverage,
          symbol: q.symbol,
        };
      }
    }
    return result;
  } catch { return {}; }
}

// ── CoinGecko: BTC trend ─────────────────────────────────────────────────────
async function btcTrend() {
  const url = 'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=210&interval=daily';
  const txt = await getText(url, 10000);
  if (!txt) return null;
  try {
    const d = JSON.parse(txt);
    const closes = (d.prices || []).map(p => p[1]).filter(x => Number.isFinite(x));
    if (closes.length < 60) return null;
    return {
      value:  closes[closes.length - 1],
      ma50:   mean(closes.slice(-50)),
      ma200:  mean(closes),
    };
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');

  // Yahoo Finance symbolen: SMH (semis) + breadth-mandje
  const BREADTH_SYMS = ['TSLA', 'PLTR', 'S', 'TLN', 'ASML', 'UUUU'];

  const [wti, dxy, vix, us10y, hy, ndx, yahoo, btc] = await Promise.all([
    stooqQuote(['cl.f']),                   // WTI olie
    stooqQuote(['dx.f', '^dxy']),           // DXY dollar
    fredLatest('VIXCLS'),                   // VIX
    fredLatest('DGS10'),                    // US 10Y yield
    fredLatest('BAMLH0A0HYM2'),             // HY OAS spread (%)
    fredHistory('NASDAQCOM'),               // Nasdaq Composite → MA trend
    yahooQuotes(['SMH', ...BREADTH_SYMS]),  // SMH semis + breadth-mandje
    btcTrend(),                             // Bitcoin
  ]);

  // Semis: SMH quote van Yahoo Finance
  const semis = yahoo['SMH'] ?? null;

  // Marktbreedte: % van mandje boven 200d-gemiddelde
  const breadthTickers = BREADTH_SYMS
    .map(s => yahoo[s])
    .filter(q => q?.value != null && q?.ma200 != null)
    .map(q => ({ sym: q.symbol, value: q.value, ma200: q.ma200, above: q.value >= q.ma200 }));

  const breadth = breadthTickers.length >= 3 ? {
    count:       breadthTickers.length,
    aboveCount:  breadthTickers.filter(t => t.above).length,
    pctAbove200: Math.round(breadthTickers.filter(t => t.above).length / breadthTickers.length * 100),
    tickers:     breadthTickers,
  } : null;

  res.status(200).json({
    asOf:   new Date().toISOString(),
    macro:  { wti, us10y, dxy, vix, hy },
    growth: { ndx, semis },
    crypto: { btc },
    breadth,
  });
}
