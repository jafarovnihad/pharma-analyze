/**
 * Pure inventory-balancing logic. No DB access here — takes plain data in,
 * returns recommendations out. Easy to unit test.
 *
 * Expiry-aware & convergent transfer planning
 * -------------------------------------------
 * A batch's *effective* sellable stock is min(qty, velocity × daysToExpiry),
 * so the SAME batch is worth more at a faster-selling store. That makes a
 * naive transfer plan oscillate: FEFO execution physically relocates a
 * near-expiry batch, which changes effective stock everywhere, so each move
 * spawns a new imbalance and the recommendation never settles.
 *
 * The planner avoids this by SIMULATING its own execution to a fixed point.
 * Each round it plans moves (valuing every relocated batch at the DESTINATION
 * velocity), applies them to a private copy exactly as app.js would (FEFO, one
 * new batch per consumed source batch), then re-plans — stopping when a round
 * produces nothing. The emitted plan is the ordered trail of moves, so
 * executing it in order reproduces the settled state and a re-run is a no-op.
 *
 * Worked example: Slow store holds 70 pcs expiring in 4d (velocity 4 ⇒ only
 * 16 sellable there); moving them to a Fast store (velocity 20 ⇒ all 70
 * sellable in time) raises chain-wide effective stock, and the plan stops once
 * effective cover is proportional to velocity across stores.
 *
 * Input shape:
 * {
 *   product: { id, name, leadTimeDays, safetyDays, minTransferQty },
 *   markets: [
 *     {
 *       id, name, priority,            // priority: 1 low, 2 normal, 3 high
 *       stock,                          // total pcs on hand
 *       velocity,                       // avg pcs sold per day (rolling)
 *       batches: [{ id, qty, expiryDate }]  // expiryDate: Date or null
 *     }, ...
 *   ],
 *   today: Date (optional, defaults to now — pass it for deterministic tests)
 * }
 */

