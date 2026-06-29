// Tests the mapper + the real engine together on view-shaped rows.
const assert = require('assert');
const { analyzeRows } = require('../src/mapper');

const today = '2026-01-01';

// Surplus store should ship to deficit store (engine's transfer planner).
const rows = [
  {partyNumb:1,marketId:1,storeId:1,productId:1,expDateBalance:40,expireDate:'2027-01-01',leadTime:1,salePerDay:11,minOrder:3},
  {partyNumb:2,marketId:1,storeId:2,productId:1,expDateBalance:4, expireDate:'2027-01-01',leadTime:1,salePerDay:3, minOrder:3},
];
const rep = analyzeRows(rows, { today, safetyDays:0 });
assert.strictEqual(rep.products.length, 1, 'one product');
const p = rep.products[0];
assert(p.transfers.length > 0, 'expected a transfer');
assert(p.transfers.every(t => t.from === 'Store 1'), 'only Store 1 has surplus');

// Near-expiry batch should reduce effective stock below raw (engine expiry math).
const t = new Date(today); const plus4 = new Date(t); plus4.setDate(plus4.getDate()+4);
const exp = plus4.toISOString().slice(0,10);
const rows2 = [
  {partyNumb:1,marketId:1,storeId:1,productId:9,expDateBalance:70,expireDate:exp,leadTime:1,salePerDay:4,minOrder:3},
];
const rep2 = analyzeRows(rows2, { today, safetyDays:0 });
const m = rep2.products[0].markets[0];
assert(m.effectiveStock < m.stock, `near-expiry: effective ${m.effectiveStock} should be < raw ${m.stock}`);
assert(m.effectiveStock === 16, `4/day x 4 days = 16 sellable, got ${m.effectiveStock}`);

console.log('✓ mapper + engine tests passed');
