# Project: rx-analyze

Read-only pharmacy stock analysis tool. A manager sets a window ("analyze last
N days") and clicks **Analyze**; the app reads current stock from a company
data source and returns a report of recommended transfers, reorder quantities,
and expiry risks across all products. The app does NOT execute transfers or
move stock — it produces recommendations the pharmacist acts on through the
company's existing ordering process. (This was confirmed with the supervisor:
recommend-only, not an execution system.)

## Stack
Node.js, Express, EJS, MySQL via mysql2. No build step. Config via .env
(dotenv): DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME, PORT. Local test DB
is MySQL; `schema.sql` creates it with demo data.

## Architecture — three layers, kept separate on purpose
1. `src/analyze.js` — THE ENGINE. Expiry-aware effective-stock math and a
   convergent fixed-point transfer planner. Works on ONE product at a time as
   `{ product, markets, today }`.
2. `src/mapper.js` — adapts flat company-view rows into the engine's
   per-product `{ product, markets }` shape and runs the engine once per
   product. The ONLY glue between the view's columns and the engine.
3. `src/datasource.js` — `fetchStockRows()` returns the rows. THE SWAP POINT.
4. `src/app.js` — Analyze form (`/`, `POST /analyze`) + JSON (`GET /api/analyze`).

## CRITICAL RULE — do not modify the engine
`src/analyze.js` is a proven, tested engine carried over from a previous
project. DO NOT rewrite, refactor, or "improve" it. If the data shape doesn't
fit the engine, change `src/mapper.js` to adapt the data — never change the
engine to fit the data. The engine's input contract is:
  { product: { id, name, leadTimeDays, safetyDays, minTransferQty },
    markets: [{ id, name, priority, stock, velocity, batches:[{id,qty,expiryDate}] }],
    today }
The engine is pure (no DB, no requires beyond none; `today` injectable). Keep
it that way. If a genuine engine bug is found, raise it explicitly before
touching the file.

## The company data source (the integration plan)
The company will expose a database VIEW (and possibly a web service) with these
columns, one row per batch:
  partyNumb, marketId, storeId, productId, expDateBalance, expireDate,
  leadTime, salePerDay, minOrder
- expDateBalance = qty on hand for that batch
- leadTime is currently always 1 (next-day delivery) but kept as a column for
  flexibility — read it, never hardcode it
- salePerDay = velocity, given by the view (BUT see open question below)
To switch from the local test table to the company source, change ONLY
`fetchStockRows()` in datasource.js:
  - DB view: point the SELECT at their view
  - Web service: replace body with fetch() returning the same row JSON
    (commented example is in the file)
Nothing else changes — mapper and engine consume the row array.

## Mapper notes (where the view and engine differ)
- View has no store NAME → mapper synthesizes "Store N".
- View has no PRIORITY → mapper defaults every store to 2 (normal). The engine
  uses priority only under scarcity, by design. If the view later adds it, pass
  it through.
- View has no SAFETY-days column → comes from the Analyze form (safetyDays
  option), default 0.
- `days` (the window) is passed through to the data source, ready for when
  velocity is computed from a sales table instead of the salePerDay column.

## Open questions (pending supervisor) — do not assume answers
- Is there a sales table to compute velocity over the N-day window, or is
  salePerDay a static column? (If a sales table: velocity = sales in window /
  window days, computed in the data source / mapper, NOT in the engine.)
- Confirm read-only (no writes back to the company DB). Assume read-only.
- Sell-by margin: how many days before printed expiry does stock stop being
  sellable? (Engine currently counts to the literal date.)
- Whether near-expiry batches are too close to expiry to be worth transferring,
  and whether transfers need a "must be received by" deadline.

## Conventions
- camelCase in JS/JSON, snake_case in SQL columns.
- Run `npm test` after changes (tests the mapper + engine together, no DB).
- Keep the report read-only; no action buttons, no stock mutation.
