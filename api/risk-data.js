// /api/risk-data  — Vercel serverless function (Node 18+)
//
// Fixes vs v1:
//  • Geen encodeURIComponent op Stooq-symbolen — Stooq accepteert ^ niet als %5E
//  • closes.reverse() — Stooq history is nieuwste-eerst, was achterstevoren gelezen
//  • Beperkte datumrange in history-requests (420 handelsdagen) — kleiner, sneller
//  • Betere ticker-kandidatenlijsten per knop
//  • CRCL + RBRK uit breadth-mandje (< 200 handelsdagen beurshistorie)
//  • Optionele FRED-fallback voor VIX en 10Y yield (FRED_API_KEY env var, gratis)
//  • Realistischere browser User-Agent

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Stooq: ^ NIET encoden, Stooq herkent %5E niet
const STOOQ_QUOTE = (s) => `https://stooq.com/q/l/?s=${s}&f=sd2t2ohlcv&h&e=csv`;

// History: beperkt tot ~14 maanden (420 d) — genoeg voor MA200 + buffer
function stooqHistUrl(s) {
  const from = new Date();
  from.setDate(from.getDate() - 420);
  const d1 = from.toISOString().slice(0, 10).replace(/-/g, '');
  return `https://stooq.com/q/d/l/?s=${s}&d1=${d1}&i=d`;
}

const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };
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

// Huidige slotkoers via Stooq light-quote endpoint
async function stooqQuote(symbols) {
  for (const s of symbols) {
    const txt = await getText(STOOQ_QUOTE(s));
    if (!txt) continue;
    const lines = txt.trim().split('\n');
    if (lines.length < 2) continue;
    const cols = lines[1].split(',');
    // Symbol,Date,Time,Open,High,Low,Close,Volume  →  Close = index 6
    const close = num(cols[6]);
    if (close !== null) return { value: close, symbol: s };
  }
  return null;
}

// Historische data → huidige koers + MA50 + MA200
async function stooqTrend(symbols) {
  for (const s of symbols) {
    const txt = await getText(stooqHistUrl(s));
    if (!txt) continue;
    const lines = txt.trim().split('\n');
    if (lines.length < 60) continue;

    const closes = [];
    for (let i = 1; i < lines.length; i++) {
      const c = num(lines[i].split(',')[4]); // Date,Open,High,Low,Close,Volume
      if (c !== null) closes.push(c);
    }
    // BELANGRIJK: Stooq geeft nieuwste rij eerst — omkeren voor chronologische volgorde
    closes.reverse();

    if (closes.length < 60) continue;
    return {
      value:  closes[closes.length - 1],
      ma50:   mean(closes.slice(-50)),
      ma200:  closes.length >= 200 ? mean(closes.slice(-200)) : mean(closes),
      symbol: s,
    };
  }
  return null;
}

// FRED-fallback (gratis API-key, optioneel via env var FRED_API_KEY)
// Dekt: VIXCLS (VIX) en DGS10 (US 10Y yield) — 1 werkdag vertraging, heel betrouwbaar
async function fredLatest(series) {
  const key = process.env.FRED_API_KEY;
  if (!key) return null;
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${series}&api_key=${key}&sort_order=desc&limit=5&file_type=json`;
  const txt = await getText(url, 8000);
  if (!txt) return null;
  try {
    const d = JSON.parse(txt);
    // Neem meest recente observatie die geen punt is (FRED gebruikt '.' voor ontbrekende waarden)
    for (const obs of d.observations || []) {
      const v = parseFloat(obs.value);
      if (Number.isFinite(v)) return { value: v, symbol: `FRED:${series}` };
    }
  } catch { /* val */ }
  return null;
}

// BTC via CoinGecko: 200 dagelijkse prijspunten → MA50 + MA200
async function btcTrend() {
  const url = 'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=200&interval=daily';
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
  // Edge-cache: 15 min vers, tot 1 uur stale-while-revalidate → ontziet Stooq-servers
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');

  // Breadth-mandje: posities met voldoende beurshistorie (≥ 200 handelsdagen)
  // CRCL (apr 2025) en RBRK (apr 2024) verwijderd — te nieuw voor MA200
  const BREADTH = ['asml.us', 'pltr.us', 's.us', 'tln.us', 'tsla.us', 'uuuu.us'];

  // Alle fetches parallel — elke knop faalt onafhankelijk
  const [
    wtiRaw, us10yRaw, dxyRaw, vixRaw,
    hyg, ndx, semis, btc,
    ...basket
  ] = await Promise.all([
    stooqQuote(['cl.f']),                                 // WTI olie (front-month futures)
    stooqQuote(['10usy.b', '10ust.b', 'us10y.b']),       // US 10-year yield
    stooqQuote(['dx.f', '^dxy', 'dxy']),                  // DXY dollar index
    stooqQuote(['vix', '^vix', 'vxn']),                   // VIX (zonder ^ eerst)
    stooqTrend(['hyg.us', 'hyg']),                        // HY credit proxy (ETF-trend)
    stooqTrend(['ndx', '^ndx', 'ndx.us']),               // Nasdaq 100
    stooqTrend(['smh.us', 'smh', 'sox', '^sox']),         // Semiconductors
    btcTrend(),                                            // Bitcoin (CoinGecko)
    ...BREADTH.map(s => stooqTrend([s])),
  ]);

  // FRED-fallback voor VIX en 10Y als Stooq ze niet geeft
  const [us10y, vix] = await Promise.all([
    us10yRaw ?? fredLatest('DGS10'),
    vixRaw   ?? fredLatest('VIXCLS'),
  ]);

  // Marktbreedte: % van mandje boven 200d-gemiddelde
  const breadthTickers = [];
  BREADTH.forEach((sym, i) => {
    const t = basket[i];
    if (t?.value != null && t?.ma200 != null)
      breadthTickers.push({ sym, value: t.value, ma200: t.ma200, above: t.value >= t.ma200 });
  });
  const breadth = breadthTickers.length >= 3 ? {
    count:       breadthTickers.length,
    aboveCount:  breadthTickers.filter(t => t.above).length,
    pctAbove200: Math.round(breadthTickers.filter(t => t.above).length / breadthTickers.length * 100),
    tickers:     breadthTickers,
  } : null;

  res.status(200).json({
    asOf:   new Date().toISOString(),
    macro:  { wti: wtiRaw, us10y, dxy: dxyRaw, vix, hyg },
    growth: { ndx, semis },
    crypto: { btc },
    breadth,
  });
}