function analyze({ product, markets, today = new Date() }) {
  const { leadTimeDays, safetyDays, minTransferQty } = product;
  const reorderPointDays = leadTimeDays + safetyDays;
  const todayStart = startOfDay(today);
  const daysToExpiry = (date) =>
    Math.floor((startOfDay(new Date(date)) - todayStart) / 86400000);

  // --- effective sellable stock -------------------------------------------
  // A batch only counts for what the market can sell before it expires:
  // min(qty, velocity × daysToExpiry). Batches with no expiry count fully.
  // Computed as raw stock minus each expiring batch's unsellable excess so
  // markets whose batches don't itemize all stock still degrade sensibly.
  const effectiveByMarket = {};
  for (const m of markets) {
    let unsellable = 0;
    for (const b of m.batches) {
      if (!b.expiryDate) continue;
      const sellable = Math.max(0, m.velocity * daysToExpiry(b.expiryDate));
      unsellable += Math.max(0, b.qty - sellable);
    }
    effectiveByMarket[m.id] = Math.max(0, m.stock - unsellable);
  }

  const totalStock = markets.reduce((s, m) => s + m.stock, 0);
  const totalEffectiveStock = markets.reduce((s, m) => s + effectiveByMarket[m.id], 0);
  const totalVelocity = markets.reduce((s, m) => s + m.velocity, 0);
  const chainCoverDays = totalVelocity > 0 ? totalEffectiveStock / totalVelocity : Infinity;
  const scarcity = chainCoverDays < reorderPointDays;

  // --- per-market snapshot -----------------------------------------------
  const snapshot = markets.map((m) => ({
    marketId: m.id,
    name: m.name,
    stock: m.stock,
    effectiveStock: round1(effectiveByMarket[m.id]),
    velocity: m.velocity,
    coverDays: m.velocity > 0 ? round1(effectiveByMarket[m.id] / m.velocity) : null,
  }));

  // --- 1) Transfers: a convergent, batch-aware redistribution ------------
  // Effective sellable stock depends on WHERE a batch lives: it is
  // min(qty, velocity × daysToExpiry), and velocity differs per market. A
  // naive plan oscillates — FEFO execution relocates near-expiry batches,
  // which changes effective stock everywhere, so each executed move spawns a
  // fresh imbalance that never settles.
  //
  // We make the plan convergent by SIMULATING its own execution. Each round we
  // plan moves against the current state (batch-aware, valuing every relocated
  // batch at its DESTINATION velocity — a faster store clears more of it before
  // expiry), then apply those moves to a private copy exactly as app.js would
  // (FEFO, one new batch per consumed source batch), and re-plan. We stop when
  // a round produces nothing. The emitted plan is the ordered trail of moves;
  // executing it in order reproduces the settled state, so a re-run of
  // analyze() on the result suggests nothing further.
  const priorityWeight = { 1: 0.75, 2: 1.0, 3: 1.5 };
  const weights = {};
  for (const m of markets) {
    weights[m.id] = m.velocity * (scarcity ? (priorityWeight[m.priority] || 1) : 1);
  }
  const weightSum = markets.reduce((a, m) => a + weights[m.id], 0) || 1;

  // Working copy: real batches (FEFO order) plus an implicit non-expiring
  // remainder for any stock the batch rows don't itemize, so simulated
  // effective stock matches the snapshot exactly.
  const working = markets.map((m) => {
    const batches = fefoSort(m.batches.map((b) => ({ qty: b.qty, expiryDate: b.expiryDate })));
    const remainder = m.stock - m.batches.reduce((s, b) => s + b.qty, 0);
    if (remainder > 0) batches.push({ qty: remainder, expiryDate: null });
    return { id: m.id, name: m.name, velocity: m.velocity, batches };
  });

  const planCtx = { weights, weightSum, minTransferQty, daysToExpiry };
  const orderedMoves = [];
  const MAX_ROUNDS = 100;
  const MAX_OUTER = 50;

  // Outer loop: alternate the convergent balance planner with the expiry-rescue
  // pass until BOTH go quiet, applying every move to `working` as we go. This is
  // what makes a single analyze() emit the COMPLETE plan:
  //   - the planner equalizes effective days of cover;
  //   - rescue ships a slow store's unsellable near-expiry excess to faster
  //     stores, and applying it drains that store;
  //   - so the next planner round refills the drained store with long-dated
  //     stock (the back-flow / exchange).
  // Previously rescue ran once AFTER the planner, so the refill only surfaced on
  // a second analyze(); now it is all in one report and a re-run is a no-op.
  for (let outer = 0; outer < MAX_OUTER; outer++) {
    let changed = false;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const moves = planTransfers(working, planCtx);
      if (moves.length === 0) break; // balance settled for the current stock
      for (const mv of moves) {
        applyFefoMove(working, mv);
        orderedMoves.push(mv);
      }
      changed = true;
    }

    // Rescue operates on the CURRENT working state (so destination capacity and
    // source stock already reflect everything moved so far), and its moves are
    // applied back into `working` to feed the next planner round.
    const snapshot = working.map((s) => ({
      id: s.id, name: s.name, velocity: s.velocity,
      stock: s.batches.reduce((a, b) => a + b.qty, 0),
      batches: s.batches.map((b) => ({ qty: b.qty, expiryDate: b.expiryDate })),
    }));
    const postStateById = Object.fromEntries(snapshot.map((s) => [s.id, s]));
    const rescueMoves = planExpiryRescue(snapshot, { daysToExpiry, minTransferQty, postStateById });
    for (const mv of rescueMoves) {
      applyFefoMove(working, mv);
      orderedMoves.push(mv);
      changed = true;
    }

    if (!changed) break; // both passes quiet — fully settled
  }

  // Merge only adjacent same-route moves (safe under in-order FEFO execution);
  // a route that recurs after an intervening move stays separate so the
  // emitted order still replays correctly.
  const transfers = [];
  for (const mv of orderedMoves) {
    const last = transfers[transfers.length - 1];
    if (last && last.fromMarketId === mv.fromMarketId && last.toMarketId === mv.toMarketId) {
      last.qty += mv.qty;
    } else {
      transfers.push({ ...mv });
    }
  }

  const postEffectiveByMarket = Object.fromEntries(
    working.map((s) => [s.id, marketEffective(s, daysToExpiry)])
  );

  // --- 2) FEFO: batches that will expire before they sell ----------------
  // If a batch won't sell out at its current store before expiry, but the
  // chain's fastest-selling store could burn through it in time, flag it.
  const fefoAlerts = [];
  const fastest = [...markets].sort((a, b) => b.velocity - a.velocity)[0];

  for (const m of markets) {
    for (const b of m.batches) {
      if (!b.expiryDate) continue;
      const days = daysToExpiry(b.expiryDate);
      if (days <= 0) {
        fefoAlerts.push({
          marketId: m.id, market: m.name, batchId: b.id, qty: b.qty,
          daysToExpiry: days, action: 'EXPIRED — remove from stock',
        });
        continue;
      }
      const sellableHere = m.velocity * days;
      if (sellableHere < b.qty && fastest.id !== m.id) {
        const sellableAtFastest = fastest.velocity * days;
        fefoAlerts.push({
          marketId: m.id, market: m.name, batchId: b.id, qty: b.qty,
          daysToExpiry: days,
          action: sellableAtFastest >= b.qty
            ? `Move to ${fastest.name} (sells fast enough to clear it)`
            : `At risk everywhere — consider discounting (${b.qty} pcs, ${days}d left)`,
        });
      }
    }
  }

  // --- 3) Reorder decision ------------------------------------------------
  // Order when chain-wide cover < lead time + safety. Order size per market:
  // enough to reach (lead time + safety + one review cycle) days of cover
  // AFTER planned transfers are applied.
  const reorder = { orderNow: scarcity, perMarket: [] };
  if (scarcity) {
    const reviewCycleDays = 7; // how long one bulk order should last beyond the buffer
    const targetCover = reorderPointDays + reviewCycleDays;
    for (const m of markets) {
      const projected = postEffectiveByMarket[m.id];
      const qty = Math.max(0, Math.ceil(m.velocity * targetCover - projected));
      if (qty > 0) reorder.perMarket.push({ marketId: m.id, market: m.name, qty });
    }
  }

  return {
    product: product.name,
    chain: {
      totalStock,
      totalEffectiveStock: round1(totalEffectiveStock),
      totalVelocityPerDay: round1(totalVelocity),
      coverDays: round1(chainCoverDays),
      reorderPointDays,
      scarcity,
    },
    markets: snapshot,
    transfers,
    fefoAlerts,
    reorder,
  };
}

