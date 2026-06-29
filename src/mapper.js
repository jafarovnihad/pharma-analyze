/**
 * Maps flat company-view rows into the input shape analyze.js expects, and
 * runs the engine once per product. analyze.js is UNCHANGED — this is the only
 * adapter between the view's columns and the engine's {product, markets} shape.
 *
 * View row shape (one row per batch):
 *   { partyNumb, marketId, storeId, productId, expDateBalance, expireDate,
 *     leadTime, salePerDay, minOrder }
 *
 * Engine input per product:
 *   { product: { id, name, leadTimeDays, safetyDays, minTransferQty },
 *     markets: [{ id, name, priority, stock, velocity, batches:[{id,qty,expiryDate}] }],
 *     today }
 *
 * The engine has no safety column in the data, so safetyDays comes from opts.
 * The view has no store name or priority; we synthesize a name and default
 * priority to 2 (normal) — matching the design choice that priority only
 * matters when explicitly set.
 */
const { analyze } = require('./analyze');

const num = (v) => (v == null || v === '' ? 0 : Number(v));

function analyzeRows(rows, opts = {}) {
  const safetyDays = opts.safetyDays || 0;
  const today = opts.today ? new Date(opts.today) : new Date();

  // group rows: productId -> storeId -> market accumulator
  const byProduct = new Map();
  for (const r of rows) {
    const pid = r.productId;
    if (!byProduct.has(pid)) byProduct.set(pid, new Map());
    const stores = byProduct.get(pid);
    if (!stores.has(r.storeId)) {
      stores.set(r.storeId, {
        id: r.storeId,
        name: `Store ${r.storeId}`,
        priority: 2,
        velocity: num(r.salePerDay),
        stock: 0,
        batches: [],
        // product-level params, captured from rows that carry them
        _leadTime: num(r.leadTime),
        _minOrder: num(r.minOrder),
      });
    }
    const m = stores.get(r.storeId);
    const qty = num(r.expDateBalance);
    m.stock += qty;
    m.batches.push({
      id: r.partyNumb,
      qty,
      expiryDate: r.expireDate ? new Date(r.expireDate) : null,
    });
    // keep non-zero product params if this row has them and the first didn't
    if (!m.velocity && num(r.salePerDay)) m.velocity = num(r.salePerDay);
    if (!m._leadTime && num(r.leadTime)) m._leadTime = num(r.leadTime);
    if (!m._minOrder && num(r.minOrder)) m._minOrder = num(r.minOrder);
  }

  const products = [];
  for (const [productId, storeMap] of byProduct) {
    const markets = [...storeMap.values()];
    // product-level values: take from any store row that carries them
    const leadTimeDays = markets.find((m) => m._leadTime)?._leadTime ?? 0;
    const minTransferQty = markets.find((m) => m._minOrder)?._minOrder ?? 1;

    const result = analyze({
      product: {
        id: productId,
        name: `Product ${productId}`,
        leadTimeDays,
        safetyDays,
        minTransferQty,
      },
      markets: markets.map(({ _leadTime, _minOrder, ...m }) => m),
      today,
    });
    products.push({ productId, ...result });
  }

  return {
    generatedAt: startOfDayISO(today),
    safetyDays,
    products,
  };
}

const startOfDayISO = (d) => {
  const x = new Date(d);
  return new Date(x.getFullYear(), x.getMonth(), x.getDate()).toISOString().slice(0, 10);
};

module.exports = { analyzeRows };
