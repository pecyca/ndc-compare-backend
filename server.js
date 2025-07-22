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
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'orangebook_combined.sqlite');

let db;
(async () => {
  db = await open({ filename: dbPath, driver: sqlite3.Database });
  console.log('✅ SQLite DB connected');
})();

// === NDC Normalization ===
function stripLeadingZeros(segment) {
  return segment.replace(/^0+/, '');
}

function normalizeNdcToProductOnly(ndc) {
  const digits = ndc.replace(/\D/g, '').padStart(11, '0');
  const match = digits.match(/^(\d{5})(\d{4})(\d{2})$/);
  return match ? `${stripLeadingZeros(match[1])}-${stripLeadingZeros(match[2])}` : ndc;
}

function normalizeNdcToFull(ndc) {
  const digits = ndc.replace(/\D/g, '').padStart(11, '0');
  const match = digits.match(/^(\d{5})(\d{4})(\d{2})$/);
  return match ? `${stripLeadingZeros(match[1])}-${stripLeadingZeros(match[2])}-${stripLeadingZeros(match[3])}` : ndc;
}

// === RxNav Proxy ===
app.get('/proxy/rxnav/*', async (req, res) => {
  const subpath = req.params[0];
  const query = new URLSearchParams(req.query).toString();
  const url = `https://rxnav.nlm.nih.gov/REST/${subpath}?${query}`;
  try {
    const response = await fetch(url);
    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
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

// === Discontinued Status ===
app.get('/discontinued-status', async (req, res) => {
  const ndc = req.query.ndc;
  if (!ndc) return res.status(400).json({ error: 'Missing NDC' });
  const normalized = normalizeNdcToProductOnly(ndc);
  try {
    const row = await db.get(
      `SELECT Matched_ENDMARKETINGDATE FROM orangebook_combined WHERE Normalized_PRODUCTNDC = ?`,
      [normalized]
    );
    let discontinued = false;
    if (row?.Matched_ENDMARKETINGDATE && /^\d{8}$/.test(row.Matched_ENDMARKETINGDATE)) {
      const y = parseInt(row.Matched_ENDMARKETINGDATE.slice(0, 4));
      const m = parseInt(row.Matched_ENDMARKETINGDATE.slice(4, 6)) - 1;
      const d = parseInt(row.Matched_ENDMARKETINGDATE.slice(6, 8));
      const endDate = new Date(Date.UTC(y, m, d));
      discontinued = endDate < new Date();
    }
    res.json({ discontinued });
  } catch (err) {
    console.error('Discontinued error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// === Shortage Status ===
app.get('/shortage-status', async (req, res) => {
  const ndc = req.query.ndc;
  if (!ndc) return res.status(400).json({ error: 'Missing NDC' });
  const normalized = normalizeNdcToFull(ndc);
  try {
    const row = await db.get(
      `SELECT Reason_for_Shortage FROM shortages WHERE Normalized_PackageNDC = ?`,
      [normalized]
    );
    if (row) {
      res.json({ inShortage: true, reason: row.Reason_for_Shortage || null });
    } else {
      res.json({ inShortage: false });
    }
  } catch (err) {
    console.error('Shortage DB error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// === Orange Book Equivalence Summary ===
app.get('/equivalence', async (req, res) => {
  const ndc = req.query.ndc;
  if (!ndc) return res.status(400).json({ error: 'Missing NDC' });
  const normalized = normalizeNdcToProductOnly(ndc);
  try {
    const row = await db.get(
      `SELECT * FROM orangebook_combined WHERE Normalized_PRODUCTNDC = ?`,
      [normalized]
    );
    if (!row) {
      return res.status(404).json({ match: false, message: 'Unable to retrieve Orange Book data' });
    }
    const { Ingredient, Matched_ACTIVE_NUMERATOR_STRENGTH, Matched_DOSAGEFORMNAME, TE_Code } = row;
    res.json({
      match: true,
      ingredient: Ingredient || null,
      strength: Matched_ACTIVE_NUMERATOR_STRENGTH || null,
      form: Matched_DOSAGEFORMNAME || null,
      teCode: TE_Code || null,
      message: TE_Code ? `Matched with TE Code: ${TE_Code}` : 'Match found, but TE Code unavailable'
    });
  } catch (err) {
    console.error('Equivalence query error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// === Orange Book Full Record Query ===
app.get('/query', async (req, res) => {
  const ndc = req.query.ndc;
  if (!ndc) return res.status(400).json({ error: 'Missing NDC' });

  const normalized = normalizeNdcToProductOnly(ndc);

  try {
    const row = await db.get(
      `SELECT * FROM orangebook_combined WHERE Normalized_PRODUCTNDC = ?`,
      [normalized]
    );
    if (!row) {
      return res.status(404).json({ error: 'No Orange Book match found' });
    }
    res.json(row);
  } catch (err) {
    console.error('❌ Query route error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// === Health Check ===
app.get('/', (req, res) => {
  res.send('✅ Backend is live and running');
});

// === Start Server ===
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