// A batch contributes only what its market can sell before it expires:
// min(qty, velocity × daysToExpiry). No expiry date ⇒ counts fully.
const contribution = (velocity, b, daysToExpiry) =>
  b.expiryDate ? Math.min(b.qty, Math.max(0, velocity * daysToExpiry(b.expiryDate))) : b.qty;

const marketEffective = (m, daysToExpiry) =>
  m.batches.reduce((sum, b) => sum + contribution(m.velocity, b, daysToExpiry), 0);

// FEFO order: earliest expiry first, no-expiry batches last — matches how
// app.js consumes stock, so a planned move maps to the units actually shipped.
function fefoSort(batches) {
  return [...batches].sort((a, b) => {
    if (!a.expiryDate) return 1;
    if (!b.expiryDate) return -1;
    return new Date(a.expiryDate) - new Date(b.expiryDate);
  });
}

// LEFO order: longest-dated first (no-expiry batches first, then latest expiry).
// Used when shipping to a SLOWER-selling store: long-dated stock is fungible
// (equally sellable anywhere over time), so move it first and leave near-expiry
// stock at the faster store that can actually clear it before it expires.
function lefoSort(batches) {
  return [...batches].sort((a, b) => {
    if (!a.expiryDate) return -1;
    if (!b.expiryDate) return 1;
    return new Date(b.expiryDate) - new Date(a.expiryDate);
  });
}

// Which batch a balancing move should draw down first. To a faster (or equal)
// store, near-expiry first (it clears there better — the rescue direction); to a
// slower store, longest-dated first (don't push perishable stock onto a store
// that can't sell it in time).
const shipOrder = (fromVel, toVel, batches) =>
  toVel < fromVel ? lefoSort(batches) : fefoSort(batches);

