// Tests the mapper + the real engine together on view-shaped rows.
const assert = require('assert');
const { analyzeRows, applyTransfers } = require('../src/mapper');
const { planExpiryRescue } = require('../src/analyze');

const today = '2026-01-01';
const plusDays = (n) => {
  const d = new Date(today); d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
// Replay a transfer list onto view rows exactly as app.js would: take qty FEFO
// from the source store and append a new batch at the destination per consumed
// source batch (preserving expiry). Lets us re-run analyze on the applied state.
function applyToRows(rows, transfers) {
  rows = rows.map((r) => ({ ...r }));
  let nextParty = Math.max(0, ...rows.map((r) => r.partyNumb)) + 1;
  const exp = (r) => (r.expireDate ? new Date(r.expireDate).getTime() : 8.64e15);
  for (const t of transfers) {
    let rem = t.qty;
    const dst = rows.find((r) => r.storeId === t.toMarketId);
    const src = rows
      .filter((r) => r.storeId === t.fromMarketId)
      .sort((a, b) => exp(a) - exp(b));
    for (const r of src) {
      if (rem <= 0) break;
      const take = Math.min(r.expDateBalance, rem);
      r.expDateBalance -= take; rem -= take;
      rows.push({
        partyNumb: nextParty++, marketId: dst.marketId, storeId: t.toMarketId,
        productId: r.productId, expDateBalance: take, expireDate: r.expireDate,
        leadTime: r.leadTime, salePerDay: dst.salePerDay, minOrder: r.minOrder,
      });
    }
  }
  return rows.filter((r) => r.expDateBalance > 0);
}

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

// === Expiry-rescue pass ====================================================

// The Store 3 case: 70 pcs @ 4d expiry, velocity 4 (can only sell 16 there) sit
// idle while two faster, balanced stores have no deficit to pull them out. The
// rescue pass should ship the unsellable excess (70 - 16 = 54) toward the fast
// stores, capped at what each can actually sell in 4 days, and never instruct a
// store to ship more than it physically holds.
const near = plusDays(4);   // expires in 4 days
const longDate = '2027-01-01';
const rescueRows = [
  // S1: fast (11/day), holds 44 long-dated -> cover 4d, not short
  {partyNumb:1,marketId:1,storeId:1,productId:1,expDateBalance:44,expireDate:longDate,leadTime:1,salePerDay:11,minOrder:3},
  // S2: medium (5/day), holds 20 long-dated -> cover 4d, not short
  {partyNumb:2,marketId:1,storeId:2,productId:1,expDateBalance:20,expireDate:longDate,leadTime:1,salePerDay:5, minOrder:3},
  // S3: slow (4/day), holds 70 expiring in 4d -> only 16 sellable here, 54 dead
  {partyNumb:3,marketId:1,storeId:3,productId:1,expDateBalance:70,expireDate:near,    leadTime:1,salePerDay:4, minOrder:3},
];
const rrep = analyzeRows(rescueRows, { today, safetyDays:0 }).products[0];

const toS1 = rrep.transfers.find(t => t.from === 'Store 3' && t.to === 'Store 1');
assert(toS1, 'rescue should move S3 dead stock toward the fast store S1');
assert.strictEqual(toS1.qty, 44, `S1 capped at what it can sell in 4d (11*4=44), got ${toS1.qty}`);
// Remainder of the 54 excess cascades to the next store that can still sell it.
const toS2 = rrep.transfers.find(t => t.from === 'Store 3' && t.to === 'Store 2');
assert(toS2, 'remainder should be distributed to S2');
assert.strictEqual(toS2.qty, 10, `remainder 54-44=10 to S2 (cap 5*4=20), got ${toS2.qty}`);
// No store ships more than it physically holds, across the COMBINED plan.
const held = { 1:44, 2:20, 3:70 };
const shipped = {};
for (const t of rrep.transfers) shipped[t.fromMarketId] = (shipped[t.fromMarketId]||0) + t.qty;
for (const id of Object.keys(held)) {
  assert((shipped[id]||0) <= held[id], `store ${id} ships ${shipped[id]} > holds ${held[id]}`);
}
// Destinations are never sent more than they can sell before the expiry.
assert((shipped[3]||0) === 54, `S3 ships exactly its rescuable excess (54), got ${shipped[3]}`);

// Convergence: a store that cannot sell the product at all (velocity 0) holds
// 70 expiring in 4d — pure dead stock. Rescue ships what the fast store can
// clear; applying the full plan and re-running must yield no new non-trivial
// transfers. A velocity-0 store has zero weight, so the balance planner never
// treats it as a deficit and no back-flow is triggered.
const convRows = [
  {partyNumb:1,marketId:1,storeId:1,productId:1,expDateBalance:44,expireDate:longDate,leadTime:1,salePerDay:11,minOrder:3},
  {partyNumb:2,marketId:1,storeId:3,productId:1,expDateBalance:70,expireDate:near,    leadTime:1,salePerDay:0, minOrder:3},
];
const conv1 = analyzeRows(convRows, { today, safetyDays:0 }).products[0];
assert(conv1.transfers.some(t => t.from === 'Store 3' && t.to === 'Store 1' && t.qty === 44),
  'rescue should move 44 (11*4) from the velocity-0 store to the fast store');
const applied = applyToRows(convRows, conv1.transfers);
const conv2 = analyzeRows(applied, { today, safetyDays:0 }).products[0];
const minTransferQty = 3;
const nonTrivial = conv2.transfers.filter(t => t.qty >= minTransferQty);
assert.strictEqual(nonTrivial.length, 0,
  `re-run must produce no non-trivial transfers, got ${JSON.stringify(nonTrivial)}`);

// Control: no near-expiry stock. The rescue pass emits nothing and the normal
// balance output is unchanged (S1 surplus still ships to the S2 deficit).
const controlRows = [
  {partyNumb:1,marketId:1,storeId:1,productId:1,expDateBalance:40,expireDate:longDate,leadTime:1,salePerDay:11,minOrder:3},
  {partyNumb:2,marketId:1,storeId:2,productId:1,expDateBalance:4, expireDate:longDate,leadTime:1,salePerDay:3, minOrder:3},
];
const crep = analyzeRows(controlRows, { today, safetyDays:0 }).products[0];
assert(crep.transfers.length > 0 && crep.transfers.every(t => t.from === 'Store 1'),
  'control: normal balance transfer (S1 -> deficit) is unchanged');
// Direct check that the rescue pass itself contributes nothing with no near-expiry.
const daysToExpiry = (date) => Math.floor((new Date(date) - new Date(today)) / 86400000);
const emptyRescue = planExpiryRescue([
  {id:1,name:'Store 1',velocity:11,stock:40,batches:[{id:1,qty:40,expiryDate:longDate}]},
  {id:2,name:'Store 2',velocity:3, stock:4, batches:[{id:2,qty:4, expiryDate:longDate}]},
], { daysToExpiry, minTransferQty:3, balanceTransfers:[] });
assert.strictEqual(emptyRescue.length, 0, 'no near-expiry stock => rescue emits nothing');

// Combined balance + rescue must not over-fill a destination with near-expiry
// stock beyond what it can sell before that expiry. Store 2 (velocity 3) is in
// deficit, so the balance planner ships near-expiry stock there too; the rescue
// pass must count what balance already routed in and cap its own contribution,
// so after executing the plan S2 holds at most 3*4 = 12 near-expiry pcs (every
// piece sellable, none left to expire).
const overfillRows = [
  {partyNumb:1,marketId:1,storeId:1,productId:1,expDateBalance:40,expireDate:longDate,leadTime:1,salePerDay:11,minOrder:3},
  {partyNumb:2,marketId:1,storeId:2,productId:1,expDateBalance:4, expireDate:longDate,leadTime:1,salePerDay:3, minOrder:3},
  {partyNumb:3,marketId:1,storeId:3,productId:1,expDateBalance:70,expireDate:near,    leadTime:1,salePerDay:4, minOrder:3},
];
const ofReport = analyzeRows(overfillRows, { today, safetyDays:0 });
const ofApplied = applyTransfers(overfillRows, ofReport);
const nearAtS2 = ofApplied
  .filter(r => r.storeId === 2 && r.expireDate === near)
  .reduce((s, r) => s + r.expDateBalance, 0);
assert(nearAtS2 <= 12, `Store 2 must not be left holding more than 12 near-expiry pcs, got ${nearAtS2}`);
// And no store ships more than it physically holds in the executed plan.
const physical = { 1:40, 2:4, 3:70 };
const out = {};
for (const p of ofReport.products) for (const t of p.transfers) out[t.fromMarketId] = (out[t.fromMarketId]||0) + t.qty;
for (const id of Object.keys(physical)) {
  assert((out[id]||0) <= physical[id], `store ${id} ships ${out[id]} > holds ${physical[id]}`);
}

// A balancing transfer to a SLOWER-selling store must ship long-dated stock,
// not near-expiry stock. Store 1 (fast, v11) holds both long-dated and near-
// expiry stock; Store 3 (slow, v4) is short. The refill must draw from Store 1's
// long-dated batch so perishable stock stays where it can be sold in time.
const refillRows = [
  {partyNumb:1,marketId:1,storeId:1,productId:1,expDateBalance:37,expireDate:longDate,leadTime:1,salePerDay:11,minOrder:3},
  {partyNumb:2,marketId:1,storeId:1,productId:1,expDateBalance:44,expireDate:near,    leadTime:1,salePerDay:11,minOrder:3},
  {partyNumb:3,marketId:1,storeId:3,productId:1,expDateBalance:14,expireDate:near,    leadTime:1,salePerDay:4, minOrder:3},
];
const refRep = analyzeRows(refillRows, { today, safetyDays:0 }).products[0];
const refill = refRep.transfers.find(t => t.from === 'Store 1' && t.to === 'Store 3');
assert(refill, 'expected a refill transfer from fast Store 1 to slow Store 3');
const longLabel = `exp:${new Date(longDate).getDate().toString().padStart(2,'0')}.01.27`;
assert.strictEqual(refill.exp, longLabel,
  `refill to slow store must ship long-dated stock (${longLabel}), got ${refill.exp}`);
// And no near-expiry stock should be sent back to the slow store.
const ng = refill.expiries.some(e => e.expiryDate && new Date(e.expiryDate) - new Date(today) <= 30 * 86400000);
assert(!ng, 'refill must not include near-expiry stock');

// One-pass completeness: a SINGLE analyze() must emit the WHOLE plan for the
// slow-store-with-near-expiry case — the rescue out AND the long-dated refill
// back into the drained store — so one generated report contains everything,
// with no need to apply-then-re-analyze.
const onePassRows = [
  {partyNumb:1,marketId:1,storeId:1,productId:1,expDateBalance:40,expireDate:longDate,leadTime:1,salePerDay:11,minOrder:3},
  {partyNumb:2,marketId:1,storeId:2,productId:1,expDateBalance:4, expireDate:longDate,leadTime:1,salePerDay:3, minOrder:3},
  {partyNumb:3,marketId:1,storeId:3,productId:1,expDateBalance:70,expireDate:near,    leadTime:1,salePerDay:4, minOrder:3},
];
const opReport = analyzeRows(onePassRows, { today, safetyDays:0 });
const op = opReport.products[0];
const nd = new Date(near);
const nearLabel = `exp:${String(nd.getDate()).padStart(2,'0')}.${String(nd.getMonth()+1).padStart(2,'0')}.${String(nd.getFullYear()).slice(-2)}`;
// rescue: near-expiry leaves the slow store
assert(op.transfers.some(t => t.from === 'Store 3' && t.exp === nearLabel),
  'one-pass: rescue should ship Store 3 near-expiry stock out');
// refill: long-dated comes BACK into the slow store, in the SAME report
const refillBack = op.transfers.find(t => t.from === 'Store 1' && t.to === 'Store 3');
assert(refillBack, 'one-pass: the refill (Store 1 -> Store 3) must appear in the same report');
assert.strictEqual(refillBack.exp, 'exp:01.01.27',
  `one-pass refill must ship long-dated stock, got ${refillBack.exp}`);
// the single plan converges: apply it all, re-run, nothing non-trivial remains
const opAgain = analyzeRows(applyTransfers(onePassRows, opReport), { today, safetyDays:0 }).products[0];
assert.strictEqual(opAgain.transfers.filter(t => t.qty >= 3).length, 0,
  'one-pass plan must converge: re-run yields no non-trivial transfers');
// no route+expiry appears on more than one line (consolidated for the report)
const opKeys = op.transfers.map(t => `${t.fromMarketId}>${t.toMarketId}|${t.exp}`);
assert.strictEqual(new Set(opKeys).size, opKeys.length,
  'transfers must not list the same route+expiry on two separate lines');

console.log('✓ mapper + engine tests passed');
console.log('✓ expiry-rescue tests passed');
console.log('✓ destination over-fill guard test passed');
console.log('✓ refill-ships-long-dated test passed');
console.log('✓ one-pass complete-plan test passed');
