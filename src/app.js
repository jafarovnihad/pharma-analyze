require('dotenv').config();
const express = require('express');
const path = require('path');
const { analyzeRows } = require('./mapper');
const { fetchStockRows } = require('./datasource');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.get('/', (req, res) => {
  res.render('index', { report: null, days: 14, safetyDays: 0, error: null });
});

app.post('/analyze', async (req, res) => {
  const days = Math.max(1, parseInt(req.body.days, 10) || 14);
  const safetyDays = Math.max(0, parseInt(req.body.safetyDays, 10) || 0);
  try {
    const rows = await fetchStockRows({ windowDays: days });
    const report = analyzeRows(rows, { safetyDays });
    res.render('index', { report, days, safetyDays, error: null });
  } catch (err) {
    console.error(err);
    res.render('index', { report: null, days, safetyDays, error: err.message });
  }
});

app.get('/api/analyze', async (req, res) => {
  const days = Math.max(1, parseInt(req.query.days, 10) || 14);
  const safetyDays = Math.max(0, parseInt(req.query.safetyDays, 10) || 0);
  try {
    const rows = await fetchStockRows({ windowDays: days });
    res.json(analyzeRows(rows, { safetyDays }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`rx-analyze on :${PORT}`));
