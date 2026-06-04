// /api/risk-data  — Vercel serverless function (Node 18+)
//
// Haalt de macro/markt-knoppen op bij Stooq (gratis, geen key) en BTC bij CoinGecko.
// Geeft één JSON terug met huidige waardes + voortschrijdende gemiddelden (MA50/MA200).
// Elke knop faalt onafhankelijk naar null, zodat de barometer nooit volledig breekt.
//
// De zone-/scorelogica zit BEWUST in de frontend (index.html), zodat je drempels
// kunt tweaken zonder deze functie opnieuw te deployen.

const STOOQ_QUOTE = (s) =>
  `https://stooq.com/q/l/?s=${encodeURIComponent(s)}&f=sd2t2ohlcv&h&e=csv`;
const STOOQ_HIST = (s) =>
  `https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&i=d`;

const num = (x) => {
  const n = parseFloat(x);
  return Number.isFinite(n) ? n : null;
};
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

async function getText(url, ms = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (risk-barometer)" },
    });
    if (!r.ok) return null;
    return await r.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Laatste slotkoers via de "light quote" van Stooq.
async function stooqQuote(symbols) {
  for (const s of symbols) {
    const txt = await getText(STOOQ_QUOTE(s));
    if (!txt) continue;
    const lines = txt.trim().split("\n");
    if (lines.length < 2) continue;
    const cols = lines[1].split(",");
    // Symbol,Date,Time,Open,High,Low,Close,Volume
    const close = num(cols[6]);
    if (close !== null) return { value: close, symbol: s };
  }
  return null;
}

// Dagelijkse historie -> huidige slot + MA50 + MA200.
async function stooqTrend(symbols) {
  for (const s of symbols) {
    const txt = await getText(STOOQ_HIST(s));
    if (!txt) continue;
    const lines = txt.trim().split("\n");
    if (lines.length < 60) continue; // te weinig data
    const closes = [];
    for (let i = 1; i < lines.length; i++) {
      const c = num(lines[i].split(",")[4]); // Date,Open,High,Low,Close,Volume
      if (c !== null) closes.push(c);
    }
    if (closes.length < 60) continue;
    return {
      value: closes[closes.length - 1],
      ma50: mean(closes.slice(-50)),
      ma200: closes.length >= 200 ? mean(closes.slice(-200)) : mean(closes),
      symbol: s,
    };
  }
  return null;
}

// BTC via CoinGecko (gratis, CORS-vriendelijk, maar we doen het toch server-side).
async function btcTrend() {
  const url =
    "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=200&interval=daily";
  const txt = await getText(url, 9000);
  if (!txt) return null;
  try {
    const data = JSON.parse(txt);
    const closes = (data.prices || []).map((p) => p[1]).filter((x) => Number.isFinite(x));
    if (closes.length < 60) return null;
    return {
      value: closes[closes.length - 1],
      ma50: mean(closes.slice(-50)),
      ma200: mean(closes),
    };
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  // Edge-cache: 15 min vers, daarna max 1u stale terwijl ververst wordt -> ontziet Stooq.
  res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");

  // Kandidaat-tickers; eerste die geldige data geeft wint (robuust tegen ticker-afwijkingen).
  const BREADTH_BASKET = [
    "asml.us",
    "pltr.us",
    "s.us",
    "rbrk.us",
    "tln.us",
    "tsla.us",
    "crcl.us",
    "uuuu.us",
  ];

  const [wti, us10y, dxy, vix, hyg, ndx, semis, btc, ...basket] = await Promise.all([
    stooqQuote(["cl.f"]), // WTI olie
    stooqQuote(["10usy.b"]), // US 10-year yield (%)
    stooqQuote(["dx.f", "^dxy"]), // DXY dollar index
    stooqQuote(["^vix"]), // VIX
    stooqTrend(["hyg.us"]), // High-yield credit proxy (ETF-trend)
    stooqTrend(["^ndx"]), // Nasdaq 100
    stooqTrend(["smh.us", "^sox"]), // Semiconductors
    btcTrend(), // Bitcoin
    ...BREADTH_BASKET.map((s) => stooqTrend([s])),
  ]);

  // Marktbreedte: % van het mandje boven het 200d-gemiddelde.
  const breadthTickers = [];
  BREADTH_BASKET.forEach((sym, i) => {
    const t = basket[i];
    if (t && t.value != null && t.ma200 != null) {
      breadthTickers.push({ sym, value: t.value, ma200: t.ma200, above: t.value >= t.ma200 });
    }
  });
  const breadth =
    breadthTickers.length >= 3
      ? {
          count: breadthTickers.length,
          aboveCount: breadthTickers.filter((t) => t.above).length,
          pctAbove200: Math.round(
            (breadthTickers.filter((t) => t.above).length / breadthTickers.length) * 100
          ),
          tickers: breadthTickers,
        }
      : null;

  const payload = {
    asOf: new Date().toISOString(),
    macro: { wti, us10y, dxy, vix, hyg },
    growth: { ndx, semis },
    crypto: { btc },
    breadth,
  };

  res.status(200).json(payload);
}
