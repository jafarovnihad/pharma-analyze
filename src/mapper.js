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

    const cleanMarkets = markets.map(({ _leadTime, _minOrder, ...m }) => m);
    const result = analyze({
      product: {
        id: productId,
        name: `Product ${productId}`,
        leadTimeDays,
        safetyDays,
        minTransferQty,
      },
      markets: cleanMarkets,
      today,
    });
    // Adapter-side enrichment (engine untouched): label each recommended
    // transfer with the expiry date(s) of the stock it actually ships, by
    // replaying the moves FEFO exactly as the app would execute them.
    labelExpiries(cleanMarkets, result.transfers, today);
    // Collapse any duplicate lines for the same route + same expiry into one.
    result.transfers = consolidateTransfers(result.transfers);
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

// FEFO order: earliest expiry first, no-expiry batches last (mirrors the engine
// and app.js execution order, so a labelled move maps to the units shipped).
const fefoCmp = (a, b) => {
  if (!a.expiryDate) return 1;
  if (!b.expiryDate) return -1;
  return new Date(a.expiryDate) - new Date(b.expiryDate);
};

// LEFO order: longest-dated first. The engine ships this way to a slower store
// (keep near-expiry stock at the faster store), so replays here must match.
const lefoCmp = (a, b) => {
  if (!a.expiryDate) return -1;
  if (!b.expiryDate) return 1;
  return new Date(b.expiryDate) - new Date(a.expiryDate);
};

// Same batch-draw order the engine uses: near-expiry first to a faster/equal
// store, longest-dated first to a slower one. `field` names the expiry property
// (engine batches use `expiryDate`, view rows use `expireDate`).
const shipOrder = (fromVel, toVel, items, field) => {
  const cmp = fromVel != null && toVel != null && toVel < fromVel ? lefoCmp : fefoCmp;
  const key = (x) => ({ expiryDate: x[field] });
  return [...items].sort((a, b) => cmp(key(a), key(b)));
};

const fmtDate = (d) => {
  if (!d) return null;
  const x = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(x.getDate())}.${p(x.getMonth() + 1)}.${x.getFullYear()}`;
};

// Sum the FEFO-consumed units per distinct expiry date (earliest first).
function mergeExpiries(taken) {
  const byKey = new Map();
  for (const t of taken) {
    const key = t.expiryDate ? new Date(t.expiryDate).toISOString().slice(0, 10) : 'none';
    const prev = byKey.get(key) || { expiryDate: t.expiryDate || null, qty: 0 };
    prev.qty += t.qty;
    byKey.set(key, prev);
  }
  return [...byKey.values()].sort(fefoCmp);
}

// "exp:03.07.26" for a single expiry; lists per-date qty when a move spans more
// than one batch; "exp:—" for non-expiring stock.
function formatExpiries(list) {
  if (!list.length) return '';
  if (list.length === 1) return `exp:${fmtDate(list[0].expiryDate) || '—'}`;
  return 'exp:' + list.map((e) => `${fmtDate(e.expiryDate) || '—'} (${e.qty})`).join(', ');
}

// Collapse transfers sharing the same route AND the same expiry into one line.
// The planner can emit a route across several rounds, and the rescue/refill
// passes may emit it again, so the raw trail can list e.g. "Store 3 -> Store 2"
// twice with the same date. Same route + same expiry means the same stock, so
// summing the quantities is safe and the report shows one tidy line. Routes that
// genuinely ship different expiries stay on separate lines (that detail matters).
function consolidateTransfers(transfers) {
  const byKey = new Map();
  const ordered = [];
  for (const t of transfers) {
    const key = `${t.fromMarketId}>${t.toMarketId}|${t.exp}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.qty += t.qty;
      existing.expiries = mergeExpiries([...(existing.expiries || []), ...(t.expiries || [])]);
      existing.exp = formatExpiries(existing.expiries);
    } else {
      const copy = { ...t, expiries: [...(t.expiries || [])] };
      byKey.set(key, copy);
      ordered.push(copy);
    }
  }
  return ordered;
}

