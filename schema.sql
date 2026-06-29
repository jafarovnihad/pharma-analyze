-- rx-analyze test database.
-- `stock_view` mirrors the column shape of the company's view exactly.
-- When the company exposes the real view (or a web service), swap the data
-- source in src/datasource.js; nothing else changes.

DROP DATABASE IF EXISTS rx_analyze;
CREATE DATABASE rx_analyze CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE rx_analyze;

CREATE TABLE stock_view (
  party_numb        INT PRIMARY KEY,      -- batch id
  market_id         INT NOT NULL,
  store_id          INT NOT NULL,
  product_id        INT NOT NULL,
  exp_date_balance  INT NOT NULL,         -- qty on hand for this batch
  expire_date       DATE NULL,
  lead_time         INT NULL,             -- product-level (delivery next day = 1)
  sale_per_day      DECIMAL(6,2) NULL,    -- product-level velocity
  min_order         INT NULL              -- product-level min transfer/order qty
);

-- Demo data: 2 products across 3 stores. Lead time = 1 throughout (per the
-- supplier's next-day delivery). Product 1 has a near-expiry batch to exercise
-- the expiry logic; stores have differing sale rates to drive transfers.
INSERT INTO stock_view
(party_numb, market_id, store_id, product_id, exp_date_balance, expire_date, lead_time, sale_per_day, min_order) VALUES
-- Product 1
(1, 1, 1, 1, 40, '2027-01-01', 1, 11.0, 3),
(2, 1, 2, 1,  4, '2027-01-01', 1,  3.0, 3),
(3, 1, 3, 1, 70, DATE_ADD(CURDATE(), INTERVAL 4 DAY), 1, 4.0, 3),  -- near-expiry, slow store
-- Product 2
(4, 1, 1, 2, 50, '2028-09-07', 1,  2.0, 5),
(5, 1, 2, 2,  8, '2028-09-07', 1,  6.0, 5),
(6, 1, 3, 2, 12, '2030-01-01', 1,  3.0, 5);
