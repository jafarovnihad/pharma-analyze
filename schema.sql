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

-- Demo data: 8 products across up to 3 stores, each product crafted to exercise
-- a different branch of the engine. Lead time = 1 throughout (next-day delivery).
-- Near-expiry / expired dates are RELATIVE to CURDATE() so they stay meaningful
-- whenever the schema is loaded; reload the schema if the demo dates drift past.
INSERT INTO stock_view
(party_numb, market_id, store_id, product_id, exp_date_balance, expire_date, lead_time, sale_per_day, min_order) VALUES

-- Product 1 — RESCUE + EXCHANGE showcase.
-- Slow Store 3 sits on a big near-expiry batch it can't sell in time; the pass
-- ships the unsellable excess to faster stores, and the balancer refills Store 3
-- with long-dated stock (apply the plan once, re-analyze to see the refill).
(1, 1, 1, 1, 40, '2027-01-01', 1, 11.0, 3),
(2, 1, 2, 1,  4, '2027-01-01', 1,  3.0, 3),
(3, 1, 3, 1, 70, DATE_ADD(CURDATE(), INTERVAL 4 DAY), 1, 4.0, 3),

-- Product 2 — mild rebalancing of long-dated stock across three stores.
(4, 1, 1, 2, 50, '2028-09-07', 1,  2.0, 5),
(5, 1, 2, 2,  8, '2028-09-07', 1,  6.0, 5),
(6, 1, 3, 2, 12, '2030-01-01', 1,  3.0, 5),

-- Product 3 — CHAIN-WIDE SCARCITY. Total cover is well under the reorder point,
-- so the report flags "Order now" and produces a per-store reorder plan.
(7, 1, 1, 3,  6, '2027-06-01', 1, 10.0, 4),
(8, 1, 2, 3,  5, '2027-06-01', 1,  9.0, 4),

-- Product 4 — VELOCITY-0 store. Store 3 cannot sell this product at all, so its
-- whole near-expiry holding is dead stock; the rescue pass moves all the fast
-- store can clear, and (zero weight) it converges with no back-flow.
(9,  1, 1, 4, 50, '2027-06-01', 1, 12.0, 3),
(10, 1, 3, 4, 60, DATE_ADD(CURDATE(), INTERVAL 5 DAY), 1, 0.0, 3),

-- Product 5 — ALREADY-EXPIRED batch at Store 2 -> "EXPIRED — remove" alert; the
-- balancer refills the now-effectively-empty store with long-dated stock.
(11, 1, 1, 5, 30, '2027-06-01', 1, 5.0, 3),
(12, 1, 2, 5, 20, DATE_SUB(CURDATE(), INTERVAL 2 DAY), 1, 5.0, 3),

-- Product 6 — perfectly balanced (equal cover). No transfers, no reorder, no
-- alerts: the "Stock healthy / No action needed" path.
(13, 1, 1, 6, 40, '2027-06-01', 1, 10.0, 3),
(14, 1, 2, 6, 20, '2027-06-01', 1,  5.0, 3),

-- Product 7 — one slow store's large near-expiry batch DISTRIBUTED across two
-- faster stores (neither can absorb it alone), capped at each store's capacity.
(15, 1, 1, 7, 32, '2027-06-01', 1, 8.0, 3),
(16, 1, 2, 7, 24, '2027-06-01', 1, 6.0, 3),
(17, 1, 3, 7, 90, DATE_ADD(CURDATE(), INTERVAL 6 DAY), 1, 3.0, 3),

-- Product 8 — near-expiry stock at a FAST store that can clear it itself: the
-- engine correctly leaves it put (no rescue), only nudging long-dated cover.
(18, 1, 1, 8, 30, DATE_ADD(CURDATE(), INTERVAL 5 DAY), 1, 10.0, 3),
(19, 1, 2, 8, 25, '2027-06-01', 1,  5.0, 3);
