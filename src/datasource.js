/**
 * Data source. THIS IS THE SWAP POINT.
 *
 * fetchStockRows() returns an array of row objects (one per batch). Everything
 * downstream — mapper and engine — just consumes that array, so switching where
 * the rows come from is the only change needed here.
 *
 * Which source is used is chosen by DATA_SOURCE in .env:
 *   DATA_SOURCE=mysql  -> local test DB (the one managed via phpMyAdmin)
 *   DATA_SOURCE=api    -> company JSON web service (fetch)
 * Switching from local testing to the company API is a one-line .env change.
 *
 * Expected row shape (matches the company view columns):
 *   { partyNumb, marketId, storeId, productId, expDateBalance, expireDate,
 *     leadTime, salePerDay, minOrder }
 * Dates should arrive as ISO (e.g. "2027-06-01") so the mapper's new Date()
 * parses them; if the API sends another format, normalize it in the mapper.
 */
const mysql = require('mysql2/promise');

const SOURCE = (process.env.DATA_SOURCE || 'mysql').toLowerCase();

// ---- LOCAL TEST DB (MySQL) ------------------------------------------------
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'rx_analyze',
  ssl: process.env.DB_SSL === 'true' ? { minVersion: 'TLSv1.2' } : undefined,
  waitForConnections: true, connectionLimit: 10,
});

async function fetchFromMysql() {
  const [rows] = await pool.query(
    `SELECT party_numb AS partyNumb, market_id AS marketId, store_id AS storeId,
            product_id AS productId, exp_date_balance AS expDateBalance,
            expire_date AS expireDate, lead_time AS leadTime,
            sale_per_day AS salePerDay, min_order AS minOrder
     FROM stock_view`
  );
  return rows;
}

// ---- COMPANY API (JSON web service) ---------------------------------------
// Fetches the rows as JSON. Accepts either a bare array `[...]` or a wrapper
// `{ rows: [...] }`. Sends the analyze window as ?days= for when velocity is
// computed server-side. Uses global fetch (Node 18+).
async function fetchFromApi({ windowDays } = {}) {
  const base = process.env.COMPANY_API_URL;
  if (!base) throw new Error('COMPANY_API_URL is not set (DATA_SOURCE=api)');
  const url = new URL(base);
  if (windowDays) url.searchParams.set('days', windowDays);

  const headers = { Accept: 'application/json' };
  if (process.env.COMPANY_API_KEY) headers.Authorization = `Bearer ${process.env.COMPANY_API_KEY}`;

  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`Company API ${res.status} ${res.statusText}`);

  const data = await res.json();
  const rows = Array.isArray(data) ? data : data && data.rows;
  if (!Array.isArray(rows)) throw new Error('Company API did not return a rows array');
  return rows;
}

/**
 * @param {object} [filter] optional { windowDays } — passed to the API as ?days=,
 *   reserved for when velocity is computed from a sales table server-side.
 * @returns {Promise<Array>} array of row objects (see shape above)
 */
async function fetchStockRows(opts = {}) {
  return SOURCE === 'api' ? fetchFromApi(opts) : fetchFromMysql(opts);
}

module.exports = { fetchStockRows, pool };