// One planning pass over a market state. Equalizes effective days of cover by
// moving whole pieces from surplus/dead stock to deficits, valuing each moved
// batch at the DESTINATION's velocity. Targets are recomputed from the running
// total each inner pass (relocating near-expiry stock to faster stores raises
// total effective stock). Returns net moves per route that clear minTransferQty.
// Pure: operates on a private copy, never mutates `working`.
function planTransfers(working, { weights, weightSum, minTransferQty, daysToExpiry }) {
  const sim = working.map((s) => ({
    id: s.id, name: s.name, velocity: s.velocity,
    batches: fefoSort(s.batches.map((b) => ({ qty: b.qty, expiryDate: b.expiryDate }))),
  }));
  const simById = Object.fromEntries(sim.map((s) => [s.id, s]));
  const eff = Object.fromEntries(sim.map((s) => [s.id, marketEffective(s, daysToExpiry)]));

  const moveQty = {}; // "fromId>toId" -> net pcs
  const MAX_PASSES = 1000;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const total = sim.reduce((a, s) => a + eff[s.id], 0);
    const target = {};
    for (const s of sim) target[s.id] = total * (weights[s.id] / weightSum);

    const deficits = sim
      .filter((s) => target[s.id] - eff[s.id] >= 1)
      .sort((a, b) => (eff[a.id] - target[a.id]) - (eff[b.id] - target[b.id]) || a.id - b.id);

    let movedUnits = 0;
    for (const d of deficits) {
      let need = target[d.id] - eff[d.id];
      if (need < 1) continue;
      const sources = sim
        .filter((s) => s.id !== d.id)
        .sort((a, b) => (eff[b.id] - target[b.id]) - (eff[a.id] - target[a.id]) || a.id - b.id);
      for (const s of sources) {
        for (const b of shipOrder(s.velocity, d.velocity, s.batches)) {
          if (need < 1) break;
          if (b.qty <= 0) continue;
          const days = b.expiryDate ? daysToExpiry(b.expiryDate) : Infinity;
          if (days <= 0) continue; // already expired — worthless anywhere
          const capS = s.velocity * days;   // sellable units of this batch at the source
          const capD = d.velocity * days;   // ...and at the destination (its higher velocity helps)
          const unsellableAtS = Math.max(0, b.qty - capS); // free to give — 0 effective at source
          const surplusS = Math.max(0, eff[s.id] - target[s.id]);
          // Move whole pieces, capped by: batch size, what the destination can
          // actually sell, what the source can spare (dead stock + surplus),
          // and what the deficit still needs.
          const k = Math.floor(Math.min(b.qty, capD, unsellableAtS + surplusS, need));
          if (k <= 0) continue;
          const effLossAtS = Math.max(0, k - unsellableAtS); // only sellable units cost the source
          b.qty -= k;
          eff[s.id] -= effLossAtS;
          eff[d.id] += k; // k <= capD, so every moved unit is sellable at the destination
          need -= k;
          movedUnits += k;
          const key = s.id + '>' + d.id;
          moveQty[key] = (moveQty[key] || 0) + k;
        }
      }
    }
    if (movedUnits === 0) break; // fixed point for this batch arrangement
  }

  return Object.entries(moveQty)
    .filter(([, qty]) => qty >= minTransferQty)
    .map(([key, qty]) => {
      const [fromId, toId] = key.split('>').map(Number);
      return {
        fromMarketId: fromId, from: simById[fromId].name,
        toMarketId: toId, to: simById[toId].name, qty,
      };
    })
    .sort((a, b) => b.qty - a.qty);
}

