/**
 * LOCAL MOCK API (dev tool — not part of the app).
 *
 * Serves the local MySQL `stock_view` rows as JSON, so you can test the app's
 * `DATA_SOURCE=api` fetch path against your OWN endpoint before the company API
 * exists. It returns exactly the row shape the company view is expected to
 * expose, so pointing the app at this or at the real company URL is the same.
 *
 * Run it alongside the app:
 *   node tools/mock-api.js            # or: npm run mock-api
 * Then in .env:
 *   DATA_SOURCE=api
 *   COMPANY_API_URL=http://localhost:8080/stock
 *
 * Reads the same DB_* env vars as the app. `dateStrings: true` keeps DATE
 * columns as plain "YYYY-MM-DD" so dates survive JSON round-trip without any
 * timezone shift.
 */
require('dotenv').config();
const http = require('http');
const mysql = require('mysql2/promise');

const PORT = Number(process.env.MOCK_API_PORT || 8080);

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'rx_analyze',
  ssl: process.env.DB_SSL === 'true' ? { minVersion: 'TLSv1.2' } : undefined,
  dateStrings: true,
  waitForConnections: true, connectionLimit: 10,
});

async function readRows() {
  const [rows] = await pool.query(
    `SELECT party_numb AS partyNumb, market_id AS marketId, store_id AS storeId,
            product_id AS productId, exp_date_balance AS expDateBalance,
            expire_date AS expireDate, lead_time AS leadTime,
            sale_per_day AS salePerDay, min_order AS minOrder
     FROM stock_view`
  );
  return rows;
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://localhost:${PORT}`);
  if (pathname !== '/stock') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Not found. Try GET /stock' }));
  }
  try {
    const rows = await readRows();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(rows));
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => console.log(`mock stock API on http://localhost:${PORT}/stock`));
