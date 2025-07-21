// server.js
import express from 'express';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'orangebook_combined.sqlite');

let db;

(async () => {
  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });
  console.log('✅ SQLite DB connected');
})();

// === /query ===
app.get('/query', async (req, res) => {
  const ndc = req.query.ndc?.replace(/[^0-9\-]/g, '');
  if (!ndc) return res.status(400).json({ error: 'Missing NDC' });

  try {
    const result = await db.get(
      `SELECT * FROM orangebook_combined WHERE matched_PRODUCTNDC = ?`,
      ndc
    );
    res.json({ result });
  } catch (err) {
    console.error('❌ /query error:', err);
    res.status(500).json({ error: 'Database query failed' });
  }
});

// === /api/drug-info ===
app.get('/api/drug-info', async (req, res) => {
  const ndc = req.query.ndc;
  if (!ndc) return res.status(400).json({ error: 'Missing NDC' });

  try {
    const response = await fetch(`https://api.fda.gov/drug/ndc.json?search=product_ndc:"${ndc}"`);
    const data = await response.json();
    res.json({ result: data.results?.[0] || null });
  } catch (err) {
    console.error('❌ /api/drug-info error:', err);
    res.status(500).json({ error: 'Failed to fetch drug info' });
  }
});

// === /api/discontinued-status ===
app.get('/api/discontinued-status', async (req, res) => {
  const ndc = req.query.ndc;
  if (!ndc) return res.status(400).json({ error: 'Missing NDC' });

  try {
    const result = await db.get(
      `SELECT Matched_ENDMARKETINGDATE FROM orangebook_combined WHERE matched_PRODUCTNDC = ?`,
      ndc
    );

    if (result?.Matched_ENDMARKETINGDATE) {
      const endDate = result.Matched_ENDMARKETINGDATE;
      const formatted = `${endDate.slice(0, 4)}-${endDate.slice(4, 6)}-${endDate.slice(6, 8)}`;
      const discontinued = new Date(formatted) < new Date();
      return res.json({ discontinued });
    }

    res.json({ discontinued: false });
  } catch (err) {
    console.error('❌ /api/discontinued-status error:', err);
    res.status(500).json({ error: 'Error checking discontinued status' });
  }
});

// === /api/shortage-status ===
app.get('/api/shortage-status', async (req, res) => {
  const ndc = req.query.ndc;
  if (!ndc) return res.status(400).json({ error: 'Missing NDC' });

  try {
    const response = await fetch(`https://api.fda.gov/drug/shortages.json?search=product_ndc:"${ndc}"`);
    const data = await response.json();
    const inShortage = data.results && data.results.length > 0;
    res.json({ inShortage });
  } catch (err) {
    console.error('❌ /api/shortage-status error:', err);
    res.status(500).json({ error: 'Error checking shortage status' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