// Expiry-rescue planner (Stage 1: one direction only).
// -----------------------------------------------------
// Runs as its OWN pass, after the convergent balance planner, and returns moves
// in the same { fromMarketId, from, toMarketId, to, qty } shape. It exists to
// clear stock that will expire unsold at a slow store when the balance planner —
// which equalizes effective days of cover — has no deficit to pull it out: such
// stock counts ~0 toward cover, so moving it eases no deficit and the planner
// leaves it (raising only an fefoAlert). This pass relocates that dead stock to
// the store(s) that can genuinely sell it in time.
//
// Guarantees by construction (the guards a previous attempt violated):
//  - Rescues only the UNSELLABLE EXCESS of a batch at its own store:
//    excess = max(0, qty - velocity_source × daysToExpiry). Stock the source can
//    itself sell before expiry is never moved.
//  - CUMULATIVE destination cap: a destination may receive only as much near-
//    expiry stock as it can still sell before that expiry — velocity × days
//    MINUS what it already holds in that window MINUS all this pass has already
//    routed to it. Overflow cascades to the next-fastest store; what no store
//    can clear stays put (and remains an fefoAlert as before).
//  - SINGLE-HOP, no cross-docking: a store may ship only stock it PHYSICALLY
//    holds, never stock arriving from another move.
//  - No over-shipping: the source budget subtracts the balance plan's existing
//    shipments, so the COMBINED plan never ships more than a store holds.
//  - Respects minTransferQty.
//
// Pure: reads `markets`, mutates nothing. It does NOT touch effectiveStock,
// marketEffective, the contribution helper, planTransfers, or applyFefoMove.
//
// `postStateById` (optional) maps market id -> its POST-balance state (batches
// after the balance planner ran). When given, a destination's already-committed
// near-expiry load is read from it, so stock the balance plan routed to a store
// counts against what rescue may add — preventing the two passes from jointly
// over-filling a slow store past what it can clear before expiry. Falls back to
// the destination's current state when absent.
//
// Stage 2 — the reverse "exchange" that back-fills the drained slow store with
// long-dated stock so its cover re-balances — is deliberately NOT built here.
// That is the back-flow direction and is left as future work.
function planExpiryRescue(markets, { daysToExpiry, minTransferQty, balanceTransfers = [], postStateById = null }) {
  const byId = Object.fromEntries(markets.map((m) => [m.id, m]));

  // Physical-stock budget per source: what it holds minus what the balance plan
  // already ships from it. Rescue may only draw on this remainder.
  const committedOut = {};
  for (const m of markets) committedOut[m.id] = 0;
  for (const t of balanceTransfers) committedOut[t.fromMarketId] += t.qty;

  // Near-expiry units this pass has already routed INTO each destination.
  const assigned = {};
  for (const m of markets) assigned[m.id] = 0;

  // Candidate batches: those their own store cannot fully sell before expiry.
  // Earliest expiry first so the cumulative destination cap stays monotone — a
  // unit committed for a sooner expiry also occupies every longer window.
  const candidates = [];
  for (const m of markets) {
    for (const b of m.batches) {
      if (!b.expiryDate) continue;
      const d = daysToExpiry(b.expiryDate);
      if (d <= 0) continue; // already expired — worthless everywhere
      const excess = Math.max(0, b.qty - m.velocity * d);
      if (excess <= 0) continue;
      candidates.push({ srcId: m.id, d, excess });
    }
  }
  candidates.sort((a, b) => a.d - b.d || b.excess - a.excess || a.srcId - b.srcId);

  const routeQty = {}; // "fromId>toId" -> pcs
  for (const c of candidates) {
    let movable = Math.min(c.excess, byId[c.srcId].stock - committedOut[c.srcId]);
    if (movable <= 0) continue;
    // Fastest store first: it can absorb the most before the batch expires.
    const dests = markets
      .filter((x) => x.id !== c.srcId)
      .sort((a, b) => b.velocity - a.velocity || a.id - b.id);
    for (const dst of dests) {
      if (movable <= 0) break;
      const dstState = (postStateById && postStateById[dst.id]) || dst;
      const cap = dst.velocity * c.d - windowLoad(dstState, c.d, daysToExpiry) - assigned[dst.id];
      if (cap <= 0) continue;
      const k = Math.floor(Math.min(movable, cap));
      if (k <= 0) continue;
      const key = c.srcId + '>' + dst.id;
      routeQty[key] = (routeQty[key] || 0) + k;
      assigned[dst.id] += k;
      committedOut[c.srcId] += k; // budget against further rescue from this source
      movable -= k;
    }
  }

  return Object.entries(routeQty)
    .filter(([, qty]) => qty >= minTransferQty) // skip sub-minimum rescue moves
    .map(([key, qty]) => {
      const [fromId, toId] = key.split('>').map(Number);
      return {
        fromMarketId: fromId, from: byId[fromId].name,
        toMarketId: toId, to: byId[toId].name, qty,
      };
    })
    .sort((a, b) => b.qty - a.qty);
}

// How much of a destination's OWN current stock must sell within the next
// `d` days — i.e. competes with an incoming batch expiring in `d` days for the
// same selling capacity. Stock expiring after the window (or never) can be
// deferred past it, and FEFO sells the incoming near-expiry batch first anyway,
// so only stock expiring within the window counts. Capped at velocity × d.
function windowLoad(store, d, daysToExpiry) {
  let load = 0;
  for (const b of store.batches) {
    if (!b.expiryDate) continue;
    const bd = daysToExpiry(b.expiryDate);
    if (bd <= 0 || bd > d) continue;
    load += Math.min(b.qty, store.velocity * bd);
  }
  return Math.min(load, store.velocity * d);
}

// Apply a move to the working copy exactly as app.js executes it: draw qty from
// the source in the same order the planner chose it (near-expiry first to a
// faster store, longest-dated first to a slower one) and append one new batch at
// the destination per consumed source batch (preserving expiry). Mutates
// `working`. The ship order must match planTransfers so the emitted trail
// replays to the state the planner simulated.
function applyFefoMove(working, mv) {
  const from = working.find((m) => m.id === mv.fromMarketId);
  const to = working.find((m) => m.id === mv.toMarketId);
  let remaining = mv.qty;
  for (const b of shipOrder(from.velocity, to.velocity, from.batches)) {
    if (remaining <= 0) break;
    const take = Math.min(b.qty, remaining);
    b.qty -= take;
    remaining -= take;
    to.batches.push({ qty: take, expiryDate: b.expiryDate });
  }
  from.batches = from.batches.filter((b) => b.qty > 0);
}

const round1 = (n) => Math.round(n * 10) / 10;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

module.exports = { analyze, planExpiryRescue };
