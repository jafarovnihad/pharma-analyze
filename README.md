# rx-analyze

Read-only pharmacy stock analysis. A manager sets a window ("analyze last N
days") and clicks **Analyze**; the app reads current stock and returns a report
of recommended transfers, reorder quantities, and expiry risks across all
products. The app does not move stock — it produces recommendations the
pharmacist acts on through the company's existing ordering process.

## Run (local test DB)
```
mysql -u root < schema.sql       # creates rx_analyze + demo data
npm install
cp .env.example .env             # fill DB creds if needed
npm start                        # http://localhost:3000
```
`npm test` runs the engine logic without a database.

## Architecture
- `src/analyze.js` — the analysis ENGINE (expiry-aware, convergent transfer
  planner). Unchanged from the main project; works on one product at a time
  as `{ product, markets }`.
- `src/mapper.js` — adapts the flat view rows into the engine's per-product
  input shape and runs it for every product. This is the only glue between the
  view's columns and the engine.
- `src/datasource.js` — where the rows come from (see below).
- `src/app.js` — Analyze form + report.

## The data source — the one thing to change for the company system
Everything reads through `src/datasource.js → fetchStockRows()`, which returns
an array of row objects shaped like the company view:

  { partyNumb, marketId, storeId, productId, expDateBalance, expireDate,
    leadTime, salePerDay, minOrder }

Right now it SELECTs from our local `stock_view` table. To use the company's
data, change ONLY that function:
- If they give a DB view: point the query at their view.
- If they expose a web service: replace the body with a `fetch()` to their
  endpoint that returns the same rows as JSON (commented example is in the file).
Nothing else in the app changes — the engine and report consume the row array.

## Endpoints
- `GET /`            — the Analyze form
- `POST /analyze`    — runs analysis, renders the HTML report
- `GET /api/analyze?days=14&safetyDays=0` — same analysis as JSON

## Notes
- `lead_time` is read from the data (currently 1 everywhere = next-day
  delivery), not hardcoded, so it stays flexible.
- `days` is wired through to the data source for when velocity is computed from
  a sales table instead of the view's `salePerDay` column.
- `safetyDays` is a configurable reorder buffer (the view has no safety column).
