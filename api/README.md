# Risk Barometer (standalone)

Losstaande risicobarometer voor een high-beta portefeuille (Tesla / AI-Tech / Crypto / Energy / Software).
Pure markt-/macro-signalen — géén portfolio- of margin-data (die monitor je in je hoofd-dashboard).

## Structuur
```
risk-barometer/
├── index.html          # standalone pagina (vanilla JS, jouw dark/gold stijl)
└── api/
    └── risk-data.js     # Vercel serverless: haalt Stooq + CoinGecko op -> JSON
```

## Deployen op Vercel
1. Zet deze map als eigen repo (of submap) op GitHub.
2. New Project in Vercel → import de repo. **Zero-config**: Vercel detecteert `/api` automatisch als serverless function en serveert `index.html` als root. Geen build, geen framework, geen env-vars nodig.
3. Klaar. De pagina roept `/api/risk-data` aan; die functie haalt server-side de data op (geen CORS, geen API-keys).

Lokaal testen: `npx vercel dev`.

## De knoppen
| Knop | Bron | Logica |
|------|------|--------|
| WTI olie | Stooq `cl.f` | niveau: 90 / 100 / 110 |
| US 10Y yield | Stooq `10usy.b` | niveau: 4.4 / 4.75 / 5.0% |
| DXY | Stooq `dx.f` | niveau: 104 / 106 / 108 |
| VIX | Stooq `^vix` | niveau: 18 / 24 / 30 |
| Nasdaq 100 | Stooq `^ndx` | trend vs MA50/MA200 |
| Semiconductors | Stooq `smh.us` | trend vs MA50/MA200 |
| Bitcoin | CoinGecko | trend vs MA50/MA200 |
| Marktbreedte | mandje van je tickers | % boven 200d-MA |
| Credit (HY) | Stooq `hyg.us` | trend vs MA50/MA200 (proxy voor spreads) |

## Aanpassen
- **Drempels & gewichten**: bovenin het `<script>` in `index.html` (`levelZone`, `W`, `RISK`).
- **Tickers**: de kandidaatlijsten en `BREADTH_BASKET` in `api/risk-data.js`.
  Stooq-tickers kunnen afwijken; de functie probeert per knop meerdere kandidaten en
  valt netjes terug op "geen data" als niets lukt. Werkt een knop niet, check dan de
  juiste Stooq-ticker op stooq.com en pas de lijst aan.

## Let op
- Data is **end-of-day** (Stooq ververst 1x/dag, lichte vertraging). Prima voor een dagelijkse barometer.
- De edge-cache staat op 15 min; vaker verversen heeft binnen die tijd geen effect.
- Geen beleggingsadvies.
