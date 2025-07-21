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
    const segments = ndc.split('-');
    if (segments.length !== 3) return res.status(400).json({ error: 'Invalid NDC format' });

    const labeler = segments[0].replace(/^0+/, '');
    const product = segments[1].replace(/^0+/, '');
    const packageCode = segments[2].replace(/^0+/, '');

    const query = `
      SELECT * FROM shortages
      WHERE
        REPLACE(Package_NDC_Code, '-', '') LIKE '%' || ? || '%' AND
        REPLACE(Package_NDC_Code, '-', '') LIKE '%' || ? || '%' AND
        REPLACE(Package_NDC_Code, '-', '') LIKE '%' || ? || '%'
      LIMIT 1
    `;

    const result = await db.get(query, [labeler, product, packageCode]);

    if (result) {
      res.json({
        inShortage: true,
        productName: result.Proprietary_Name || null,
        ndc: result.Package_NDC_Code || null,
        reason: result.Shortage_Reason || null
      });
    } else {
      res.json({ inShortage: false });
    }
  } catch (err) {
    console.error('❌ /api/shortage-status error:', err);
    res.status(500).json({ error: 'Error checking shortage status' });
  }
});

// ✅ === /proxy/rxnav/:endpoint(*) === (with /REST prefix)
app.get('/proxy/rxnav/:endpoint(*)', async (req, res) => {
  try {
    const search = req._parsedUrl.search || '';
    const endpoint = req.params.endpoint;
    const targetUrl = `https://rxnav.nlm.nih.gov/REST/${endpoint}${search}`;
    console.log(`🔁 Proxying RxNav call to: ${targetUrl}`);

    const response = await fetch(targetUrl);
    const contentType = response.headers.get('content-type');

    if (!contentType?.includes('application/json')) {
      return res.status(502).send({ error: 'Unexpected response from RxNav' });
    }

    const text = await response.text();
    res.set('Content-Type', 'application/json');
    res.send(text);
  } catch (error) {
    console.error('❌ RxNav Proxy Error:', error);
    res.status(500).json({ error: 'Proxy to RxNav failed' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
