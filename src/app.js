require('dotenv').config();
const express = require('express');
const path = require('path');
const { analyzeRows, applyTransfers } = require('./mapper');
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
  res.render('index', { report: null, days: 14, safetyDays: 0, error: null, simulating: !!sandboxRows });
});

app.post('/analyze', async (req, res) => {
  const days = Math.max(1, parseInt(req.body.days, 10) || 14);
  const safetyDays = Math.max(0, parseInt(req.body.safetyDays, 10) || 0);
  try {
    const rows = await currentRows({ windowDays: days });
    const report = analyzeRows(rows, { safetyDays });
    res.render('index', { report, days, safetyDays, error: null, simulating: !!sandboxRows });
  } catch (err) {
    console.error(err);
    res.render('index', { report: null, days, safetyDays, error: err.message, simulating: !!sandboxRows });
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
    res.render('index', { report: after, days, safetyDays, error: null, simulating: true });
  } catch (err) {
    console.error(err);
    res.render('index', { report: null, days, safetyDays, error: err.message, simulating: !!sandboxRows });
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
    res.render('index', { report, days, safetyDays, error: null, simulating: false });
  } catch (err) {
    console.error(err);
    res.render('index', { report: null, days, safetyDays, error: err.message, simulating: false });
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
