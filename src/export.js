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
function outgoingLines(report, storeId) {
  const lines = [];
  for (const p of report.products) {
    for (const t of p.transfers) {
      if (String(t.fromMarketId) !== String(storeId)) continue;
      const parts = t.expiries && t.expiries.length
        ? t.expiries
        : [{ expiryDate: null, qty: t.qty }];
      for (const e of parts) {
        lines.push({ product: p.product, qty: e.qty, toStore: t.to, exp: fmtDate(e.expiryDate) });
      }
    }
  }
  return lines;
}

// Build an .xlsx workbook for one store. `store` is { id, name }.
async function buildStoreExport(report, store) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'rx-analyze';
  wb.created = new Date();
  const ws = wb.addWorksheet('Transfers');

  ws.columns = [
    { width: 26 }, // Product
    { width: 12 }, // Quantity
    { width: 16 }, // To Store
    { width: 14 }, // Exp date
  ];

  const labelFont = { bold: true };
  // Header block: Store / Date.
  ws.getCell('A1').value = 'Store';
  ws.getCell('A1').font = labelFont;
  ws.getCell('B1').value = store.name;
  ws.getCell('A2').value = 'Date';
  ws.getCell('A2').font = labelFont;
  ws.getCell('B2').value = fmtDate(report.generatedAt);

  // Table header on row 4 (row 3 left blank, like the managers' sheet).
  const headerRow = ws.getRow(4);
  headerRow.values = ['Product', 'Quantity', 'To Store', 'Exp date'];
  headerRow.font = { bold: true };

  const thin = { style: 'thin', color: { argb: 'FFBFC9C2' } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };
  for (let c = 1; c <= 4; c++) headerRow.getCell(c).border = border;

  const lines = outgoingLines(report, store.id);
  lines.forEach((l) => {
    const row = ws.addRow([l.product, l.qty, l.toStore, l.exp]);
    for (let c = 1; c <= 4; c++) row.getCell(c).border = border;
    row.getCell(2).alignment = { horizontal: 'right' };
  });

  return wb;
}

module.exports = { storesInReport, buildStoreExport };
