/**
 * Per-store Excel export. Takes a finished report (from mapper.analyzeRows) and
 * one store, and builds a workbook listing what that store should SHIP OUT:
 * one row per product/destination/expiry, matching the sheet a store manager
 * expects — a Store/Date header block above a Product | Quantity | To Store |
 * Exp date table. Read-only: consumes the report, never touches stock or the
 * engine.
 */
const ExcelJS = require('exceljs');

// Distinct stores referenced anywhere in the report (id + display name),
// numeric-aware sorted so "Store 2" comes before "Store 10".
function storesInReport(report) {
  // The engine exposes each store's id as `marketId` on output markets, which
  // matches the `fromMarketId`/`toMarketId` carried on transfers.
  const map = new Map();
  for (const p of report.products) {
    for (const m of p.markets) {
      if (!map.has(m.marketId)) map.set(m.marketId, m.name);
    }
  }
  return [...map.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
}

// DD.MM.YYYY (matches the date format the managers' sheet uses).
const fmtDate = (d) => {
  if (!d) return '—';
  const x = new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(x.getDate())}.${p(x.getMonth() + 1)}.${x.getFullYear()}`;
};

// Flatten the report into the outgoing lines for one store: every recommended
// transfer whose source is this store, split per expiry date so each row is a
// single clean batch line (Product, Quantity, To Store, Exp date).
// Group this store's outgoing transfers by DESTINATION store: one section per
// "to" store, each holding the product lines (split per expiry) headed there.
// Sections come back numeric-aware sorted so "Store 2" precedes "Store 10".
function outgoingByDestination(report, storeId) {
  const groups = new Map(); // toMarketId -> { id, name, lines: [] }
  for (const p of report.products) {
    for (const t of p.transfers) {
      if (String(t.fromMarketId) !== String(storeId)) continue;
      const parts = t.expiries && t.expiries.length
        ? t.expiries
        : [{ expiryDate: null, qty: t.qty }];
      if (!groups.has(t.toMarketId)) groups.set(t.toMarketId, { id: t.toMarketId, name: t.to, lines: [] });
      const g = groups.get(t.toMarketId);
      for (const e of parts) g.lines.push({ product: p.product, qty: e.qty, exp: fmtDate(e.expiryDate) });
    }
  }
  return [...groups.values()]
    .sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
}

// Build an .xlsx workbook for one store. `store` is { id, name }. The sheet
// names the source store at the top, then lists one section per destination
// store ("To Store 2", "To Store 3", …), each with its Product/Quantity/Exp
// date lines.
async function buildStoreExport(report, store) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'rx-analyze';
  wb.created = new Date();
  const ws = wb.addWorksheet('Transfers');

  ws.columns = [
    { width: 26 }, // Product
    { width: 12 }, // Quantity
    { width: 14 }, // Exp date
  ];

  const thin = { style: 'thin', color: { argb: 'FFBFC9C2' } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };

  // Header block: which store this report belongs to, and the date.
  ws.getCell('A1').value = 'Store';
  ws.getCell('A1').font = { bold: true };
  ws.getCell('B1').value = store.name;
  ws.getCell('A2').value = 'Date';
  ws.getCell('A2').font = { bold: true };
  ws.getCell('B2').value = fmtDate(report.generatedAt);

  const groups = outgoingByDestination(report, store.id);
  let r = 4; // leave row 3 blank under the header block
  if (!groups.length) {
    ws.getCell(`A${r}`).value = 'Nothing to send.';
    return wb;
  }

  for (const g of groups) {
    // Destination heading, e.g. "To Store 2".
    ws.getCell(`A${r}`).value = `To ${g.name}`;
    ws.getCell(`A${r}`).font = { bold: true };
    r += 1;

    // Column header for this section.
    const head = ws.getRow(r);
    head.values = ['Product', 'Quantity', 'Exp date'];
    head.font = { bold: true };
    for (let c = 1; c <= 3; c++) head.getCell(c).border = border;
    r += 1;

    for (const l of g.lines) {
      const row = ws.getRow(r);
      row.values = [l.product, l.qty, l.exp];
      for (let c = 1; c <= 3; c++) row.getCell(c).border = border;
      row.getCell(2).alignment = { horizontal: 'right' };
      r += 1;
    }
    r += 1; // blank spacer before the next destination
  }

  return wb;
}

module.exports = { storesInReport, buildStoreExport };
