// server.js
import express from 'express';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import fetch from 'node-fetch'; // ✅ Only here, at top level
import { fileURLToPath } from 'url';

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'fda_merged_tecode.sqlite');

let db;
(async () => {
  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });
  console.log('✅ SQLite DB connected');
})();

// === Proxy RxNav ===
app.get('/proxy/rxnav/:endpoint', async (req, res) => {
  const endpoint = req.params.endpoint;
  const query = new URLSearchParams(req.query).toString();
  const url = `https://rxnav.nlm.nih.gov/REST/${endpoint}?${query}`;

  try {
    const response = await fetch(url);
    const contentType = response.headers.get('content-type');

    if (contentType && contentType.includes('application/json')) {
      const data = await response.json();
      res.json(data);
    } else {
      const text = await response.text();
      console.error('⚠️ RxNav response was not JSON:\n', text);
      res.status(502).send('RxNav did not return JSON');
    }
  } catch (err) {
    console.error('Proxy fetch error:', err.message);
    res.status(500).json({ error: 'RxNav proxy failed' });
  }
});

// === NDC Shortage Status ===
app.get('/shortage-status', async (req, res) => {
  const ndc = req.query.ndc;
  if (!ndc) return res.status(400).json({ error: 'Missing NDC' });

  try {
    const result = await db.get(
      `SELECT inShortage, reason FROM fda_shortages WHERE ndc = ?`,
      [ndc]
    );
    if (result) {
      res.json({
        inShortage: result.inShortage === 1,
        reason: result.reason || null
      });
    } else {
      res.status(404).json({ inShortage: false });
    }
  } catch (err) {
    console.error('Shortage DB error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// === NDC Discontinued Status ===
app.get('/discontinued-status', async (req, res) => {
  const ndc = req.query.ndc;
  if (!ndc) return res.status(400).json({ error: 'Missing NDC' });

  try {
    const result = await db.get(
      `SELECT discontinued FROM fda_discontinued WHERE ndc = ?`,
      [ndc]
    );
    res.json({ discontinued: !!result?.discontinued });
  } catch (err) {
    console.error('Discontinued DB error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// === Orange Book Query by NDC ===
app.get('/query', async (req, res) => {
  const ndc = req.query.ndc;
  if (!ndc) return res.status(400).json({ error: 'Missing NDC' });

  try {
    const result = await db.get(
      `SELECT * FROM orangebook WHERE PRODUCTNDC = ? OR PRODUCTNDC LIKE ?`,
      [ndc, `%${ndc.slice(-6)}`] // fallback for padded/unpadded NDC
    );

    if (result) {
      res.json(result);
    } else {
      res.status(404).json({ error: 'Not found' });
    }
  } catch (err) {
    console.error('Orange Book query error:', err.message);
    res.status(500).json({ error: 'Query failure' });
  }
});

// === Default health check ===
app.get('/', (req, res) => {
  res.send('✅ Backend is live and running');
});

// === Launch ===
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