// Replay the transfer list FEFO on a private copy of the engine's market state
// (real batches in FEFO order, plus a non-expiring remainder for any stock the
// batch rows don't itemize — matching the engine's own working copy) and tag
// each transfer with the expiry date(s) of the stock it ships. Mutates the
// transfer objects only; never touches stock or the engine.
function labelExpiries(markets, transfers) {
  const work = markets.map((m) => {
    const batches = m.batches.map((b) => ({ qty: b.qty, expiryDate: b.expiryDate })).sort(fefoCmp);
    const itemized = m.batches.reduce((s, b) => s + b.qty, 0);
    const remainder = m.stock - itemized;
    if (remainder > 0) batches.push({ qty: remainder, expiryDate: null });
    return { id: m.id, velocity: m.velocity, batches };
  });
  const byId = Object.fromEntries(work.map((w) => [w.id, w]));
  for (const t of transfers) {
    const from = byId[t.fromMarketId];
    const to = byId[t.toMarketId];
    let rem = t.qty;
    const taken = [];
    for (const b of shipOrder(from.velocity, to.velocity, from.batches, 'expiryDate')) {
      if (rem <= 0) break;
      if (b.qty <= 0) continue;
      const take = Math.min(b.qty, rem);
      b.qty -= take;
      rem -= take;
      taken.push({ expiryDate: b.expiryDate, qty: take });
      to.batches.push({ qty: take, expiryDate: b.expiryDate });
    }
    from.batches = from.batches.filter((b) => b.qty > 0);
    t.expiries = mergeExpiries(taken);
    t.exp = formatExpiries(t.expiries);
  }
  return transfers;
}

// ---- WHAT-IF SIMULATION HELPER (dev sandbox; not part of the company model) --
// Apply a whole report's recommended transfers to a copy of the view rows, FEFO,
// exactly as labelExpiries replays them: decrement source batches and append a
// new batch row at the destination per consumed source batch (expiry preserved).
// Pure — returns a new row array, never writes to any data source. Used only by
// the in-memory what-if sandbox in app.js; safe to delete with that feature.
function applyTransfers(rows, report) {
  const out = rows.map((r) => ({ ...r }));
  let nextParty = Math.max(0, ...out.map((r) => Number(r.partyNumb) || 0)) + 1;
  const vel = (storeId, productId) => {
    const r = out.find((x) => x.storeId === storeId && x.productId === productId);
    return r ? num(r.salePerDay) : null;
  };
  for (const p of report.products) {
    for (const t of p.transfers) {
      let rem = t.qty;
      const dst = out.find((r) => r.productId === p.productId && r.storeId === t.toMarketId);
      // Draw source batches in the same order the engine planned the move, so the
      // sandbox state matches the recommendation (near-expiry first to a faster
      // store, longest-dated first to a slower one).
      const src = shipOrder(
        vel(t.fromMarketId, p.productId), vel(t.toMarketId, p.productId),
        out.filter((r) => r.productId === p.productId && r.storeId === t.fromMarketId),
        'expireDate'
      );
      for (const r of src) {
        if (rem <= 0) break;
        const take = Math.min(num(r.expDateBalance), rem);
        if (take <= 0) continue;
        r.expDateBalance = num(r.expDateBalance) - take;
        rem -= take;
        out.push({
          partyNumb: nextParty++,
          marketId: dst ? dst.marketId : r.marketId,
          storeId: t.toMarketId,
          productId: p.productId,
          expDateBalance: take,
          expireDate: r.expireDate,
          leadTime: r.leadTime,
          salePerDay: dst ? dst.salePerDay : r.salePerDay,
          minOrder: r.minOrder,
        });
      }
    }
  }
  return out.filter((r) => num(r.expDateBalance) > 0);
}

module.exports = { analyzeRows, applyTransfers };
