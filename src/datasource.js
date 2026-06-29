/**
 * Data source. THIS IS THE SWAP POINT.
 *
 * Right now it reads from our own MySQL `stock_view` table (shaped exactly like
 * the company's view). Later, to use the company web service, replace the body
 * of fetchStockRows() with a fetch() call to their endpoint that returns the
 * same rows as JSON — nothing else in the app needs to change, because everyone
 * downstream just consumes the array of row objects this returns.
 *
 * Expected row shape (matches the company view columns):
 *   { partyNumb, marketId, storeId, productId, expDateBalance, expireDate,
 *     leadTime, salePerDay, minOrder }
 */
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'rx_analyze',
  ssl: process.env.DB_SSL === 'true' ? { minVersion: 'TLSv1.2' } : undefined,
  waitForConnections: true, connectionLimit: 10,
});

/**
 * @param {object} [filter] optional { windowDays } — reserved for when velocity
 *   is computed from a sales table instead of the view's salePerDay column.
 * @returns {Promise<Array>} array of row objects (see shape above)
 */
async function fetchStockRows() {
  const [rows] = await pool.query(
    `SELECT party_numb AS partyNumb, market_id AS marketId, store_id AS storeId,
            product_id AS productId, exp_date_balance AS expDateBalance,
            expire_date AS expireDate, lead_time AS leadTime,
            sale_per_day AS salePerDay, min_order AS minOrder
     FROM stock_view`
  );
  return rows;
}

// ---- WEB SERVICE VERSION (for later) -------------------------------------
// async function fetchStockRows() {
//   const res = await fetch(process.env.COMPANY_API_URL, {
//     headers: { Authorization: `Bearer ${process.env.COMPANY_API_KEY}` },
//   });
//   if (!res.ok) throw new Error(`Company API ${res.status}`);
//   return await res.json();   // must return the same row shape
// }
// --------------------------------------------------------------------------

module.exports = { fetchStockRows, pool };
