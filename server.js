// server.js
import express from 'express';
import cors from 'cors';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
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

// ===== ROUTES =====

app.get('/shortage-status', async (req, res) => {
  const ndc = req.query.ndc;
  if (!ndc) return res.status(400).json({ error: 'Missing NDC' });

  try {
    const result = await db.get(`SELECT inShortage, reason FROM fda_shortages WHERE ndc = ?`, [ndc]);
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

app.get('/discontinued-status', async (req, res) => {
  const ndc = req.query.ndc;
  if (!ndc) return res.status(400).json({ error: 'Missing NDC' });

  try {
    const result = await db.get(`SELECT discontinued FROM fda_discontinued WHERE ndc = ?`, [ndc]);
    res.json({ discontinued: !!result?.discontinued });
  } catch (err) {
    console.error('Discontinued DB error:', err.message);
    res.status(500).json({ error: 'Internal error' });
  }
});

// Default route
app.get('/', (req, res) => {
  res.send('Backend is running');
});

// Launch
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
