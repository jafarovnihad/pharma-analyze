// Tests for the per-store Excel export and date handling. Like the engine
// tests: no DB, run via `npm test`. TZ is pinned east of UTC so the
// generatedAt regression (local midnight formatted via UTC = previous day)
// actually bites if it comes back; on platforms that ignore process.env.TZ
// the assertions still hold for the fixed code.
process.env.TZ = 'Asia/Baku'; // UTC+4 — set before anything touches Date

const assert = require('assert');
const ExcelJS = require('exceljs');
const { analyzeRows, fmtDate } = require('../src/mapper');
const { storesInReport, buildStoreExport } = require('../src/export');

const rows = [
  // Product 1: Store 1 overstocked -> ships to Stores 2 and 3.
  {partyNumb:1,marketId:1,storeId:1,productId:1,expDateBalance:90,expireDate:'2027-06-01',leadTime:1,salePerDay:12,minOrder:3},
  {partyNumb:2,marketId:1,storeId:2,productId:1,expDateBalance:5, expireDate:'2027-06-01',leadTime:1,salePerDay:5, minOrder:3},
  {partyNumb:3,marketId:1,storeId:3,productId:1,expDateBalance:4, expireDate:'2027-06-01',leadTime:1,salePerDay:4, minOrder:3},
  // Product 2: Store 1 -> Store 4.
  {partyNumb:4,marketId:1,storeId:1,productId:2,expDateBalance:80,expireDate:'2028-03-01',leadTime:1,salePerDay:10,minOrder:3},
  {partyNumb:5,marketId:1,storeId:4,productId:2,expDateBalance:3, expireDate:'2028-03-01',leadTime:1,salePerDay:6, minOrder:3},
];

(async () => {
  // generatedAt must be the LOCAL calendar date, even just after local
  // midnight in a UTC+ timezone (the toISOString regression showed yesterday).
  const justPastMidnight = new Date(2026, 6, 1, 0, 30); // July 1, 00:30 local
  const report = analyzeRows(rows, { safetyDays: 0, today: justPastMidnight });
  assert.strictEqual(report.generatedAt, '2026-07-01',
    `generatedAt must be the local date, got ${report.generatedAt}`);

  // fmtDate: date-only ISO strings pass through without Date parsing.
  assert.strictEqual(fmtDate('2026-07-04'), '04.07.2026');
  assert.strictEqual(fmtDate(null), null);

  // storesInReport: every store, numeric-aware order, engine ids.
  const stores = storesInReport(report);
  assert.deepStrictEqual(stores.map((s) => s.name),
    ['Store 1', 'Store 2', 'Store 3', 'Store 4']);
  assert.strictEqual(stores[0].id, 1);

  // Store 1 export: source named at top, one section per destination,
  // each with its own Product/Quantity/Exp date lines.
  const wb = await buildStoreExport(report, stores[0]);
  const rb = new ExcelJS.Workbook();
  await rb.xlsx.load(await wb.xlsx.writeBuffer());
  const ws = rb.getWorksheet('Transfers');
  const sheet = [];
  ws.eachRow((row, n) => { sheet[n] = row.values.slice(1); });

  assert.deepStrictEqual(sheet[1], ['Store', 'Store 1']);
  assert.deepStrictEqual(sheet[2], ['Date', '01.07.2026']);
  const flat = sheet.filter(Boolean).map((r) => r.join('|'));
  for (const heading of ['To Store 2', 'To Store 3', 'To Store 4']) {
    assert(flat.includes(heading), `missing section heading "${heading}"`);
  }
  // Section headings appear in order, each followed by a column header row.
  const idx = (h) => flat.indexOf(h);
  assert(idx('To Store 2') < idx('To Store 3') && idx('To Store 3') < idx('To Store 4'),
    'destination sections must be in store order');
  // Data rows exist and every one carries a DD.MM.YYYY expiry.
  const dataRows = sheet.filter(Boolean).filter((r) => r.length === 3 && r[0] !== 'Product');
  assert(dataRows.length >= 3, `expected product lines under the sections, got ${dataRows.length}`);
  for (const r of dataRows) {
    assert(/^\d{2}\.\d{2}\.\d{4}$/.test(r[2]), `bad exp date format: ${r[2]}`);
  }

  // A store with nothing to ship gets an explicit empty sheet, not a crash.
  const store4 = stores.find((s) => s.name === 'Store 4');
  const wb4 = await buildStoreExport(report, store4);
  const rb4 = new ExcelJS.Workbook();
  await rb4.xlsx.load(await wb4.xlsx.writeBuffer());
  const cell = rb4.getWorksheet('Transfers').getCell('A4').value;
  assert.strictEqual(cell, 'Nothing to send.');

  console.log('✓ export + date-format tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
