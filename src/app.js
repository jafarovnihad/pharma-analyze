require('dotenv').config();
const express = require('express');
const path = require('path');
const { analyzeRows, applyTransfers } = require('./mapper');
const { storesInReport, buildStoreExport } = require('./export');
const { fetchStockRows } = require('./datasource');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ---- WHAT-IF SIMULATION SANDBOX (dev only) --------------------------------
// CLAUDE.md keeps the report recommend-only and the company data source strictly
// read-only — and this respects that: the data source is NEVER written to. The
// "Apply" button just relocates stock in this in-memory copy of the rows so you
// can see how the next analysis looks. It is intentionally NOT persisted, so a
// program restart drops it and the original source data is shown again. To
// remove the feature entirely, delete `sandboxRows`, /execute, /reset, the
// applyTransfers import, and the buttons in the view — nothing else depends on it.
let sandboxRows = null; // null => read live from the (read-only) data source

async function currentRows(opts) {
  return sandboxRows ? sandboxRows : fetchStockRows(opts);
}

app.get('/', (req, res) => {
  res.render('index', { report: null, days: 14, safetyDays: 0, error: null, simulating: !!sandboxRows, stores: [] });
});

app.post('/analyze', async (req, res) => {
  const days = Math.max(1, parseInt(req.body.days, 10) || 14);
  const safetyDays = Math.max(0, parseInt(req.body.safetyDays, 10) || 0);
  try {
    const rows = await currentRows({ windowDays: days });
    const report = analyzeRows(rows, { safetyDays });
    res.render('index', { report, days, safetyDays, error: null, simulating: !!sandboxRows, stores: storesInReport(report) });
  } catch (err) {
    console.error(err);
    res.render('index', { report: null, days, safetyDays, error: err.message, simulating: !!sandboxRows, stores: [] });
  }
});

// Apply the current recommendations to the in-memory sandbox, then re-analyze so
// the user sees the resulting state (and any follow-up recommendations).
app.post('/execute', async (req, res) => {
  const days = Math.max(1, parseInt(req.body.days, 10) || 14);
  const safetyDays = Math.max(0, parseInt(req.body.safetyDays, 10) || 0);
  try {
    const rows = await currentRows({ windowDays: days });
    const report = analyzeRows(rows, { safetyDays });
    sandboxRows = applyTransfers(rows, report); // in-memory only; never written back
    const after = analyzeRows(sandboxRows, { safetyDays });
    res.render('index', { report: after, days, safetyDays, error: null, simulating: true, stores: storesInReport(after) });
  } catch (err) {
    console.error(err);
    res.render('index', { report: null, days, safetyDays, error: err.message, simulating: !!sandboxRows, stores: [] });
  }
});

// Drop the sandbox and return to the original source data.
app.post('/reset', async (req, res) => {
  const days = Math.max(1, parseInt(req.body.days, 10) || 14);
  const safetyDays = Math.max(0, parseInt(req.body.safetyDays, 10) || 0);
  sandboxRows = null;
  try {
    const rows = await currentRows({ windowDays: days });
    const report = analyzeRows(rows, { safetyDays });
    res.render('index', { report, days, safetyDays, error: null, simulating: false, stores: storesInReport(report) });
  } catch (err) {
    console.error(err);
    res.render('index', { report: null, days, safetyDays, error: err.message, simulating: false, stores: [] });
  }
});

// Per-store Excel export: download the transfers a given store should ship out.
// Re-runs the analysis (honouring the active sandbox, like the other routes) and
// streams an .xlsx. Read-only — nothing is written back.
app.get('/export', async (req, res) => {
  const days = Math.max(1, parseInt(req.query.days, 10) || 14);
  const safetyDays = Math.max(0, parseInt(req.query.safetyDays, 10) || 0);
  try {
    const rows = await currentRows({ windowDays: days });
    const report = analyzeRows(rows, { safetyDays });
    const store = storesInReport(report).find((s) => String(s.id) === String(req.query.store));
    if (!store) return res.status(400).send('Unknown or missing store.');
    const wb = await buildStoreExport(report, store);
    const safeName = String(store.name).replace(/[^A-Za-z0-9]+/g, '-');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="transfers-${safeName}-${report.generatedAt}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});

app.get('/api/analyze', async (req, res) => {
  const days = Math.max(1, parseInt(req.query.days, 10) || 14);
  const safetyDays = Math.max(0, parseInt(req.query.safetyDays, 10) || 0);
  try {
    const rows = await currentRows({ windowDays: days });
    res.json(analyzeRows(rows, { safetyDays }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`rx-analyze on :${PORT}`));
